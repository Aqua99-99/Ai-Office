// 신입 담당: 새 프로젝트를 스스로 살펴보고 규칙(부서 정보)을 만들어요
'use strict';
const fs = require('fs');
const path = require('path');
const { listAll } = require('./util');
const llm = require('./llm');

const SKIP_DIRS = /(^|[\\/])(node_modules|\.git|vendor|vender|third_party|dist|build|\.next|\.cache|__pycache__|venv|\.venv|coverage)([\\/]|$)/i;
const BIN_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|svgz|mp3|mp4|wav|ogg|webm|mov|zip|gz|7z|rar|pdf|onnx|wasm|bin|pt|pth|safetensors|gguf|ttf|otf|woff2?|eot|exe|dll|so|dylib|traineddata|db|sqlite)$/i;
const TEXT_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|html?|css|scss|json|md|txt|py|java|kt|go|rs|rb|php|c|h|cpp|hpp|cs|sh|bat|ps1|yml|yaml|toml|ini|sql|vue|svelte|xml|webmanifest)$/i;
const SECRET_NAME = /(^|[\\/])(\.env(\..*)?|config\.(js|json|ts)|secrets?\.[a-z]+|credentials?\.[a-z]+|.*\.pem|.*\.key|id_rsa.*)$/i;
const SECRET_TEXT = /(api[_-]?key|secret|password|passwd|token|private[_-]?key|SUPABASE_ANON_KEY|SERVICE_ROLE)\s*[:=]\s*['"][^'"]{12,}['"]/i;

function rel(base, p) { return path.relative(base, p).split(path.sep).join('/'); }

