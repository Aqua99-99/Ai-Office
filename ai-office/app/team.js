// AI 팀의 하루 업무: 조사 → 계획 → 개발 → 시험 → 검토 → 배포 준비 → 보고
'use strict';
const fs = require('fs');
const path = require('path');
const { DIRS, readJSON, writeJSON, kst, safeJoin, run, hasCommand, zipDir, copyDir } = require('./util');
const llm = require('./llm');

const SEV = { high: 3, medium: 2, low: 1 };
const CHUNK = 110;          // 한 조각 최대 줄 수
const CHUNK_CHARS = 3500;   // 한 조각 최대 글자 수 (작은 모델이 빨리 읽게)
const CHUNKS_PER_RUN = 4;   // 하루에 살펴볼 조각 수

// ---------- 자동 시험 (AI 없이 기계적으로) ----------
async function runChecks(dir, info, allowProjectTests) {
  const res = [];
  for (const c of info.checks) {
    if (c.kind === 'node-check') {
      for (const f of info.work.filter(p => /\.(js|mjs|cjs)$/.test(p))) {
        const r = await run(process.execPath, ['--check', path.join(dir, f)], { timeout: 60000 });
        res.push({ name: '문법 ' + f, ok: r.code === 0, out: r.code === 0 ? '' : r.out.slice(-800) });
      }
    } else if (c.kind === 'json') {
      for (const f of info.work.filter(p => /\.json$/.test(p))) {
        let ok = true, out = '';
        try { JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8').replace(/^﻿/, '')); } catch (e) { ok = false; out = e.message; }
        res.push({ name: 'JSON ' + f, ok, out });
      }
    } else if (c.kind === 'py-compile') {
      const py = (await hasCommand('python')) ? 'python' : (await hasCommand('python3')) ? 'python3' : null;
      if (!py) continue;
      for (const f of info.work.filter(p => /\.py$/.test(p))) {
        const r = await run(py, ['-m', 'py_compile', path.join(dir, f)], { timeout: 60000 });
        res.push({ name: '문법 ' + f, ok: r.code === 0, out: r.out.slice(-800) });
      }
    } else if (c.kind === 'html') {
      for (const f of info.work.filter(p => /\.html?$/.test(p))) {
        const t = fs.readFileSync(path.join(dir, f), 'utf8');
        const cnt = re => (t.match(re) || []).length;
        const ok = cnt(/<script\b/gi) === cnt(/<\/script>/gi) && cnt(/<style\b/gi) === cnt(/<\/style>/gi);
        res.push({ name: 'HTML ' + f, ok, out: ok ? '' : 'script/style 태그 짝이 맞지 않아요' });
      }
    }
  }
  if (allowProjectTests) {
    for (const t of info.projectTests) {
      // Windows에서 npm은 cmd를 거쳐야 실행돼요
      const [cmd, args] = t.cmd === 'node' ? [process.execPath, t.args] : (process.platform === 'win32' ? ['cmd', ['/c', t.cmd, ...t.args]] : [t.cmd, t.args]);
      const r = await run(cmd, args, { cwd: safeJoin(dir, t.cwd || '.'), timeout: 300000 });
      res.push({ name: '시험 ' + t.label, ok: r.code === 0, out: r.out.slice(-1500) });
    }
  }
  return res;
}
function newFailures(base, work) {
  const okBefore = new Map(base.map(r => [r.name, r.ok]));
  return work.filter(r => !r.ok && okBefore.get(r.name) !== false);
}
const summarizeChecks = rs => ({ pass: rs.filter(r => r.ok).length, fail: rs.filter(r => !r.ok).length });

// ---------- 파일 조각 ----------
function readText(dir, f) { return fs.readFileSync(safeJoin(dir, f), 'utf8'); }
function excerpt(text, start, n, maxChars = CHUNK_CHARS) {
  const lines = text.split('\n');
  const s = Math.max(0, start);
  let e = Math.min(lines.length, s + n), size = 0;
  for (let k = s; k < e; k++) { size += lines[k].length + 1; if (size > maxChars && k > s) { e = k; break; } }
  return { start: s, end: e, total: lines.length, body: lines.slice(s, e).join('\n'), numbered: lines.slice(s, e).map((l, i) => `${s + i + 1}: ${l}`).join('\n') };
}
const clip = (s, n) => (s.length > n ? s.slice(0, n) + '\n…' : s);

// ---------- 수정 적용 (작은 모델이 공백을 조금 틀려도 찾아요) ----------
function locate(text, find) {
  const exact = text.split(find).length - 1;
  if (exact === 1) { const i = text.indexOf(find); return { start: i, end: i + find.length }; }
  if (exact > 1) return { error: '같은 코드가 여러 군데 있어요' };
  const lines = text.split('\n'), want = find.split('\n').map(l => l.trim()).filter((l, i, a) => l || (i > 0 && i < a.length - 1));
  if (!want.length) return { error: '찾을 코드가 비어 있어요' };
  const hits = [];
  for (let i = 0; i <= lines.length - want.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length; k++) if (lines[i + k].trim() !== want[k]) { ok = false; break; }
    if (ok) hits.push(i);
  }
  if (hits.length !== 1) return { error: hits.length ? '같은 코드가 여러 군데 있어요' : '고칠 코드를 파일에서 찾지 못했어요' };
  let start = 0; for (let i = 0; i < hits[0]; i++) start += lines[i].length + 1;
  let end = start; for (let k = 0; k < want.length; k++) end += lines[hits[0] + k].length + 1;
  return { start, end: Math.min(end - 1, text.length) };
}
function applyEdits(workDir, edits, info) {
  const applied = [];
  for (const e of edits) {
    if (!e || typeof e.file !== 'string' || typeof e.find !== 'string' || typeof e.replace !== 'string') return { error: '수정 형식이 잘못됐어요' };
    const f = e.file.replace(/^\.?\//, '');
    if (!info.work.includes(f)) return { error: `다룰 수 없는 파일이에요: ${f}` };
    if (info.protect.some(p => f === p || f.startsWith(p + '/'))) return { error: `보호된 파일이에요: ${f}` };
    if ((info.tests || []).includes(f)) return { error: `시험 코드는 고칠 수 없어요: ${f}` };
    if (e.find === e.replace) return { error: '바뀐 내용이 없어요' };
    if (e.replace.length > 6000 || e.find.length > 6000) return { error: '수정이 너무 커요' };
    const full = safeJoin(workDir, f);
    const text = fs.readFileSync(full, 'utf8');
    const loc = locate(text, e.find);
    if (loc.error) return { error: `${f}: ${loc.error}` };
    const before = text.slice(loc.start, loc.end);
    const next = text.slice(0, loc.start) + e.replace + text.slice(loc.end);
    fs.writeFileSync(full, next, 'utf8');
    applied.push({ file: f, before, after: e.replace, at: text.slice(0, loc.start).split('\n').length });
  }
  return { applied };
}
function diffText(applied) {
  return applied.map(a => {
    const minus = a.before.split('\n').map(l => '-' + l).join('\n');
    const plus = a.after.split('\n').map(l => '+' + l).join('\n');
    return `--- ${a.file}\n+++ ${a.file}\n@@ ${a.at}번째 줄 근처 @@\n${minus}\n${plus}`;
  }).join('\n\n');
}

// ---------- 직원별 AI 지시문 ----------
const ROLE_REVIEW = {
  qa: 'You are a software tester. Find real BUGS in this code excerpt: wrong logic, crashes, unhandled errors, wrong conditions, typos in names.',
  sec: 'You are a security reviewer (OWASP Top 10). Find real SECURITY problems in this code excerpt: user data put into innerHTML without escaping, eval, secrets in code, unsafe URLs, missing input validation.',
  des: 'You are a UI/UX reviewer. Find real USABILITY problems in this excerpt: unclear or wrong user-facing text, missing labels for inputs, hard-coded colors that break dark mode, broken layout on phones.',
};
const REVIEW_FORMAT = 'Only report problems you are SURE about, at most 2. Copy the exact problematic line into "code". Reply JSON only: {"findings":[{"line":123,"code":"exact line from excerpt","problem":"Korean sentence","severity":"high|medium|low","fix_hint":"Korean sentence"}]}. If nothing is clearly wrong, reply {"findings":[]}.';

// ---------- 하루 업무 ----------
async function runJob(ctx) {
  const { project, chat, office, goal = '', maxMinutes = 60, maxItems = 3 } = ctx;
  const pdir = path.join(DIRS.projects, project);
  const info = readJSON(path.join(pdir, '정보.json'));
  const state = readJSON(path.join(pdir, '상태.json'), {});
  if (!info) throw new Error('프로젝트 정보가 없어요. 다시 넣어 주세요.');
  const cur = path.join(pdir, '현재');
  const work = path.join(pdir, '_작업');
  const RUN = kst().stamp;
  const t0 = Date.now();
  const timeLeft = () => maxMinutes * 60e3 - (Date.now() - t0);
  const mode = goal.trim() ? '지시 업무' : '자율 점검';
  const notes = { pm: [], dev: [], qa: [], sec: [], des: [], ops: [] };
  const say = (who, kind, text, to) => office.log(who, kind, text, to);
  const ask = async (who, system, user, opts) => {
    if (timeLeft() < 60e3) throw Object.assign(new Error('오늘 업무 시간이 끝났어요'), { timeup: true });
    return chat(system, user, opts);
  };

  office.start(project, mode === '지시 업무' ? goal.slice(0, 40) : '정기 점검');
  say('pm', 'start', `오늘 업무: ${mode === '지시 업무' ? goal.slice(0, 30) : '스스로 점검하고 고치기'}`);
  await copyDir(cur, work);

  // 1) 기준 시험
  office.staff('qa', 'working', '고치기 전 시험');
  say('pm', 'handoff', '먼저 지금 상태를 시험해 주세요', 'qa');
  const baseChecks = await runChecks(work, info, !!state.allowProjectTests);
  const bs = summarizeChecks(baseChecks);
  notes.qa.push(`고치기 전 시험: 통과 ${bs.pass} / 실패 ${bs.fail}`);
  say('qa', 'say', `기준 시험 통과 ${bs.pass}, 실패 ${bs.fail}`);
  office.staff('qa', 'idle', '');

  const items = [], results = [];
  let stopped = '';
  try {
    // 2) 조사
    let findings = [];
    if (mode === '지시 업무') {
      office.staff('dev', 'working', '관련 코드 찾는 중');
      say('pm', 'handoff', '업무에 필요한 코드를 찾아 주세요', 'dev');
      const history = (state.runs || []).slice(-5).map(r => `- ${r.run}: ${r.summary}`).join('\n');
      const loc = await ask('dev', 'You help locate code for a task. Reply JSON only: {"files":["path", "...up to 3 from the list"],"keywords":["identifier or word likely in the relevant code", "...up to 6"]}',
        `Task (Korean): ${goal}\n\nPrevious work:\n${history || '(none)'}\n\nFiles:\n${info.work.slice(0, 150).join('\n')}`, { json: true, ctx: 6144 });
      const files = ((loc.data && loc.data.files) || []).filter(f => info.work.includes(f)).slice(0, 3);
      const kws = ((loc.data && loc.data.keywords) || []).filter(k => typeof k === 'string' && k.length >= 3).slice(0, 6);
      const pool = (files.length ? files : info.work.filter(f => /\.(js|ts|py|html|css)$/.test(f))).filter(f => !(info.tests || []).includes(f)).slice(0, 6);
      for (const f of pool) {
        const text = readText(work, f), lines = text.split('\n');
        let hit = lines.findIndex(l => kws.some(k => l.includes(k)));
        if (hit < 0 && files.includes(f)) hit = 0;
        if (hit >= 0) findings.push({ file: f, line: hit + 1, code: lines[hit].trim(), problem: goal, severity: 'high', fix_hint: '', role: 'dev' });
        if (findings.length >= 3) break;
      }
      notes.dev.push(`관련 파일: ${findings.map(x => x.file + ':' + x.line).join(', ') || '찾지 못함'}`);
      office.staff('dev', 'idle', '');
    } else {
      // 파일을 조각내서 매일 조금씩 돌아가며 살펴봐요 (어제 본 다음부터)
      const sizeOf = f => { try { return fs.statSync(safeJoin(work, f)).size; } catch { return 0; } };
      // 핵심 코드(큰 파일)부터 살펴봐요
      const targets = info.work.filter(f => /\.(js|mjs|ts|tsx|jsx|py|html?|css|vue|svelte)$/.test(f) && !(info.tests || []).includes(f))
        .sort((a, b) => sizeOf(b) - sizeOf(a) || a.localeCompare(b));
      const cursor = state.cursor || { i: 0, line: 0 };
      const chunks = [];
      let i = cursor.i % Math.max(1, targets.length), line = cursor.line, guard = 0;
      while (targets.length && chunks.length < CHUNKS_PER_RUN && guard++ < 200) {
        const f = targets[i];
        const t = readText(work, f);
        const total = t.split('\n').length;
        if (line >= total) { i = (i + 1) % targets.length; line = 0; continue; }
        const ex = excerpt(t, line, CHUNK);
        chunks.push({ file: f, start: line });
        line = ex.end;
      }
      state.cursor = { i, line };
      say('pm', 'say', `오늘은 코드 ${chunks.length}조각을 살펴봐요`);
      for (const ch of chunks) {
        if (timeLeft() < 5 * 60e3) { stopped = '시간이 부족해 조사를 일찍 마쳤어요'; break; }
        const text = readText(work, ch.file);
        const ex = excerpt(text, ch.start, CHUNK);
        const roles = /\.(html?|css|vue|svelte)$/.test(ch.file) ? ['des', 'sec'] : ['qa', 'sec'];
        for (const role of roles) {
          office.staff(role, 'working', `${ch.file} ${ex.start + 1}~${ex.end}줄 보는 중`);
          let r;
          try { r = await ask(role, ROLE_REVIEW[role] + ' ' + REVIEW_FORMAT, `File: ${ch.file} (lines ${ex.start + 1}-${ex.end} of ${ex.total})\n\n${ex.numbered}`, { json: true, ctx: 4096 }); }
          catch (e) { if (e.timeup) throw e; notes[role].push(`${ch.file} ${ex.start + 1}~${ex.end}줄: AI 응답 실패(${String(e.message).slice(0, 40)})`); office.staff(role, 'idle', ''); continue; }
          const list = (r.data && Array.isArray(r.data.findings)) ? r.data.findings : [];
          let kept = 0;
          for (const fd of list.slice(0, 2)) {
            const code = typeof fd.code === 'string' ? fd.code.trim() : '';
            // 지어낸 지적은 버려요: 실제 파일에 그 줄이 있어야 해요
            if (code.length < 6 || !ex.body.includes(code)) continue;
            findings.push({ file: ch.file, line: Number(fd.line) || 0, code, problem: String(fd.problem || '').slice(0, 200), severity: SEV[fd.severity] ? fd.severity : 'low', fix_hint: String(fd.fix_hint || '').slice(0, 200), role });
            kept++;
          }
          notes[role].push(`${ch.file} ${ex.start + 1}~${ex.end}줄: 지적 ${kept}건`);
          if (kept) say(role, 'say', `${ch.file}에서 ${kept}건 발견`);
          office.staff(role, 'idle', '');
        }
      }
    }

    // 3) 계획
    office.staff('pm', 'working', '할 일 정하는 중');
    findings.sort((a, b) => SEV[b.severity] - SEV[a.severity]);
    if (findings.length) {
      const list = findings.slice(0, 10).map((f, i) => `${i}. [${f.severity}] ${f.file}:${f.line} ${f.problem} | code: ${f.code}`).join('\n');
      let pick = null;
      try {
        const r = await ask('pm', `You are a team lead. Choose at most ${maxItems} items that are worth fixing, safe to change, and clearly correct. Skip anything about login, deleting data, or secrets. Reply JSON only: {"items":[{"index":0,"title":"short Korean title"}]}`,
          (mode === '지시 업무' ? `Owner's task: ${goal}\n` : '') + `Candidates:\n${list}`, { json: true, ctx: 6144 });
        pick = r.data && Array.isArray(r.data.items) ? r.data.items : null;
      } catch (e) { if (e.timeup) throw e; }
      const chosen = (pick || findings.slice(0, maxItems).map((_, i) => ({ index: i })))
        .filter(p => Number.isInteger(p.index) && findings[p.index]).slice(0, maxItems);
      const seen = new Set();
      for (const p of chosen) {
        if (seen.has(p.index)) continue; seen.add(p.index);
        const f = findings[p.index];
        items.push({ ...f, title: typeof p.title === 'string' && p.title.trim() ? p.title.trim().slice(0, 60) : f.problem.slice(0, 60) });
      }
    }
    notes.pm.push(items.length ? `할 일 ${items.length}개: ${items.map(x => x.title).join(' / ')}` : '오늘 고칠 만한 일을 찾지 못했어요');
    say('pm', 'say', items.length ? `할 일 ${items.length}개 정했어요` : '고칠 만한 일이 없었어요');
    office.staff('pm', 'idle', '');

    // 4~5) 개발 → 시험 → 검토 (항목마다, 최대 2번 시도)
    for (const it of items) {
      if (timeLeft() < 5 * 60e3) { stopped = '시간이 부족해 남은 일은 다음으로 미뤘어요'; break; }
      const result = { title: it.title, file: it.file, status: '보류', reason: '', applied: [] };
      let feedback = '';
      for (let attempt = 1; attempt <= 2; attempt++) {
        office.staff('dev', 'working', it.title);
        say('pm', 'handoff', it.title, 'dev');
        const text = readText(work, it.file);
        const lineNo = Math.max(1, text.split('\n').findIndex(l => l.includes(it.code)) + 1);
        const ex = excerpt(text, Math.max(0, lineNo - 40), 90);
        let r;
        try {
          r = await ask('dev', 'You are a careful developer. Make the SMALLEST change that fixes the problem. In "find", copy 1 to 6 COMPLETE lines exactly from the excerpt (same spaces) so they appear only once. Do not change unrelated code. Reply JSON only: {"edits":[{"file":"path","find":"exact existing lines","replace":"new lines"}],"summary":"one Korean sentence"}. At most 3 edits.',
            `Problem (Korean): ${it.problem}\nHint: ${it.fix_hint || '-'}\n${feedback ? 'Your previous attempt failed: ' + feedback + '\n' : ''}\nFile: ${it.file} (lines ${ex.start + 1}-${ex.end})\n-----\n${ex.body}\n-----`, { json: true, ctx: 6144 });
        } catch (e) { if (e.timeup) throw e; feedback = 'AI 응답 오류'; notes.dev.push(`${it.title}: AI 응답 실패`); continue; }
        const edits = r.data && Array.isArray(r.data.edits) ? r.data.edits.slice(0, 3) : [];
        if (!edits.length) { feedback = 'no edits returned'; notes.dev.push(`${it.title}: 수정안을 못 만들었어요`); continue; }
        const backup = new Map(edits.map(e => { try { const f = String(e.file).replace(/^\.?\//, ''); return [f, readText(work, f)]; } catch { return [null, null]; } }).filter(x => x[0]));
        const restore = () => { for (const [f, t] of backup) fs.writeFileSync(safeJoin(work, f), t, 'utf8'); };
        const ap = applyEdits(work, edits, info);
        if (ap.error) { restore(); feedback = ap.error; notes.dev.push(`${it.title}: ${ap.error}`); say('dev', 'say', '코드 위치를 다시 찾아볼게요'); continue; }
        const summary = typeof r.data.summary === 'string' ? r.data.summary.slice(0, 160) : '';
        office.staff('dev', 'idle', '');

        // 테스터: 기계 시험 + AI 확인
        office.staff('qa', 'working', it.title + ' 시험');
        say('dev', 'handoff', '고쳤어요, 시험해 주세요', 'qa');
        const checks = await runChecks(work, info, !!state.allowProjectTests);
        const broke = newFailures(baseChecks, checks);
        if (broke.length) {
          restore(); feedback = 'tests failed: ' + broke.map(b => b.name + ' ' + b.out.slice(0, 200)).join('; ');
          notes.qa.push(`${it.title}: 반려 (새로 실패 ${broke.length}건)`);
          office.staff('qa', 'blocked', '시험 실패'); say('qa', 'block', `시험 실패로 반려했어요 (${attempt}/2)`); continue;
        }
        const diff = diffText(ap.applied);
        let qaOk = true, qaWhy = '';
        try {
          const q = await ask('qa', 'You are a tester reviewing a code change. Is it correct and does it address the problem without breaking other behavior? Reply JSON only: {"ok":true,"reason":"Korean sentence"}',
            `Problem: ${it.problem}\nChange:\n${clip(diff, 3500)}`, { json: true, ctx: 6144 });
          qaOk = !(q.data && q.data.ok === false); qaWhy = q.data && q.data.reason ? String(q.data.reason).slice(0, 160) : '';
        } catch (e) { if (e.timeup) { restore(); throw e; } }
        if (!qaOk) {
          restore(); feedback = 'tester rejected: ' + qaWhy; notes.qa.push(`${it.title}: 반려 (${qaWhy})`);
          office.staff('qa', 'blocked', '검토 반려'); say('qa', 'block', '변경이 맞지 않아 반려했어요'); continue;
        }
        office.staff('qa', 'done', '통과');
        // 보안
        office.staff('sec', 'review', it.title + ' 보안 검토');
        let secOk = true, secWhy = '';
        try {
          const s = await ask('sec', 'You are a security reviewer. Does this change ADD a security risk (XSS via innerHTML, eval, secrets, unsafe URLs, removed validation)? Reply JSON only: {"block":false,"reason":"Korean sentence"}',
            `Change:\n${clip(diff, 3500)}`, { json: true, ctx: 6144 });
          secOk = !(s.data && s.data.block === true); secWhy = s.data && s.data.reason ? String(s.data.reason).slice(0, 160) : '';
        } catch (e) { if (e.timeup) { restore(); throw e; } }
        office.staff('sec', secOk ? 'done' : 'blocked', secOk ? '문제 없음' : '막음');
        if (!secOk) { restore(); feedback = 'security blocked: ' + secWhy; notes.sec.push(`${it.title}: 막음 (${secWhy})`); say('sec', 'block', '보안 문제로 막았어요'); continue; }
        notes.sec.push(`${it.title}: 문제 없음`);
        result.status = '완료'; result.reason = summary || qaWhy; result.applied = ap.applied; result.checks = summarizeChecks(checks);
        notes.dev.push(`${it.title}: ${summary || '수정'}`);
        say('qa', 'done', `${it.title} 통과!`);
        break;
      }
      if (result.status !== '완료') result.reason = feedback ? '2번 시도했지만 통과하지 못했어요' : '수정안을 만들지 못했어요';
      results.push(result);
      office.staff('dev', 'idle', '');
    }
  } catch (e) {
    if (e.timeup) stopped = e.message; else { stopped = '오류로 일찍 마쳤어요: ' + String(e.message || e).slice(0, 200); }
    require('./util').logLine('업무 중 오류', e);
  }

  // 6) 배포 준비 (기계적으로)
  const done = results.filter(r => r.status === '완료');
  const changed = [...new Set(done.flatMap(r => r.applied.map(a => a.file)))];
  if (changed.length) {
    office.staff('ops', 'working', '배포 준비');
    for (const rel of info.release || []) {
      if (rel.kind !== 'bump-cache') continue;
      const full = safeJoin(work, rel.file);
      const t = fs.readFileSync(full, 'utf8');
      const m = t.match(/(['"][\w.-]*-v)(\d+)(['"])/);
      if (m) {
        const next = t.replace(m[0], m[1] + (Number(m[2]) + 1) + m[3]);
        fs.writeFileSync(full, next, 'utf8');
        if (!changed.includes(rel.file)) changed.push(rel.file);
        notes.ops.push(`${rel.file} 캐시 번호 v${m[2]} → v${Number(m[2]) + 1}`);
      }
    }
    const finalChecks = await runChecks(work, info, !!state.allowProjectTests);
    const broke = newFailures(baseChecks, finalChecks);
    if (broke.length) {
      // 마지막 안전장치: 합쳐서 깨지면 오늘 변경은 모두 넣지 않아요
      notes.ops.push('합쳐서 시험했더니 실패 → 오늘 변경은 넣지 않았어요');
      for (const r of done) { r.status = '보류'; r.reason = '다른 변경과 합치니 시험 실패'; }
      changed.length = 0;
    } else {
      notes.ops.push(`바뀐 파일 ${changed.length}개, 마지막 시험 통과`);
    }
    office.staff('ops', 'done', '정리 끝');
  } else notes.ops.push('바뀐 파일이 없어 배포 준비는 쉬었어요');

  // 7) 결과 저장
  office.staff('pm', 'working', '보고서 쓰는 중');
  let out = path.join(DIRS.results, project, RUN), dup = 2;
  while (fs.existsSync(out)) out = path.join(DIRS.results, project, `${RUN}_${dup++}`);
  const RUN_ID = path.basename(out);
  fs.mkdirSync(out, { recursive: true });
  const okItems = results.filter(r => r.status === '완료');
  if (changed.length) {
    for (const f of changed) {
      fs.mkdirSync(path.dirname(path.join(out, '원본', f)), { recursive: true });
      fs.mkdirSync(path.dirname(path.join(out, '고친파일', f)), { recursive: true });
      fs.copyFileSync(safeJoin(cur, f), path.join(out, '원본', f));
      fs.copyFileSync(safeJoin(work, f), path.join(out, '고친파일', f));
      fs.copyFileSync(safeJoin(work, f), safeJoin(cur, f)); // 다음 업무는 오늘 결과에서 이어서
    }
    fs.writeFileSync(path.join(out, '바뀐부분.diff'), okItems.map(r => diffText(r.applied)).join('\n\n'), 'utf8');
  }
  const after = changed.length ? summarizeChecks(await runChecks(cur, info, !!state.allowProjectTests)) : bs;
  fs.writeFileSync(path.join(out, '시험결과.txt'), baseChecks.map(r => `${r.ok ? '통과' : '실패'}  ${r.name}${r.out ? '\n    ' + r.out.replace(/\n/g, '\n    ') : ''}`).join('\n'), 'utf8');

  let headline = '';
  try {
    if (timeLeft() > 30e3) {
      const s = await chat('Write a short report summary in Korean (2 sentences) for a beginner owner. Plain, polite words. No greeting, no English, no technical error terms.',
        `Mode: ${mode}. ${goal ? 'Task: ' + goal + '. ' : ''}Done: ${okItems.map(r => r.title).join(', ') || 'none'}. On hold: ${results.filter(r => r.status !== '완료').map(r => r.title).join(', ') || 'none'}. ${stopped}`, { ctx: 2048 });
      headline = s.text.slice(0, 300);
    }
  } catch {}
  if (!headline) headline = okItems.length ? `${okItems.length}가지를 고치고 시험을 통과했어요.` : '오늘은 결과물에 넣을 만한 변경이 없었어요.';

  const md = [];
  md.push(`# ${project} — ${mode} (${RUN.replace('_', ' ')})`, '');
  md.push(`**한 줄 요약**: ${headline}`, '');
  md.push(`**결과**: ${okItems.length ? '✅ ' + okItems.length + '건 완료' : '🔍 변경 없음'}${results.length - okItems.length ? ` · ⚠️ ${results.length - okItems.length}건 보류` : ''}${stopped ? ' · ⏱ ' + stopped : ''}`, '');
  if (goal) md.push(`**지시 업무**: ${goal}`, '');
  md.push('## 한 일');
  if (results.length) results.forEach(r => md.push(`- ${r.status === '완료' ? '✅' : '⚠️'} **${r.title}** (\`${r.file}\`) — ${r.reason || ''}`));
  else md.push('- 고칠 일을 찾지 못했어요');
  md.push('');
  md.push('## 바뀐 파일');
  changed.length ? changed.forEach(f => md.push(`- \`${f}\``)) : md.push('- 없음');
  md.push('');
  md.push('## 시험 결과', `- 고치기 전: 통과 ${bs.pass} / 실패 ${bs.fail}`, `- 고친 뒤: 통과 ${after.pass} / 실패 ${after.fail}`, '- 시험을 통과하지 못한 변경은 결과물에 넣지 않았어요.', '');
  if (changed.length) md.push('## 결과물 쓰는 법', `- \`결과물_${project}.zip\`이 오늘까지 고친 **프로젝트 전체**예요. 원래 쓰던 곳에 그대로 덮어쓰면 돼요.`, '- 바뀐 파일만 필요하면 `고친파일` 폴더를, 되돌리려면 `원본` 폴더를 쓰세요.', '- AI가 고친 거라 실수가 있을 수 있어요. 올리기 전에 한 번 써 보세요.', '');
  else md.push('## 결과물', `- 오늘은 바뀐 파일이 없어요. \`결과물_${project}.zip\`은 지금까지의 프로젝트 전체예요.`, '');
  const used = Object.entries(chat.usage || {});
  if (used.length) { md.push('## 오늘 일한 두뇌'); used.forEach(([k, v]) => md.push(`- ${k}: ${v}번`)); md.push(''); }
  md.push('## 직원별 기록');
  const NAMES = { pm: '팀장', dev: '개발자', qa: '테스터', sec: '보안', des: '디자이너', ops: '배포' };
  for (const k of Object.keys(NAMES)) md.push(`- **${NAMES[k]}**: ${notes[k].join(' · ') || '오늘은 쉬었어요'}`);
  fs.writeFileSync(path.join(out, '보고서.md'), md.join('\n') + '\n', 'utf8');
  await zipDir(cur, path.join(out, `결과물_${project}.zip`));
  fs.rmSync(work, { recursive: true, force: true });

  state.runs = [...(state.runs || []), { run: RUN_ID, mode, goal, summary: headline.slice(0, 120), changed: changed.length, done: okItems.length }].slice(-60);
  state.lastRunDate = kst().date;
  // 업무 중에 사용자가 지시서를 바꿨을 수 있으니, 업무가 바꾼 항목만 덮어써요
  writeJSON(path.join(pdir, '상태.json'), { ...readJSON(path.join(pdir, '상태.json'), {}), cursor: state.cursor, runs: state.runs, lastRunDate: state.lastRunDate });
  say('pm', 'report', '보고서 올려 두었어요');
  office.end();
  return { run: RUN_ID, out, changed: changed.length, done: okItems.length, headline };
}

module.exports = { runJob, runChecks, applyEdits, locate };
