// 공용 도구: 경로, 파일, 명령 실행, 압축
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIRS = {
  root: ROOT,
  inbox: path.join(ROOT, '받은편지함'),
  projects: path.join(ROOT, '프로젝트'),
  results: path.join(ROOT, '결과'),
  ui: path.join(ROOT, 'app', 'ui'),
  settings: path.join(ROOT, '설정.json'),
};
for (const k of ['inbox', 'projects', 'results']) fs.mkdirSync(DIRS[k], { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function writeJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

// 한국 시간 기준 날짜/시각
function kst(d = new Date()) {
  const t = new Date(d.getTime() + 9 * 3600e3);
  const p = n => String(n).padStart(2, '0');
  return {
    date: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`,
    time: `${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`,
    stamp: `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}_${p(t.getUTCHours())}${p(t.getUTCMinutes())}`,
    weekday: t.getUTCDay(), // 0=일 ... 6=토
  };
}

// base 안에 있는 경로만 허용 (폴더 밖으로 나가는 경로 막기)
function safeJoin(base, rel) {
  const full = path.resolve(base, rel);
  const b = path.resolve(base);
  if (full !== b && !full.startsWith(b + path.sep)) throw new Error('허용되지 않는 경로: ' + rel);
  return full;
}

// 프로젝트 이름으로 쓸 수 있게 정리
function cleanName(s) {
  return String(s || '프로젝트').replace(/\.zip$/i, '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || '프로젝트';
}

// 명령 실행 (셸 없이, 시간 제한)
function run(cmd, args, opts = {}) {
  return new Promise(resolve => {
    let out = '', done = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) }, windowsHide: true, shell: false });
    } catch (e) { resolve({ code: -1, out: String(e.message || e) }); return; }
    const finish = code => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out: out.slice(-20000) }); };
    const add = d => { out += d; if (out.length > 60000) out = out.slice(-30000); }; // 출력이 많아도 메모리가 넘치지 않게
    const timer = setTimeout(() => { try { child.kill(); } catch {} out += '\n[시간 초과]'; finish(-2); }, opts.timeout || 120000);
    child.stdout && child.stdout.on('data', add);
    child.stderr && child.stderr.on('data', add);
    child.on('error', e => { out += String(e.message || e); finish(-1); });
    child.on('close', c => finish(c));
  });
}

async function hasCommand(cmd) {
  const r = await run(process.platform === 'win32' ? 'where' : 'which', [cmd], { timeout: 10000 });
  return r.code === 0;
}

// 압축 풀기/만들기: 프로그램이 직접 해요 (zip.js)
const zip = require('./zip');
async function unzip(zipPath, dest, onProgress) {
  const r = await zip.extract(zipPath, dest, onProgress);
  onProgress && onProgress(100);
  return r;
}
async function zipDir(srcDir, zipPath) { return zip.create(srcDir, zipPath); }

function listAll(dir) {
  const out = [];
  const walk = d => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.isFile()) out.push(p);
    }
  };
  walk(dir);
  return out;
}

async function copyDir(src, dest) {
  await fs.promises.rm(dest, { recursive: true, force: true });
  await fs.promises.cp(src, dest, { recursive: true });
}

// 기록 파일: 창 없이 켜도 무슨 일이 있었는지 남겨요 (AI-Office/기록.log, 1MB 넘으면 새로 시작)
const LOG_FILE = path.join(ROOT, '기록.log');
function logLine(...args) {
  const line = `[${new Date().toLocaleString('sv-SE')}] ` + args.map(a => (a && a.stack) ? a.stack : String(a)).join(' ');
  try { console.log(line); } catch {}
  try {
    try { if (fs.statSync(LOG_FILE).size > 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old'); } catch {}
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {}
}

// 압축을 풀었더니 폴더 하나만 있으면 그 안을 프로젝트로 본다
function unwrapSingleFolder(dir) {
  const ents = fs.readdirSync(dir, { withFileTypes: true }).filter(e => !e.name.startsWith('__MACOSX'));
  if (ents.length === 1 && ents[0].isDirectory()) return path.join(dir, ents[0].name);
  return dir;
}

module.exports = { logLine, DIRS, sleep, readJSON, writeJSON, kst, safeJoin, cleanName, run, hasCommand, unzip, zipDir, listAll, copyDir, unwrapSingleFolder };
