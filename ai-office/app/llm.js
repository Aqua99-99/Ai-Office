// AI 두뇌: 내 컴퓨터의 Ollama(무료 오픈소스 모델)와 대화
'use strict';
const os = require('os');
const { run } = require('./util');

let OLLAMA = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
function setUrl(u) { if (u) OLLAMA = u.replace(/\/+$/, ''); }

// ---------- 컴퓨터 사양 확인 ----------
async function detectHardware() {
  const ramGB = Math.round(os.totalmem() / 1024 ** 3);
  const cpu = (os.cpus()[0] || {}).model || '알 수 없음';
  const cores = os.cpus().length;
  const gpus = [];
  // NVIDIA: 정확한 그래픽카드 메모리
  const nv = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 15000 });
  if (nv.code === 0) {
    for (const line of nv.out.trim().split(/\r?\n/)) {
      const [name, mem] = line.split(',').map(s => s.trim());
      if (name) gpus.push({ name, vramGB: Math.round((Number(mem) || 0) / 1024), vendor: 'nvidia' });
    }
  }
  // 그 밖의 그래픽카드 (Windows)
  if (!gpus.length && process.platform === 'win32') {
    const ps = await run('powershell', ['-NoProfile', '-Command',
      'Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + "|" + $_.AdapterRAM }'], { timeout: 20000 });
    if (ps.code === 0) {
      for (const line of ps.out.trim().split(/\r?\n/)) {
        const [name, ram] = line.split('|');
        if (!name || /basic display|remote/i.test(name)) continue;
        const vramGB = Math.round((Number(ram) || 0) / 1024 ** 3);
        const vendor = /nvidia/i.test(name) ? 'nvidia' : /amd|radeon/i.test(name) ? 'amd' : /intel/i.test(name) ? 'intel' : 'other';
        gpus.push({ name: name.trim(), vramGB, vendor });
      }
    }
  }
  return { ramGB, cpu, cores, gpus, os: `${os.type()} ${os.release()}` };
}

// 사양에 맞는 모델 고르기 (Ollama 모델 이름)
const TIERS = [
  { id: 'qwen2.5-coder:32b', label: '큰 모델 (실력 좋음)', needVram: 20, needRam: 48, sizeGB: 20 },
  { id: 'qwen2.5-coder:14b', label: '중간~큰 모델', needVram: 10, needRam: 24, sizeGB: 9 },
  { id: 'qwen2.5-coder:7b',  label: '중간 모델 (추천 기본)', needVram: 6, needRam: 12, sizeGB: 4.7 },
  { id: 'qwen2.5-coder:3b',  label: '작은 모델 (쉬운 일 위주)', needVram: 3, needRam: 8, sizeGB: 1.9 },
  { id: 'qwen2.5-coder:1.5b', label: '아주 작은 모델 (느린 컴퓨터용)', needVram: 0, needRam: 0, sizeGB: 1 },
];
function recommend(hw) {
  const dedicated = hw.gpus.filter(g => g.vendor === 'nvidia' || g.vendor === 'amd').map(g => g.vramGB);
  const vram = dedicated.length ? Math.max(...dedicated) : 0;
  for (const t of TIERS) {
    if (vram >= t.needVram && t.needVram > 0 && hw.ramGB >= Math.min(t.needRam, 16)) return { ...t, why: `그래픽카드 메모리 ${vram}GB에 맞춰 골랐어요.`, gpu: true };
  }
  // 그래픽카드가 없거나 작으면 컴퓨터 메모리(RAM) 기준, CPU로 돌아가서 느려요
  for (const t of TIERS) {
    if (t.needVram <= 6 && hw.ramGB >= t.needRam) return { ...t, why: `그래픽카드 없이 메모리 ${hw.ramGB}GB로 돌려요. 느릴 수 있어요.`, gpu: false };
  }
  return { ...TIERS[TIERS.length - 1], why: '사양이 낮아 가장 작은 모델을 골랐어요.', gpu: false };
}

