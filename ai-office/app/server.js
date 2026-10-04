// AI 사무실 본체: 화면(브라우저), 받은편지함, 일정, 팀 실행
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { logLine, DIRS, readJSON, writeJSON, kst, safeJoin, cleanName, run, unzip, unwrapSingleFolder, copyDir, sleep } = require('./util');
const llm = require('./llm');
const onboard = require('./onboard');
const team = require('./team');
const brains = require('./brains');
const core = require('./core');

const PORT = Number(process.env.AIO_PORT) || 8787;
const HOST = '127.0.0.1';
const TOKEN = crypto.randomBytes(16).toString('hex');
const settings = Object.assign({ model: '', ollamaUrl: '' }, readJSON(DIRS.settings, {}));
llm.setUrl(settings.ollamaUrl);
const saveSettings = () => writeJSON(DIRS.settings, settings);

const office = core.createOffice();
const STAFF = core.STAFF;
let setupState = { pulling: '', pct: null, msg: '' };

// ---------- 프로젝트 (공통 기능은 core.js) ----------
const { projectList, defaultOrder, weeklyReport: weekly, isDue } = core;
function hasAnyBrain(st) { return core.localReady(settings, st) || core.cloudReady(settings); }
const weeklyReport = (project, order) => weekly(project, order, office);
const cleanupUnfinished = core.cleanupUnfinished;

// 받은편지함의 ZIP을 프로젝트로 등록
let intakeBusy = false;
let intakeState = null; // 화면에 보여 줄 진행 상황 {name, step, pct}
async function intake() {
  if (intakeBusy) return; intakeBusy = true;
  try {
    for (const zp of core.inboxZips()) {
      const canDescribe = hasAnyBrain(await llm.status());
      await core.registerZip(zp, { settings, office, canDescribe, onStep: s => { intakeState = s; } });
      intakeState = null;
    }
  } catch (e) {
    logLine('받은편지함 처리 중 오류', e);
  } finally { intakeBusy = false; intakeState = null; }
}

// ---------- 업무 줄 서기 + 일정 ----------
const queue = [];
let busy = false;
function enqueue(project, goal, reason) {
  if (queue.some(q => q.project === project) || (busy && office.project === project && office.running)) return false;
  queue.push({ project, goal: goal || '', reason }); pump(); return true;
}
async function pump() {
  if (busy || !queue.length) return;
  busy = true;
  const job = queue.shift();
  try {
    const pdir = path.join(DIRS.projects, job.project);
    const pst = readJSON(path.join(pdir, '상태.json'), {});
    const order = pst.order || defaultOrder();
    const st = await llm.status();
    const localOk = core.localReady(settings, st);
    if (pst.localOnly && !localOk) throw new Error('이 프로젝트는 "내 컴퓨터 AI만" 쓰는데, 내 컴퓨터 AI가 준비되지 않았어요. Ollama와 모델을 확인해 주세요.');
    if (!hasAnyBrain(st)) throw new Error('쓸 수 있는 AI 두뇌가 없어요. 설정에서 모델을 내려받거나 두뇌를 추가해 주세요.');
    const chat = brains.makeChat(settings, { localOnly: !!pst.localOnly });
    const r = await team.runJob({ project: job.project, chat, office, goal: job.goal, maxMinutes: Number(order.maxMinutes) || 60 });
    // 지시서 마지막 날이면 종합 보고서도 만들어요
    if (job.reason === 'schedule' && order.to && kst().date >= order.to) weeklyReport(job.project, order);
    logLine('업무 끝:', r.out);
  } catch (e) {
    logLine('업무 오류', e);
    office.log('pm', 'block', String(e.message || e).slice(0, 110));
    office.reset();
  } finally { busy = false; setTimeout(pump, 500); }
}
function scheduler() {
  const now = kst();
  for (const p of projectList()) {
    if (!isDue(p, now)) continue;
    const o = p.order;
    if (enqueue(p.name, o.goal, 'schedule')) office.log('pm', 'say', `${p.name}: 오늘 업무 시간이에요`);
  }
}

