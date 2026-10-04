// GitHub 버전: GitHub가 정해진 시간에 이 파일을 실행해요. (컴퓨터가 꺼져 있어도 돼요)
// 하는 일: 업무 지시서(이슈) 받기 → 새 ZIP 등록 → 오늘 일할 프로젝트 실행 → 보고서·알림·결과물 준비
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { logLine, DIRS, readJSON, writeJSON, kst, run, hasCommand, sleep } = require('./util');
const llm = require('./llm');
const core = require('./core');
const brains = require('./brains');
const team = require('./team');

const ROOT = DIRS.root;
const NOTIFY = path.join(ROOT, '_알림');
const DOWNLOAD = path.join(ROOT, '_내려받기');
fs.mkdirSync(NOTIFY, { recursive: true });
fs.mkdirSync(DOWNLOAD, { recursive: true });

// ---------- 설정: 순서·모델은 클라우드설정.json, 키는 GitHub 비밀 금고(Secrets)에서 ----------
const KEY_ENV = { gemini: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY', groq: 'GROQ_API_KEY', openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY' };
// 키 모양으로 어느 회사 키인지 알아내요 (사이트의 키 칸과 같은 규칙)
function detectProvider(key) {
  if (/^AIza/.test(key)) return 'gemini';
  if (/^sk-or-/.test(key)) return 'openrouter';
  if (/^gsk_/.test(key)) return 'groq';
  if (/^sk-ant-/.test(key)) return 'anthropic';
  if (/^sk-/.test(key)) return 'openai';
  return '';
}
function loadSettings() {
  const c = readJSON(path.join(ROOT, '클라우드설정.json'), {});
  const models = c['모델'] || {};
  const list = [];
  // 1) 사이트의 키 칸으로 넣은 키: 비밀 금고 AIO_KEY_1 ~ AIO_KEY_5 (순서 = 칸 번호, 설정의 "두뇌" 목록이 있으면 그 순서)
  const slots = Array.isArray(c['두뇌']) && c['두뇌'].length ? c['두뇌'] : [1, 2, 3, 4, 5].map(n => ({ slot: n }));
  for (const b of slots) {
    const n = Number(b.slot);
    if (!(n >= 1 && n <= 5) || b.enabled === false) continue;
    const key = (process.env['AIO_KEY_' + n] || '').trim();
    if (!key) continue;
    const provider = brains.PRESETS[b.provider] ? b.provider : detectProvider(key);
    if (!provider || !brains.PRESETS[provider]) { logLine(`AIO_KEY_${n}: 어느 회사 키인지 몰라서 건너뛰어요`); continue; }
    list.push({ id: 'slot' + n, preset: provider, enabled: true, model: b.model || models[provider] || brains.PRESETS[provider].model, key, ...(b.baseUrl ? { baseUrl: b.baseUrl } : {}) });
  }
  // 2) 예전 방식 이름(GEMINI_API_KEY 등)으로 넣은 키도 써요
  const order = Array.isArray(c['두뇌순서']) ? c['두뇌순서'] : Object.keys(KEY_ENV);
  for (const p of order) {
    if (!KEY_ENV[p] || !brains.PRESETS[p]) continue;
    const key = (process.env[KEY_ENV[p]] || '').trim();
    if (!key || list.some(x => x.key === key)) continue;
    list.push({ id: p, preset: p, enabled: true, model: models[p] || brains.PRESETS[p].model, key });
  }
  return {
    brains: list,
    model: c['작은AI모델'] || 'qwen2.5-coder:3b',
    maxMinutes: Math.min(330, Math.max(10, Number(c['하루최대분']) || 120)),
    useSmallAI: c['작은AI쓰기'] !== false,
  };
}

