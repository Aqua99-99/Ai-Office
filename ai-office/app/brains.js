// 두뇌 목록: 여러 AI를 순서대로 쓰고, 한도가 차거나 오류가 나면 다음 두뇌로 넘어가요.
// 키는 쓰는 사람이 설정 화면에서 직접 넣고, 이 컴퓨터의 설정.json에만 저장돼요.
'use strict';
const os = require('os');
const { spawn } = require('child_process');
const llm = require('./llm');
const { logLine } = require('./util');

// 고를 수 있는 두뇌 종류 (모델 이름은 바뀔 수 있어서 설정에서 고칠 수 있어요)
const PRESETS = {
  gemini:     { kind: 'openai', label: 'Google Gemini (무료 등급 있음)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-flash-latest', needKey: true, local: false, keyUrl: 'https://aistudio.google.com/apikey' },
  openrouter: { kind: 'openai', label: 'OpenRouter (무료 모델 있음)', baseUrl: 'https://openrouter.ai/api/v1', model: 'openrouter/free', needKey: true, local: false, keyUrl: 'https://openrouter.ai/keys' },
  groq:       { kind: 'openai', label: 'Groq (무료 등급 있음, 빠름)', baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', needKey: true, local: false, keyUrl: 'https://console.groq.com/keys' },
  openai:     { kind: 'openai', label: 'OpenAI API (유료 키)', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needKey: true, local: false, keyUrl: 'https://platform.openai.com/api-keys' },
  anthropic:  { kind: 'anthropic', label: 'Claude API (유료 키)', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', needKey: true, local: false, keyUrl: 'https://console.anthropic.com/settings/keys' },
  custom:     { kind: 'openai', label: '직접 입력 (OpenAI 호환 주소)', baseUrl: 'http://127.0.0.1:1234/v1', model: '', needKey: false, local: false },
  'claude-code': { kind: 'cli', label: 'Claude 구독 (Claude Code 설치 필요)', cmd: 'claude', local: false, install: 'https://claude.com/claude-code' },
  codex:      { kind: 'cli', label: 'ChatGPT 구독 (Codex CLI 설치 필요)', cmd: 'codex', local: false, install: 'https://github.com/openai/codex' },
  'gemini-cli': { kind: 'cli', label: '구글 계정 (Gemini CLI 설치 필요)', cmd: 'gemini', local: false, install: 'https://github.com/google-gemini/gemini-cli' },
};

// 설정에 저장된 두뇌 목록 정리. 내 컴퓨터 Ollama는 항상 맨 끝의 든든한 대타예요.
function normalize(settings) {
  const list = Array.isArray(settings.brains) ? settings.brains : [];
  const out = [];
  for (const b of list.slice(0, 12)) {
    if (!b || typeof b !== 'object' || !PRESETS[b.preset]) continue;
    out.push({
      id: typeof b.id === 'string' && /^[\w-]{1,40}$/.test(b.id) ? b.id : b.preset + '-' + out.length,
      preset: b.preset, enabled: b.enabled !== false,
      model: typeof b.model === 'string' ? b.model.slice(0, 120) : (PRESETS[b.preset].model || ''),
      baseUrl: typeof b.baseUrl === 'string' && /^https?:\/\//.test(b.baseUrl) ? b.baseUrl.slice(0, 200) : (PRESETS[b.preset].baseUrl || ''),
      key: typeof b.key === 'string' ? b.key.slice(0, 400) : '',
    });
  }
  return out;
}
// 화면에 보여 줄 때는 키를 절대 내보내지 않아요
function publicList(settings) {
  return normalize(settings).map(b => ({ id: b.id, preset: b.preset, enabled: b.enabled, model: b.model, baseUrl: b.baseUrl, hasKey: !!b.key, label: PRESETS[b.preset].label, kind: PRESETS[b.preset].kind }));
}

// ---------- 종류별 호출 ----------
class BrainError extends Error { constructor(msg, { limit = false, auth = false } = {}) { super(msg); this.limit = limit; this.auth = auth; } }

async function callOpenAI(b, system, user, { json, timeoutMs = 10 * 60e3 }) {
  const headers = { 'Content-Type': 'application/json' };
  if (b.key) headers.Authorization = 'Bearer ' + b.key;
  if (b.preset === 'openrouter') { headers['HTTP-Referer'] = 'https://github.com/ai-office'; headers['X-Title'] = 'AI Office'; }
  const body = { model: b.model, temperature: 0.2, messages: [{ role: 'system', content: system + (json ? ' Reply with a single JSON object only.' : '') }, { role: 'user', content: user }] };
  let r;
  try { r = await fetch(b.baseUrl.replace(/\/+$/, '') + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { throw new BrainError('연결 실패: ' + (e.cause && e.cause.code || e.message)); }
  const t = await r.text();
  if (!r.ok) throw httpError(r.status, t);
  let j; try { j = JSON.parse(t); } catch { throw new BrainError('이상한 응답이 왔어요'); }
  const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  if (!text) throw new BrainError('빈 답이 왔어요');
  return text;
}
async function callAnthropic(b, system, user, { json, timeoutMs = 10 * 60e3 }) {
  let r;
  try {
    r = await fetch(b.baseUrl.replace(/\/+$/, '') + '/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'Content-Type': 'application/json', 'x-api-key': b.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: b.model, max_tokens: 4096, temperature: 0.2, system: system + (json ? ' Reply with a single JSON object only.' : ''), messages: [{ role: 'user', content: user }] }),
    });
  } catch (e) { throw new BrainError('연결 실패: ' + (e.cause && e.cause.code || e.message)); }
  const t = await r.text();
  if (!r.ok) throw httpError(r.status, t);
  const j = JSON.parse(t);
  return (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
}
function httpError(status, body) {
  const s = String(body || '').slice(0, 300);
  if (status === 429 || /quota|rate.?limit|exhausted|too many/i.test(s)) return new BrainError('오늘 무료 한도를 다 썼어요', { limit: true });
  if (status === 401 || status === 403) return new BrainError('키가 틀렸거나 권한이 없어요', { auth: true });
  if (status === 404) return new BrainError('모델 이름을 찾을 수 없어요. 설정에서 모델 이름을 확인해 주세요');
  if (status === 402) return new BrainError('잔액이 부족해요', { limit: true });
  return new BrainError(`오류 ${status}: ${s.slice(0, 120)}`);
}

// 구독형 명령줄 도구(Claude Code, Codex, Gemini CLI)에 일을 맡겨요. 내용은 입력창(stdin)으로 넘겨요.
function runCli(cmd, args, input, timeoutMs) {
  return new Promise(resolve => {
    const isWin = process.platform === 'win32';
    let child, out = '', err = '', done = false;
    try { child = spawn(isWin ? 'cmd' : cmd, isWin ? ['/c', cmd, ...args] : args, { windowsHide: true, cwd: os.tmpdir(), env: process.env }); }
    catch (e) { return resolve({ code: -1, out: '', err: e.message }); }
    const fin = code => { if (done) return; done = true; clearTimeout(t); resolve({ code, out, err }); };
    const t = setTimeout(() => { try { child.kill(); } catch {} err += '\n[시간 초과]'; fin(-2); }, timeoutMs);
    child.stdout.on('data', d => { out += d; if (out.length > 400000) out = out.slice(-200000); });
    child.stderr.on('data', d => { err += d; if (err.length > 100000) err = err.slice(-50000); });
    child.on('error', e => { err += e.message; fin(-1); });
    child.on('close', fin);
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
async function callCli(b, system, user, { json, timeoutMs = 15 * 60e3 }) {
  const p = PRESETS[b.preset];
  const prompt = `${system}${json ? '\nReply with a single JSON object only, no other text.' : ''}\n\n${user}`;
  // 도구가 파일을 고치지 못하게, 글로만 답하게 해요
  const args = b.preset === 'claude-code' ? ['-p', '--output-format', 'text', '--max-turns', '1', '--disallowedTools', 'Bash,Edit,Write,WebFetch,WebSearch']
    : b.preset === 'codex' ? ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '-']
    : ['-p', ' '];
  const r = await runCli(p.cmd, args, prompt, timeoutMs);
  const all = r.out + '\n' + r.err;
  if (r.code !== 0) {
    if (/not recognized|not found|ENOENT|내부 또는 외부 명령/i.test(all)) throw new BrainError(`${p.cmd} 프로그램이 설치되어 있지 않아요`, { auth: true });
    if (/limit|quota|usage|exhausted|429/i.test(all)) throw new BrainError('구독 사용량 한도에 걸렸어요', { limit: true });
    if (/log ?in|auth|credential|unauthori/i.test(all)) throw new BrainError(`${p.cmd}에 로그인이 필요해요`, { auth: true });
    throw new BrainError(`${p.cmd} 실행 오류: ${all.trim().slice(-150)}`);
  }
  const text = r.out.trim();
  if (!text) throw new BrainError('빈 답이 왔어요');
  return text;
}

// ---------- 사용 ----------
// 한도에 걸린 두뇌는 잠시 쉬게 해요 (한도: 다음 날까지 · 키 오류: 1시간 · 그 밖: 10분)
const cooldown = new Map();
function coolOf(err) { return err.limit ? 6 * 3600e3 : err.auth ? 3600e3 : 10 * 60e3; }

// 업무 하나에서 쓸 대화 함수를 만들어요. localOnly면 내 컴퓨터 AI만 써요.
function makeChat(settings, { localOnly = false, beforeLocal = null } = {}) {
  const usage = {}; // 두뇌별 사용 횟수 (보고서용)
  const cloud = localOnly ? [] : normalize(settings).filter(b => b.enabled);
  const threads = settings.light ? Math.max(2, Math.floor((os.cpus().length || 4) / 2)) : undefined;
  async function chat(system, user, opts = {}) {
    for (const b of cloud) {
      const until = cooldown.get(b.id) || 0;
      if (Date.now() < until) continue;
      const p = PRESETS[b.preset];
      const short = p.label.replace(/ \(.*\)$/, '');
      if (p.needKey && !b.key) continue;
      try {
        const text = p.kind === 'openai' ? await callOpenAI(b, system, user, opts)
          : p.kind === 'anthropic' ? await callAnthropic(b, system, user, opts)
          : await callCli(b, system, user, opts);
        usage[short] = (usage[short] || 0) + 1;
        return opts.json ? { data: llm.parseJSON(text), text, brain: short } : { text: text.trim(), brain: short };
      } catch (e) {
        cooldown.set(b.id, Date.now() + coolOf(e));
        logLine(`두뇌 넘김: ${p.label} → 다음 (${e.message})`);
        const k = `${short} (넘김: ${e.message.slice(0, 40)})`;
        usage[k] = (usage[k] || 0) + 1;
      }
    }
    // 마지막 대타: 내 컴퓨터 Ollama
    if (!settings.model) throw new Error('쓸 수 있는 두뇌가 없어요. 설정에서 모델을 고르거나 두뇌를 추가해 주세요.');
    if (beforeLocal) { await beforeLocal(); beforeLocal = null; } // GitHub 버전: 필요할 때만 작은 AI를 설치해요
    const r = await llm.chat(settings.model, system, user, { ...opts, threads });
    const label = '내 컴퓨터 AI (' + settings.model + ')';
    usage[label] = (usage[label] || 0) + 1;
    return { ...r, brain: label };
  }
  chat.usage = usage;
  return chat;
}

// 설정 화면의 "연결 시험"
async function test(settings, id) {
  const b = normalize(settings).find(x => x.id === id);
  if (!b) throw new Error('두뇌를 찾을 수 없어요');
  const p = PRESETS[b.preset];
  if (p.needKey && !b.key) throw new Error('키를 먼저 넣어 주세요');
  const t0 = Date.now();
  const sys = 'You are a helpful assistant.', user = 'Reply with exactly: 연결 성공';
  const text = p.kind === 'openai' ? await callOpenAI(b, sys, user, { timeoutMs: 120e3 })
    : p.kind === 'anthropic' ? await callAnthropic(b, sys, user, { timeoutMs: 120e3 })
    : await callCli(b, sys, user, { timeoutMs: 180e3 });
  cooldown.delete(b.id);
  return { ok: true, seconds: Math.round((Date.now() - t0) / 1000), reply: String(text).trim().slice(0, 80) };
}

module.exports = { PRESETS, normalize, publicList, makeChat, test };