// ---------- 윈도우 시작할 때 자동 실행 ----------
function startupFile() { return path.join(process.env.APPDATA || os.homedir(), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'AI사무실.vbs'); }
function setAutostart(on) {
  const f = startupFile();
  if (!on) { try { fs.unlinkSync(f); } catch {} return false; }
  const q = s => s.replace(/"/g, '""');
  const vbs = `Set s = CreateObject("WScript.Shell")\r\ns.CurrentDirectory = "${q(DIRS.root)}"\r\ns.Run """${q(process.execPath)}"" ""${q(path.join(DIRS.root, 'app', 'server.js'))}"" --no-open", 0, False\r\n`;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, '\ufeff' + vbs, 'utf16le'); // 한글 경로도 안 깨지게
  return true;
}

function openFolder(p) {
  if (process.platform === 'win32') run('explorer', [p], { timeout: 10000 });
  else run('xdg-open', [p], { timeout: 10000 });
}

// ---------- HTTP ----------
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('너무 커요')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function projectDir(name) {
  const p = safeJoin(DIRS.projects, String(name || ''));
  if (!fs.existsSync(p) || path.dirname(p) !== path.resolve(DIRS.projects)) throw new Error('프로젝트를 찾을 수 없어요');
  return p;
}
const VALID = s => typeof s === 'string';

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(DIRS.ui, 'index.html'), 'utf8').replace('__AIO_TOKEN__', TOKEN);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
      return res.end(html);
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: '없는 주소' });
    // 다른 웹사이트가 몰래 이 프로그램을 조작하지 못하게 막아요
    if (req.method !== 'GET') {
      const origin = req.headers.origin || '';
      const okOrigin = !origin || origin === `http://${HOST}:${PORT}` || origin === `http://localhost:${PORT}`;
      if (!okOrigin || req.headers['x-aio-token'] !== TOKEN) return send(res, 403, { error: '허용되지 않은 요청' });
    }
    const parts = url.pathname.split('/').slice(2).map(decodeURIComponent);

    if (req.method === 'GET' && parts[0] === 'state') {
      const since = Number(url.searchParams.get('since')) || 0;
      return send(res, 200, {
        office: { running: office.running, project: office.project, mission: office.mission, startedAt: office.startedAt, endedAt: office.endedAt, reports: office.reports, staff: office.staffMap },
        logs: office.logs.filter(l => l.id > since).slice(-80), seq: office.seq,
        projects: projectList(), queue: queue.map(q => q.project), busy, model: settings.model, setup: setupState,
        autostart: fs.existsSync(startupFile()), inbox: DIRS.inbox, intake: intakeState, brainCount: brains.normalize(settings).filter(b => b.enabled).length, light: !!settings.light,
      });
    }
    if (req.method === 'GET' && parts[0] === 'setup') {
      const hw = await llm.detectHardware();
      const rec = llm.recommend(hw);
      return send(res, 200, { hw, rec, tiers: llm.TIERS, ollama: await llm.status(), model: settings.model, node: process.version });
    }
    if (req.method === 'POST' && parts[0] === 'setup' && parts[1] === 'model') {
      const b = JSON.parse((await readBody(req, 1e4)).toString() || '{}');
      if (!VALID(b.model) || !/^[\w.:/-]{2,80}$/.test(b.model)) return send(res, 400, { error: '모델 이름이 이상해요' });
      settings.model = b.model; saveSettings();
      const st = await llm.status();
      if (!st.running) return send(res, 200, { ok: true, note: 'Ollama가 꺼져 있어서 내려받기는 나중에 해요' });
      if (!st.models.some(m => m === b.model || m === b.model + ':latest')) {
        setupState = { pulling: b.model, pct: 0, msg: '내려받기 시작' };
        llm.pull(b.model, p => { setupState = { pulling: b.model, pct: p.pct, msg: p.status }; })
          .then(() => { setupState = { pulling: '', pct: null, msg: `${b.model} 준비 완료` }; office.log('pm', 'say', `AI 두뇌 ${b.model} 준비 완료!`); })
          .catch(e => { setupState = { pulling: '', pct: null, msg: '내려받기 실패: ' + e.message }; });
      }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && parts[0] === 'setup' && parts[1] === 'speed') {
      if (!settings.model) return send(res, 400, { error: '먼저 모델을 골라 주세요.' });
      if (setupState.pulling) return send(res, 409, { error: '아직 모델을 내려받는 중이에요. 다 받은 다음에 눌러 주세요.' });
      const st = await llm.status();
      if (!st.running) return send(res, 409, { error: 'Ollama가 꺼져 있어요. Ollama를 켜 주세요.' });
      if (!st.models.some(m => m === settings.model || m === settings.model + ':latest')) return send(res, 409, { error: '모델이 아직 없어요. "이 모델로 정하기"를 눌러 내려받아 주세요.' });
      try { return send(res, 200, await llm.speedTest(settings.model)); }
      catch (e) { logLine('속도 재기 실패', e); return send(res, 500, { error: '속도를 재지 못했어요. 잠시 뒤 다시 눌러 주세요.' }); }
    }
    if (req.method === 'GET' && parts[0] === 'brains') {
      const presets = Object.fromEntries(Object.entries(brains.PRESETS).map(([k, v]) => [k, { label: v.label, kind: v.kind, needKey: !!v.needKey, keyUrl: v.keyUrl || '', install: v.install || '', model: v.model || '', baseUrl: v.baseUrl || '' }]));
      return send(res, 200, { list: brains.publicList(settings), presets, light: !!settings.light });
    }
    if (req.method === 'POST' && parts[0] === 'brains' && parts[1] === 'save') {
      const b = JSON.parse((await readBody(req, 5e4)).toString() || '{}');
      const old = new Map(brains.normalize(settings).map(x => [x.id, x]));
      const next = [];
      for (const it of (Array.isArray(b.list) ? b.list : []).slice(0, 12)) {
        if (!it || !brains.PRESETS[it.preset]) continue;
        const prev = old.get(it.id);
        // 키 칸을 비워 두면 예전 키를 그대로 써요. '__clear__'면 지워요.
        const key = it.key === '__clear__' ? '' : (typeof it.key === 'string' && it.key.trim() ? it.key.trim() : (prev ? prev.key : ''));
        next.push({ id: it.id, preset: it.preset, enabled: it.enabled !== false, model: it.model, baseUrl: it.baseUrl, key });
      }
      settings.brains = next; settings.brains = brains.normalize(settings); saveSettings();
      return send(res, 200, { ok: true, list: brains.publicList(settings) });
    }
    if (req.method === 'POST' && parts[0] === 'brains' && parts[1] === 'test') {
      const b = JSON.parse((await readBody(req, 1e3)).toString() || '{}');
      try { return send(res, 200, await brains.test(settings, String(b.id || ''))); }
      catch (e) { return send(res, 200, { ok: false, error: String(e.message || e).slice(0, 200) }); }
    }
    if (req.method === 'POST' && parts[0] === 'light') {
      const b = JSON.parse((await readBody(req, 1e3)).toString() || '{}');
      settings.light = !!b.on; saveSettings();
      return send(res, 200, { on: settings.light });
    }
    if (req.method === 'POST' && parts[0] === 'quit') {
      logLine('퇴근 버튼으로 종료');
      send(res, 200, { ok: true, busy });
      setTimeout(() => process.exit(0), 400);
      return;
    }
    if (req.method === 'POST' && parts[0] === 'autostart') {
      const b = JSON.parse((await readBody(req, 1e3)).toString() || '{}');
      return send(res, 200, { on: setAutostart(!!b.on) });
    }
    if (req.method === 'POST' && parts[0] === 'upload') {
      const name = cleanName(url.searchParams.get('name') || 'project.zip') + '.zip';
      const buf = await readBody(req, 1024 ** 3);
      if (buf.length < 22 || buf[0] !== 0x50 || buf[1] !== 0x4b) return send(res, 400, { error: 'ZIP 파일이 아니에요' });
      fs.writeFileSync(path.join(DIRS.inbox, name), buf);
      intake();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && parts[0] === 'open') {
      const b = JSON.parse((await readBody(req, 1e4)).toString() || '{}');
      let target = DIRS.root;
      if (b.what === 'inbox') target = DIRS.inbox;
      else if (b.what === 'results') target = VALID(b.project) && b.project ? safeJoin(DIRS.results, b.project) : DIRS.results;
      else if (b.what === 'run' && VALID(b.project) && VALID(b.run)) target = safeJoin(DIRS.results, path.join(b.project, b.run));
      else if (b.what === 'project' && VALID(b.project)) target = projectDir(b.project);
      fs.mkdirSync(target, { recursive: true });
      openFolder(target);
      return send(res, 200, { ok: true });
    }
    if (parts[0] === 'project' && parts[1]) {
      const pdir = projectDir(parts[1]);
      const stPath = path.join(pdir, '상태.json');
      if (req.method === 'GET' && parts[2] === 'profile') return send(res, 200, { text: fs.readFileSync(path.join(pdir, '부서.md'), 'utf8') });
      if (req.method === 'GET' && parts[2] === 'report') {
        const runId = url.searchParams.get('run') || '';
        const f = safeJoin(DIRS.results, path.join(parts[1], runId, '보고서.md'));
        return send(res, 200, { text: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '보고서를 찾지 못했어요.' });
      }
      if (req.method === 'POST' && parts[2] === 'order') {
        const b = JSON.parse((await readBody(req, 2e4)).toString() || '{}');
        const date = s => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '');
        const order = {
          enabled: !!b.enabled,
          days: Array.isArray(b.days) ? [...new Set(b.days.map(Number).filter(d => d >= 0 && d <= 6))] : [1, 2, 3, 4, 5],
          time: typeof b.time === 'string' && /^\d{2}:\d{2}$/.test(b.time) ? b.time : '09:00',
          from: date(b.from), to: date(b.to),
          goal: typeof b.goal === 'string' ? b.goal.slice(0, 500) : '',
          maxMinutes: Math.min(600, Math.max(10, Number(b.maxMinutes) || 60)),
        };
        writeJSON(stPath, { ...readJSON(stPath, {}), order });
        office.log('pm', 'say', `${parts[1]} 업무 지시서를 받았어요`);
        return send(res, 200, { ok: true, order });
      }
      if (req.method === 'POST' && parts[2] === 'settings') {
        const b = JSON.parse((await readBody(req, 1e3)).toString() || '{}');
        const cur = readJSON(stPath, {});
        writeJSON(stPath, { ...cur, allowProjectTests: !!b.allowProjectTests, localOnly: b.localOnly === undefined ? !!cur.localOnly : !!b.localOnly });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && parts[2] === 'run') {
        const b = JSON.parse((await readBody(req, 1e4)).toString() || '{}');
        const ok = enqueue(parts[1], typeof b.goal === 'string' ? b.goal.slice(0, 500) : '', 'manual');
        return send(res, 200, { ok, queued: queue.map(q => q.project) });
      }
    }
    return send(res, 404, { error: '없는 기능' });
  } catch (e) {
    return send(res, 500, { error: String(e.message || e).slice(0, 200) });
  }
});