// 사람·AI 없이 확실하게 알 수 있는 것부터 조사
function scan(dir) {
  const files = listAll(dir).map(p => {
    const r = rel(dir, p);
    let size = 0; try { size = fs.statSync(p).size; } catch {}
    return { path: r, size };
  });
  const protect = new Set(), work = [], lib = [];
  for (const f of files) {
    if (SKIP_DIRS.test(f.path) || /\.min\.(js|css)$/i.test(f.path)) { lib.push(f.path); continue; }
    if (BIN_EXT.test(f.path)) continue;
    if (!TEXT_EXT.test(f.path) || f.size > 1.5e6) continue;
    let secret = SECRET_NAME.test(f.path);
    if (!secret && f.size < 300000) {
      try { secret = SECRET_TEXT.test(fs.readFileSync(path.join(dir, f.path), 'utf8')); } catch {}
    }
    if (secret) { protect.add(f.path); continue; }
    work.push(f.path);
  }
  // 외부 라이브러리 폴더는 통째로 보호
  const libDirs = new Set(lib.map(p => { const m = p.match(SKIP_DIRS); return m ? p.slice(0, p.indexOf(m[2]) + m[2].length) : p; }));
  for (const d of libDirs) protect.add(d);

  const has = re => files.some(f => re.test(f.path));
  const type = [];
  if (has(/(^|\/)package\.json$/)) type.push('Node.js');
  if (has(/\.html?$/)) type.push('웹 페이지');
  if (has(/\.py$/)) type.push('Python');
  if (has(/(^|\/)sw\.js$|manifest\.webmanifest$/)) type.push('PWA');
  if (has(/\.(java|kt)$/)) type.push('Java/Kotlin');

  // 자동 시험 거리
  const checks = [];
  if (work.some(p => /\.(js|mjs|cjs)$/.test(p))) checks.push({ kind: 'node-check', label: 'JS 문법 검사' });
  if (work.some(p => /\.json$/.test(p))) checks.push({ kind: 'json', label: 'JSON 형식 검사' });
  if (work.some(p => /\.py$/.test(p))) checks.push({ kind: 'py-compile', label: 'Python 문법 검사' });
  if (work.some(p => /\.html?$/.test(p))) checks.push({ kind: 'html', label: 'HTML 태그 짝 검사' });
  // 프로젝트에 들어 있는 시험 (실행은 사용자가 허용해야 해요)
  const projectTests = [];
  const pkgPath = files.find(f => /(^|\/)package\.json$/.test(f.path) && !SKIP_DIRS.test(f.path));
  if (pkgPath) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, pkgPath.path), 'utf8'));
      if (pkg.scripts && pkg.scripts.test && !/no test specified/.test(pkg.scripts.test)) projectTests.push({ cmd: 'npm', args: ['test', '--silent'], cwd: path.dirname(pkgPath.path), label: 'npm test' });
    } catch {}
  }
  for (const f of work) {
    if (/(^|\/)tests?\/.*\.(js|mjs)$/.test(f) || /\.test\.(js|mjs)$/.test(f)) projectTests.push({ cmd: 'node', args: [f], cwd: '.', label: 'node ' + f, needsArg: /sync-test/.test(f) });
  }
  // 서비스 워커 캐시 번호 (배포 담당이 올려요)
  const release = [];
  for (const f of work) {
    if (!/(^|\/)(sw|service-worker)\.js$/.test(f)) continue;
    try {
      const t = fs.readFileSync(path.join(dir, f), 'utf8');
      const m = t.match(/(['"][\w.-]*-v)(\d+)(['"])/);
      if (m) release.push({ kind: 'bump-cache', file: f, pattern: m[0] });
    } catch {}
  }
  // 시험 코드는 AI가 고치지 못하게 따로 표시 (시험을 고쳐서 통과시키는 꼼수 방지)
  const tests = work.filter(f => /(^|\/)(tests?|__tests__|spec)\//.test(f) || /\.(test|spec)\.[a-z]+$/.test(f));
  const readme = files.find(f => /(^|\/)readme(\.md|\.txt)?$/i.test(f.path));
  return { files: files.length, type, work, tests, protect: [...protect], checks, projectTests, release, readme: readme && readme.path };
}

// 마지막으로 AI가 한 줄 소개와 주요 기능을 정리 (실패해도 괜찮아요)
async function describe(dir, info, chat) {
  let src = '';
  if (info.readme) { try { src = fs.readFileSync(path.join(dir, info.readme), 'utf8').slice(0, 3500); } catch {} }
  const tree = info.work.slice(0, 80).join('\n');
  try {
    const r = await chat(
      'You analyze a software project for a team of AI workers. Reply in JSON only: {"summary": "one Korean sentence describing the project", "features": ["Korean short phrase", ...up to 8], "cautions": ["Korean short phrase about what to be careful with", ...up to 4]}',
      `Project type hints: ${info.type.join(', ') || 'unknown'}\n\nFiles:\n${tree}\n\nREADME (may be empty):\n${src}`,
      { json: true, ctx: 6144 });
    const d = r.data || {};
    return {
      summary: typeof d.summary === 'string' ? d.summary.slice(0, 200) : '',
      features: Array.isArray(d.features) ? d.features.filter(x => typeof x === 'string').slice(0, 8) : [],
      cautions: Array.isArray(d.cautions) ? d.cautions.filter(x => typeof x === 'string').slice(0, 4) : [],
    };
  } catch { return { summary: '', features: [], cautions: [] }; }
}

function profileMarkdown(name, info, desc) {
  const L = [];
  L.push(`# 부서: ${name}`, '');
  L.push('<!-- 신입 담당이 자동으로 만든 규칙이에요. 화면의 "규칙 보기"에서 고칠 수 있어요. -->', '');
  L.push('## 프로젝트', `- 종류: ${info.type.join(', ') || '알 수 없음'}`, `- 소개: ${desc.summary || '(AI가 소개를 쓰지 못했어요)'}`, `- 파일: 전체 ${info.files}개, 팀이 다룰 파일 ${info.work.length}개`, '');
  if (desc.features.length) { L.push('## 주요 기능'); desc.features.forEach(f => L.push('- ' + f)); L.push(''); }
  L.push('## 건드리지 않을 파일 (비밀 키·외부 라이브러리)');
  info.protect.length ? info.protect.forEach(p => L.push('- `' + p + '`')) : L.push('- 없음');
  L.push('');
  L.push('## 자동 시험');
  info.checks.forEach(c => L.push('- ' + c.label));
  if (info.projectTests.length) { L.push('- 프로젝트에 들어 있는 시험 (실행 허용이 필요해요):'); info.projectTests.forEach(t => L.push('  - `' + t.label + '`')); }
  L.push('');
  if (info.release.length) { L.push('## 배포 규칙'); info.release.forEach(r => L.push(`- \`${r.file}\`의 캐시 번호를 바뀔 때마다 1 올려요`)); L.push(''); }
  if (desc.cautions.length) { L.push('## 조심할 점'); desc.cautions.forEach(c => L.push('- ' + c)); L.push(''); }
  return L.join('\n');
}

module.exports = { scan, describe, profileMarkdown };
