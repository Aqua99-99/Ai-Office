// 컴퓨터 버전과 GitHub 버전이 같이 쓰는 사무실 기본 기능
'use strict';
const fs = require('fs');
const path = require('path');
const { logLine, DIRS, readJSON, writeJSON, kst, cleanName, unzip, unwrapSingleFolder, copyDir } = require('./util');
const llm = require('./llm');
const onboard = require('./onboard');
const brains = require('./brains');

const STAFF = ['pm', 'dev', 'qa', 'sec', 'des', 'ops'];
// 사무실 상태 (화면이 읽어 가고, GitHub 버전은 기록으로 남겨요)
function createOffice() {
  return {
    running: false, project: '', mission: '', startedAt: 0, endedAt: 0, reports: 0, seq: 0,
    staffMap: Object.fromEntries(STAFF.map(id => [id, { status: 'idle', task: '' }])),
    logs: [],
    start(project, mission) {
      this.running = true; this.project = project; this.mission = mission; this.startedAt = Date.now(); this.endedAt = 0;
      for (const id of STAFF) this.staffMap[id] = { status: 'idle', task: '' };
      this.staffMap.pm = { status: 'working', task: '업무 나누는 중' };
    },
    staff(id, status, task) { if (this.staffMap[id]) this.staffMap[id] = { status, task: String(task || '').slice(0, 60) }; },
    log(who, kind, text, to) {
      this.logs.push({ id: ++this.seq, at: Date.now(), who, kind, text: String(text || '').slice(0, 120), to: to || '' });
      if (this.logs.length > 300) this.logs.splice(0, this.logs.length - 300);
      logLine(`${who}${to ? '→' + to : ''} ${kind}: ${text}`);
    },
    end() {
      this.running = false; this.endedAt = Date.now(); this.reports++;
      for (const id of STAFF) if (this.staffMap[id].status !== 'idle') this.staffMap[id] = { status: 'done', task: '' };
      this.staffMap.pm = { status: 'done', task: '보고 완료' };
    },
    reset() { this.running = false; for (const id of STAFF) this.staffMap[id] = { status: 'idle', task: '' }; },
  };
}