// ---------- Ollama ----------
async function status() {
  try {
    const r = await fetch(OLLAMA + '/api/tags', { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return { running: false };
    const j = await r.json();
    return { running: true, models: (j.models || []).map(m => m.name) };
  } catch { return { running: false }; }
}

async function pull(model, onProgress) {
  const r = await fetch(OLLAMA + '/api/pull', { method: 'POST', body: JSON.stringify({ name: model, stream: true }) });
  if (!r.ok || !r.body) throw new Error('모델을 받지 못했어요 (' + r.status + ')');
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j.error) throw new Error(j.error);
        onProgress && onProgress({ status: j.status, pct: j.total ? Math.round((j.completed || 0) / j.total * 100) : null });
      } catch (e) { if (e.message && !/JSON/.test(e.message)) throw e; }
    }
  }
}

// 대화 한 번. json:true 이면 JSON만 돌려받아요.
// 작은 모델은 한 번 답하는 데 5분이 넘기도 해서, 기본 fetch(5분 제한) 대신 직접 연결하고
// 글자가 나오는 대로 받아요(스트리밍). 10분 동안 아무 글자도 안 나오면 그때 포기해요.
const http = require('http');
function chat(model, system, user, { json = false, temperature = 0.2, ctx = 8192, timeoutMs = 40 * 60e3, idleMs = 10 * 60e3, threads } = {}) {
  const body = {
    model, stream: true,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    options: { temperature, num_ctx: ctx, ...(threads ? { num_thread: threads } : {}) },
  };
  if (json) body.format = 'json';
  const u = new URL(OLLAMA + '/api/chat');
  return new Promise((resolve, reject) => {
    let text = '', buf = '', stats = { evalTokens: 0, seconds: 0 }, done = false, idle, total;
    const fail = e => { if (done) return; done = true; clearTimeout(idle); clearTimeout(total); try { req.destroy(); } catch {} reject(e); };
    const finish = () => {
      if (done) return; done = true; clearTimeout(idle); clearTimeout(total);
      text = text.trim();
      resolve(json ? { data: parseJSON(text), text, stats } : { text, stats });
    };
    const poke = () => { clearTimeout(idle); idle = setTimeout(() => fail(new Error('AI가 너무 오래 대답하지 않았어요')), idleMs); };
    total = setTimeout(() => fail(new Error('AI 대답 시간이 너무 길어 멈췄어요')), timeoutMs);
    const req = http.request({ hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      if (res.statusCode !== 200) {
        let e = ''; res.on('data', d => { e += d; }); res.on('end', () => fail(new Error(res.statusCode === 404 ? `모델 ${model}이 없어요. 설정에서 내려받아 주세요.` : 'AI 응답 오류 ' + res.statusCode + ': ' + e.slice(0, 200))));
        return;
      }
      res.setEncoding('utf8');
      res.on('data', chunk => {
        poke(); buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let j; try { j = JSON.parse(line); } catch { continue; }
          if (j.error) return fail(new Error('AI 오류: ' + String(j.error).slice(0, 200)));
          if (j.message && j.message.content) text += j.message.content;
          if (j.done) { stats = { evalTokens: j.eval_count || 0, seconds: (j.eval_duration || j.total_duration || 0) / 1e9 }; finish(); }
        }
      });
      res.on('end', finish);
      res.on('error', e => fail(new Error('AI와 연결이 끊겼어요: ' + e.message)));
    });
    req.on('error', e => fail(new Error(/ECONNREFUSED/.test(e.message) ? 'Ollama가 꺼져 있어요. Ollama를 켜 주세요.' : 'AI와 연결하지 못했어요: ' + e.message)));
    poke();
    req.end(JSON.stringify(body));
  });
}

// 작은 모델이 JSON을 조금 틀리게 줘도 최대한 읽어요
function parseJSON(t) {
  if (!t) return null;
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}

// 속도 측정: 짧은 답을 시켜서 초당 글자 수를 재요
async function speedTest(model) {
  const t0 = Date.now();
  const r = await chat(model, 'You are a helpful assistant.', 'Write three short sentences about saving money, in Korean.', { ctx: 2048 });
  const sec = (Date.now() - t0) / 1000;
  const tps = r.stats.evalTokens && r.stats.seconds ? r.stats.evalTokens / r.stats.seconds : null;
  return { seconds: Math.round(sec), tokensPerSec: tps ? Math.round(tps * 10) / 10 : null, sample: r.text.slice(0, 200) };
}

module.exports = { setUrl, detectHardware, recommend, TIERS, status, pull, chat, parseJSON, speedTest };