process.on('unhandledRejection', e => { logLine('처리 못 한 오류(계속 실행):', e); try { office.log('pm', 'block', '오류가 있었지만 계속 일해요 (기록.log 참고)'); } catch {} });
process.on('uncaughtException', e => { logLine('예상 못 한 오류(계속 실행):', e); try { office.log('pm', 'block', '오류가 있었지만 계속 일해요 (기록.log 참고)'); } catch {} });

server.on('error', async e => {
  if (e.code === 'EADDRINUSE') {
    console.log('AI 사무실이 이미 켜져 있어요. 화면을 열게요.');
    if (!process.argv.includes('--no-open') && process.platform === 'win32') await run('cmd', ['/c', 'start', '', `http://${HOST}:${PORT}`], { timeout: 10000 });
    process.exit(0);
  }
  console.error(e); process.exit(1);
});
server.listen(PORT, HOST, async () => {
  const url = `http://${HOST}:${PORT}`;
  console.log('================================================');
  console.log(' AI 사무실이 켜졌어요:', url);
  console.log(' 이 창을 닫으면 사무실도 퇴근해요.');
  console.log(' 받은편지함:', DIRS.inbox);
  console.log('================================================');
  if (!process.argv.includes('--no-open') && process.platform === 'win32') run('cmd', ['/c', 'start', '', url], { timeout: 10000 });
  logLine('AI 사무실 시작', url, 'Node', process.version);
  await cleanupUnfinished();
  intake();
  setInterval(intake, 20000);
  setInterval(scheduler, 30000);
  setTimeout(scheduler, 3000);
});

module.exports = { office, enqueue, intake };