function projectList() {
  let names = [];
  try { names = fs.readdirSync(DIRS.projects, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch {}
  return names.map(name => {
    const p = path.join(DIRS.projects, name);
    const st = readJSON(path.join(p, '상태.json'), {});
    const info = readJSON(path.join(p, '정보.json'), {});
    return { name, type: info.type || [], summary: st.summary || '', order: st.order || null, allowProjectTests: !!st.allowProjectTests, localOnly: !!st.localOnly,
      hasProjectTests: (info.projectTests || []).length > 0, runs: (st.runs || []).slice(-10).reverse(), lastRunDate: st.lastRunDate || '' };
  });
}
function defaultOrder() {
  const t = kst(), end = kst(new Date(Date.now() + 4 * 864e5));
  return { enabled: false, days: [1, 2, 3, 4, 5], time: '09:00', from: t.date, to: end.date, goal: '', maxMinutes: 60 };
}
function localReady(settings, st) {
  return !!settings.model && !!st && st.running && st.models.some(m => m === settings.model || m === settings.model + ':latest');
}
function cloudReady(settings) {
  return brains.normalize(settings).some(b => b.enabled && (!brains.PRESETS[b.preset].needKey || b.key));
}

// ZIP 하나를 프로젝트로 등록. onStep(글, %)로 진행을 알려요.
async function registerZip(zp, { settings, office, onStep = () => {}, canDescribe = true }) {
  const z = path.basename(zp);
  let name = cleanName(z), n = 2;
  while (fs.existsSync(path.join(DIRS.projects, name))) name = `${cleanName(z)} (${n++})`;
  const pdir = path.join(DIRS.projects, name);
  const step = (txt, pct) => onStep({ name, step: txt, pct: pct == null ? null : pct });
  office.log('pm', 'start', `새 프로젝트 '${name}'가 들어왔어요`);
  office.staff('pm', 'working', '새 프로젝트 파악 중');
  logLine('프로젝트 등록 시작:', z, '→', name);
  try {
    const tmp = path.join(pdir, '_풀기');
    step('압축 푸는 중', 0);
    let lastLog = 0;
    const r = await unzip(zp, tmp, pct => { step('압축 푸는 중', pct); if (pct - lastLog >= 25) { lastLog = pct; office.staff('pm', 'working', `압축 푸는 중 ${pct}%`); } });
    logLine(`압축 풀기 끝: 파일 ${r.files}개, 건너뜀 ${r.skipped}개`);
    const root = unwrapSingleFolder(tmp);
    step('파일 정리하는 중', null);
    await copyDir(root, path.join(pdir, '처음'));
    await copyDir(root, path.join(pdir, '현재'));
    await fs.promises.rm(tmp, { recursive: true, force: true });
    step('프로젝트 살펴보는 중', null);
    const info = onboard.scan(path.join(pdir, '현재'));
    writeJSON(path.join(pdir, '정보.json'), info);
    office.log('pm', 'say', `파일 ${info.files}개 확인, 보호할 파일 ${info.protect.length}개`);
    let desc = { summary: '', features: [], cautions: [] };
    if (canDescribe) {
      step('AI가 프로젝트 소개를 쓰는 중 (1~3분)', null);
      office.staff('pm', 'working', 'AI가 프로젝트 소개 쓰는 중');
      try { desc = await onboard.describe(path.join(pdir, '현재'), info, brains.makeChat(settings)); } catch (e) { logLine('소개 쓰기 실패(괜찮아요)', e.message); }
    }
    fs.writeFileSync(path.join(pdir, '부서.md'), onboard.profileMarkdown(name, info, desc), 'utf8');
    writeJSON(path.join(pdir, '상태.json'), { created: kst().stamp, summary: desc.summary, order: defaultOrder(), allowProjectTests: false, runs: [] });
    fs.mkdirSync(path.join(DIRS.inbox, '처리됨'), { recursive: true });
    fs.renameSync(zp, path.join(DIRS.inbox, '처리됨', `${kst().stamp}_${z}`));
    office.log('pm', 'report', `'${name}' 파악 끝! 업무 지시서를 써 주세요`);
    logLine('프로젝트 등록 끝:', name);
    return name;
  } catch (e) {
    logLine('프로젝트 등록 실패:', z, e);
    office.log('pm', 'block', `'${z}'를 열지 못했어요: ${String(e.message || e).slice(0, 80)}`);
    try { fs.mkdirSync(path.join(DIRS.inbox, '실패'), { recursive: true }); fs.renameSync(zp, path.join(DIRS.inbox, '실패', z)); } catch {}
    try { await fs.promises.rm(pdir, { recursive: true, force: true }); } catch {}
    return null;
  } finally { office.staff('pm', 'idle', ''); }
}
function inboxZips() {
  try { return fs.readdirSync(DIRS.inbox).filter(f => /\.zip$/i.test(f)).map(f => path.join(DIRS.inbox, f)); }
  catch (e) { logLine('받은편지함을 읽지 못함', e); return []; }
}

// 끝나지 않은 프로젝트 등록(상태.json 없는 폴더)은 지우고, 남은 작업 폴더도 정리
async function cleanupUnfinished() {
  let names = [];
  try { names = fs.readdirSync(DIRS.projects, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch { return; }
  for (const nm of names) {
    const p = path.join(DIRS.projects, nm);
    if (!fs.existsSync(path.join(p, '상태.json'))) {
      logLine('끝나지 않은 프로젝트 등록 정리:', nm);
      try { await fs.promises.rm(p, { recursive: true, force: true }); } catch (e) { logLine('정리 실패', e); }
    } else {
      try { await fs.promises.rm(path.join(p, '_작업'), { recursive: true, force: true }); } catch {}
    }
  }
}

// 오늘 일할 차례인지 (ignoreTime: GitHub 버전은 정해진 시각에 한 번 켜지므로 시각은 안 봐요)
function isDue(p, now = kst(), { ignoreTime = false } = {}) {
  const o = p.order;
  if (!o || !o.enabled) return false;
  if (o.from && now.date < o.from) return false;
  if (o.to && now.date > o.to) return false;
  if (!Array.isArray(o.days) || !o.days.includes(now.weekday)) return false;
  if (!ignoreTime && now.time < (o.time || '09:00')) return false;
  if (p.lastRunDate === now.date) return false;
  return true;
}

function weeklyReport(project, order, office) {
  const st = readJSON(path.join(DIRS.projects, project, '상태.json'), {});
  const runs = (st.runs || []).filter(r => r.run.slice(0, 10) >= order.from && r.run.slice(0, 10) <= order.to);
  const md = [`# ${project} 종합 보고 (${order.from} ~ ${order.to})`, '', order.goal ? `**지시 업무**: ${order.goal}` : '**업무**: 자율 점검', '',
    `- 일한 날: ${runs.length}일`, `- 고친 일: ${runs.reduce((a, r) => a + (r.done || 0), 0)}건`, '', '## 날짜별', ...runs.map(r => `- ${r.run}: ${r.summary}`), '',
    `마지막 결과물은 \`결과/${project}/${runs.length ? runs[runs.length - 1].run : ''}/\` 폴더예요.`];
  const dir = path.join(DIRS.results, project); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `종합보고_${order.from}~${order.to}.md`);
  fs.writeFileSync(f, md.join('\n') + '\n', 'utf8');
  office.log('pm', 'report', '이번 기간 종합 보고서를 올렸어요');
  return f;
}

module.exports = { STAFF, createOffice, projectList, defaultOrder, localReady, cloudReady, registerZip, inboxZips, cleanupUnfinished, isDue, weeklyReport };
