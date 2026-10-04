// ZIP 풀기/만들기를 프로그램이 직접 해요 (Windows 도구에 기대지 않아요)
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const tick = () => new Promise(r => setImmediate(r)); // 화면이 멈추지 않게 잠깐씩 숨 돌리기

// CRC32 (Node에 있으면 그걸 쓰고, 없으면 직접 계산)
let CRC_TABLE = null;
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  if (!CRC_TABLE) { CRC_TABLE = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c >>> 0; } }
  let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 파일 이름 읽기: UTF-8 표시가 없고 깨지면 한국어 Windows 방식(CP949)으로 읽어요
let cp949 = null;
function decodeName(buf, utf8Flag) {
  if (utf8Flag) return buf.toString('utf8');
  if (!buf.some(b => b > 0x7f)) return buf.toString('latin1');
  const u = buf.toString('utf8');
  if (!u.includes('�')) return u;
  try { cp949 = cp949 || new TextDecoder('euc-kr'); return cp949.decode(buf); } catch { return u; }
}

function readEntries(buf) {
  // 끝에서 '중앙 목록' 위치 찾기
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 파일이 아니거나 깨졌어요');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error('너무 큰 ZIP(ZIP64)은 아직 못 열어요. 4GB보다 작게 나눠 주세요.');
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 목록이 깨졌어요');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const extAttr = buf.readUInt32LE(p + 38), lho = buf.readUInt32LE(p + 42);
    const name = decodeName(buf.subarray(p + 46, p + 46 + nlen), (flags & 0x800) !== 0);
    out.push({ name, flags, method, csize, usize, lho, isLink: ((extAttr >>> 16) & 0o170000) === 0o120000 });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

// ZIP 풀기. onProgress(0~100). 폴더 밖으로 나가는 이름·링크는 건너뛰어요.
async function extract(zipPath, dest, onProgress) {
  const buf = await fs.promises.readFile(zipPath);
  const entries = readEntries(buf);
  const base = path.resolve(dest);
  await fs.promises.mkdir(base, { recursive: true });
  let skipped = 0, total = 0;
  for (const e of entries) total += e.usize || 1;
  let done = 0, last = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const rel = e.name.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel || rel.startsWith('__MACOSX/') || e.isLink || (e.flags & 1)) { skipped++; continue; } // 암호 ZIP·링크는 건너뜀
    const full = path.resolve(base, rel);
    if (full !== base && !full.startsWith(base + path.sep)) { skipped++; continue; }
    if (rel.endsWith('/')) { await fs.promises.mkdir(full, { recursive: true }); continue; }
    const h = e.lho;
    if (buf.readUInt32LE(h) !== 0x04034b50) throw new Error('ZIP 안의 파일이 깨졌어요: ' + rel);
    const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
    const raw = buf.subarray(start, start + e.csize);
    let data;
    if (e.method === 0) data = raw;
    else if (e.method === 8) data = await new Promise((res, rej) => zlib.inflateRaw(raw, (err, d) => err ? rej(err) : res(d)));
    else { skipped++; continue; }
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, data);
    done += e.usize || 1;
    const pct = Math.floor(done / total * 100);
    if (pct !== last) { last = pct; onProgress && onProgress(pct); }
    if (i % 20 === 0) await tick();
  }
  return { files: entries.length, skipped };
}

// 폴더를 ZIP으로 만들기 (이름은 UTF-8로 표시해서 한글도 안 깨져요)
async function create(srcDir, zipPath) {
  const files = [];
  const walk = async d => {
    for (const e of await fs.promises.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p); else if (e.isFile()) files.push(p);
    }
  };
  await walk(srcDir);
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (let i = 0; i < files.length; i++) {
    const rel = path.relative(srcDir, files[i]).split(path.sep).join('/');
    const name = Buffer.from(rel, 'utf8');
    const data = await fs.promises.readFile(files[i]);
    const comp = await new Promise((res, rej) => zlib.deflateRaw(data, { level: 6 }, (err, d) => err ? rej(err) : res(d)));
    const useComp = comp.length < data.length;
    const body = useComp ? comp : data, method = useComp ? 8 : 0, crc = crc32(data);
    if (offset + 30 + name.length + body.length > 0xfffffff0) throw new Error('결과물이 너무 커서 ZIP을 만들 수 없어요');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + body.length;
    if (i % 20 === 0) await tick();
  }
  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(offset, 16);
  await fs.promises.mkdir(path.dirname(zipPath), { recursive: true });
  await fs.promises.writeFile(zipPath, Buffer.concat([...parts, ...central, end]));
  return files.length;
}

module.exports = { extract, create, crc32 };