// ---------- 현황판: 사이트가 읽어 가는 실시간 상태 (저장소의 '현황판' 이슈 본문에 적어요) ----------
const GH = { repo: process.env.GITHUB_REPOSITORY || '', token: process.env.GH_TOKEN || '', api: (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '') };
async function gh(method, url, body) {
  const r = await fetch(GH.api + url, { method, headers: { Authorization: 'Bearer ' + GH.token, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'ai-office' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 120)}`);
  return r.status === 204 ? null : r.json();
}
function makeBoard(office) {
  if (!GH.repo || !GH.token) return { start() {}, async flush() {} };
  let issue = null, dirty = true, timer = null, lastBody = '';
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${GH.repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : '';
  for (const k of ['log', 'staff', 'start', 'end', 'reset']) { const f = office[k].bind(office); office[k] = (...a) => { dirty = true; return f(...a); }; }
  async function find() {
    if (issue) return issue;
    try { await gh('POST', `/repos/${GH.repo}/labels`, { name: '현황판', color: '3f6fae', description: 'AI 사무실 실시간 상태' }); } catch {}
    const list = await gh('GET', `/repos/${GH.repo}/issues?labels=${encodeURIComponent('현황판')}&state=all&per_page=1`);
    issue = list && list[0] ? list[0].number : (await gh('POST', `/repos/${GH.repo}/issues`, { title: 'AI 사무실 현황판', body: '(자동으로 바뀌어요)', labels: ['현황판'] })).number;
    return issue;
  }
  async function flush(force) {
    if (!dirty && !force) return;
    dirty = false;
    const state = { updatedAt: Date.now(), running: office.running, project: office.project, mission: office.mission, startedAt: office.startedAt, endedAt: office.endedAt,
      reports: office.reports, staff: office.staffMap, logs: office.logs.slice(-40), runUrl };
    const body = '이 이슈는 AI 사무실 사이트가 읽는 현황판이에요. 지우지 마세요.\n\n<!-- AIO_STATUS -->\n```json\n' + JSON.stringify(state) + '\n```\n';
    if (body === lastBody) return;
    try { const n = await find(); await gh('PATCH', `/repos/${GH.repo}/issues/${n}`, { body, state: 'open' }); lastBody = body; }
    catch (e) { logLine('현황판 쓰기 실패(괜찮아요):', e.message); }
  }
  return { start() { timer = setInterval(() => flush(false), 12000); }, async flush() { clearInterval(timer); await flush(true); } };
}

// ---------- 작은 AI(Ollama)는 꼭 필요할 때만 GitHub 서버에 설치해요 ----------
async function ensureOllama(model) {
  let st = await llm.status();
  if (!st.running) {
    if (!(await hasCommand('ollama'))) {
      logLine('작은 AI(Ollama) 설치 중…');
      const r = await run('bash', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], { timeout: 15 * 60e3 });
      if (r.code !== 0) throw new Error('작은 AI 설치 실패: ' + r.out.slice(-200));
    }
    st = await llm.status();
    if (!st.running) {
      const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
      child.unref();
      for (let i = 0; i < 60 && !(st = await llm.status()).running; i++) await sleep(1000);
    }
    if (!st.running) throw new Error('작은 AI를 켜지 못했어요');
  }
  if (!st.models.some(m => m === model || m === model + ':latest')) {
    logLine('작은 AI 모델 내려받는 중:', model);
    let last = -10;
    await llm.pull(model, p => { if (p.pct != null && p.pct - last >= 20) { last = p.pct; logLine(`  모델 ${p.pct}%`); } });
  }
  logLine('작은 AI 준비 완료:', model);
}

// ---------- 업무 지시서 (이슈 양식) ----------
function field(body, label) {
  const re = new RegExp('###\\s*' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\\n]*\\n+([\\s\\S]*?)(?=\\n###\\s|$)');
  const m = String(body || '').match(re);
  if (!m) return '';
  const v = m[1].trim();
  return v === '_No response_' ? '' : v;
}
function applyIssueOrder() {
  const num = process.env.ISSUE_NUMBER;
  if (!num) return null;
  const assoc = process.env.ISSUE_AUTHOR_ASSOC || '';
  const reply = path.join(NOTIFY, '이슈답장.md');
  if (!['OWNER', 'MEMBER', 'COLLABORATOR'].includes(assoc)) {
    fs.writeFileSync(reply, '저장소 주인이나 협업자만 업무 지시서를 낼 수 있어요.\n', 'utf8');
    return null;
  }
  const body = process.env.ISSUE_BODY || '';
  const name = field(body, '프로젝트 이름');
  const projects = core.projectList();
  const p = projects.find(x => x.name === name) || projects.find(x => x.name.toLowerCase() === name.toLowerCase());
  if (!p) {
    fs.writeFileSync(reply, `'${name}' 프로젝트를 찾지 못했어요.\n\n지금 있는 프로젝트: ${projects.map(x => '`' + x.name + '`').join(', ') || '(없음 — 먼저 받은편지함에 ZIP을 올려 주세요)'}\n`, 'utf8');
    return null;
  }
  const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
  const daysTxt = field(body, '요일');
  const days = DAYS.map((d, i) => (new RegExp('-\\s*\\[[xX]\\]\\s*' + d)).test(daysTxt) ? i : -1).filter(i => i >= 0);
  const opts = field(body, '옵션');
  const date = s => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '');
  const t = kst();
  const order = {
    enabled: true,
    days: days.length ? days : [1, 2, 3, 4, 5],
    time: '09:00',
    from: date(field(body, '시작일')) || t.date,
    to: date(field(body, '마지막 날')) || kst(new Date(Date.now() + 4 * 864e5)).date,
    goal: field(body, '할 일').slice(0, 500),
    maxMinutes: Math.min(330, Math.max(10, Number(field(body, '하루 최대 시간')) || 60)),
  };
  const stPath = path.join(DIRS.projects, p.name, '상태.json');
  const localOnly = /-\s*\[[xX]\]\s*작은 AI만/.test(opts);
  const runNow = /-\s*\[[xX]\]\s*지금 바로/.test(opts);
  writeJSON(stPath, { ...readJSON(stPath, {}), order, localOnly });
  fs.writeFileSync(reply, [
    `**${p.name}** 업무 지시서를 받았어요. ✅`, '',
    `- 할 일: ${order.goal || '스스로 점검하고 고치기'}`,
    `- 기간: ${order.from} ~ ${order.to}`,
    `- 요일: ${order.days.map(d => DAYS[d]).join(', ')}`,
    `- 하루 최대: ${order.maxMinutes}분`,
    `- 두뇌: ${localOnly ? 'GitHub 서버의 작은 AI만' : '등록한 클라우드 AI → 작은 AI 순서'}`,
    runNow ? '- 지금 바로 한 번 일할게요.' : '- 정해진 날 아침에 일할게요.', '',
  ].join('\n'), 'utf8');
  return runNow ? p.name : null;
}

// ---------- 메인 ----------
async function main() {
  const t0 = Date.now();
  const settings = loadSettings();
  const office = core.createOffice();
  const board = makeBoard(office);
  board.start();
  try { await work(settings, office, t0); } finally { await board.flush(); }
}
async function work(settings, office, t0) {
  logLine(`AI 사무실 (GitHub) 시작 · 클라우드 두뇌 ${settings.brains.length}개 · 작은 AI ${settings.model}`);
  await core.cleanupUnfinished();

  const forced = new Map(); // 지금 바로 일할 프로젝트 → 할 일
  const fromIssue = applyIssueOrder();
  if (fromIssue) forced.set(fromIssue, null);
  if (process.env.AIO_PROJECT) forced.set(process.env.AIO_PROJECT.trim(), (process.env.AIO_GOAL || '').trim() || null);

  // 새 ZIP 등록 (소개는 클라우드 AI가 있을 때만 써요. 작은 AI 설치까지 하기엔 아까워요)
  for (const zp of core.inboxZips()) {
    const name = await core.registerZip(zp, { settings, office, canDescribe: settings.brains.length > 0 });
    fs.writeFileSync(path.join(NOTIFY, `등록_${kst().stamp}_${path.basename(zp)}.md`), name
      ? `# [AI 사무실] 새 프로젝트 '${name}' 등록\n\n팀장이 프로젝트를 파악했어요. 이제 **업무 지시서** 이슈를 써 주세요.\n\n- 규칙: \`프로젝트/${name}/부서.md\`\n`
      : `# [AI 사무실] '${path.basename(zp)}'를 열지 못했어요\n\n받은편지함/실패 폴더로 옮겼어요. ZIP 파일이 맞는지 확인해 주세요.\n`, 'utf8');
  }

  // 오늘 일할 프로젝트
  const now = kst();
  const jobs = [];
  for (const p of core.projectList()) {
    if (forced.has(p.name)) jobs.push({ p, goal: forced.get(p.name) ?? ((p.order && p.order.goal) || ''), reason: 'manual' });
    else if (core.isDue(p, now, { ignoreTime: true })) jobs.push({ p, goal: p.order.goal || '', reason: 'schedule' });
  }
  for (const name of forced.keys()) if (!jobs.some(j => j.p.name === name)) logLine(`'${name}' 프로젝트를 찾지 못했어요`);
  if (!jobs.length) { logLine('오늘은 일할 프로젝트가 없어요'); return; }

  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : '';
  for (const job of jobs) {
    const left = settings.maxMinutes - (Date.now() - t0) / 60e3;
    if (left < 10) { logLine('오늘 일할 시간이 끝나서 남은 프로젝트는 다음에 해요:', job.p.name); break; }
    const st = readJSON(path.join(DIRS.projects, job.p.name, '상태.json'), {});
    const localOnly = !!st.localOnly;
    if (!settings.useSmallAI && (localOnly || !settings.brains.length)) { logLine(`'${job.p.name}': 쓸 두뇌가 없어요 (작은 AI 끔)`); continue; }
    const chat = brains.makeChat(settings, { localOnly, beforeLocal: settings.useSmallAI ? () => ensureOllama(settings.model) : async () => { throw new Error('작은 AI를 쓰지 않도록 설정돼 있어요'); } });
    try {
      const minutes = Math.min(left - 5, Number((st.order || {}).maxMinutes) || 60);
      const r = await team.runJob({ project: job.p.name, chat, office, goal: job.goal || '', maxMinutes: minutes });
      // 결과물 ZIP은 저장소가 아니라 내려받기 파일로 올려요 (저장소가 커지지 않게)
      const zipName = `결과물_${job.p.name}.zip`;
      try { fs.copyFileSync(path.join(r.out, zipName), path.join(DOWNLOAD, `${job.p.name}_${r.run}.zip`)); } catch {}
      let report = '';
      try { report = fs.readFileSync(path.join(r.out, '보고서.md'), 'utf8'); } catch {}
      const rel = path.relative(ROOT, r.out).split(path.sep).join('/');
      fs.writeFileSync(path.join(NOTIFY, `보고_${r.run}_${job.p.name}.md`), [
        `# [AI 사무실] ${job.p.name}: ${r.done ? r.done + '건 고침' : '변경 없음'} (${r.run.replace('_', ' ')})`, '',
        `> ${r.headline}`, '',
        `📦 **결과물 ZIP 받기**: AI 사무실 사이트의 **결과물** 칸에서 내려받아요.${runUrl ? ` (또는 [이번 실행 페이지](${runUrl}) 맨 아래 Artifacts, 30일 보관)` : ''}`,
        `📄 보고서 파일: \`${rel}/보고서.md\``, '', '---', '', report.replace(/^# .*\n/, ''),
      ].join('\n'), 'utf8');
      if (job.reason === 'schedule' && st.order && st.order.to && now.date >= st.order.to) {
        const f = core.weeklyReport(job.p.name, st.order, office);
        fs.writeFileSync(path.join(NOTIFY, `종합_${job.p.name}.md`), `# [AI 사무실] ${job.p.name} 종합 보고 (${st.order.from} ~ ${st.order.to})\n\n` + fs.readFileSync(f, 'utf8').replace(/^# .*\n/, ''), 'utf8');
      }
    } catch (e) {
      logLine('업무 오류', job.p.name, e);
      fs.writeFileSync(path.join(NOTIFY, `오류_${kst().stamp}_${job.p.name}.md`), `# [AI 사무실] ${job.p.name} 업무 중 문제가 생겼어요\n\n${String(e.message || e).slice(0, 500)}\n\n${runUrl ? '자세한 기록: ' + runUrl : ''}\n`, 'utf8');
      office.reset();
    }
  }
}

process.on('unhandledRejection', e => logLine('처리 못 한 오류:', e));
main().then(() => { logLine('AI 사무실 (GitHub) 끝'); process.exit(0); })
  .catch(e => { logLine('AI 사무실 (GitHub) 오류', e); process.exit(1); });
