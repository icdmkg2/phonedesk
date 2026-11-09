'use strict';
// A small zip reader and writer (deflate/stored, no ZIP64, no encryption), with no dependencies.
// Used for addon packages and for the diagnostics bundle. The reader is strict: it is given untrusted files.
const zlib = require('zlib');

/* ---------------------------------------------------------------- writer */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
/** files: [{ name, data: Buffer|string }] -> Buffer (a .zip) */
function zip(files) {
  const now = dosTime(new Date());
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(now.time, 10); lh.writeUInt16LE(now.date, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(now.time, 12); ch.writeUInt16LE(now.date, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}


/* ---------------------------------------------------------------- reader */
const LIMITS = { entries: 2000, file: 10 * 1024 * 1024, total: 50 * 1024 * 1024 };

/** A safe relative path inside the package, or null (absolute, drive letters, "..", backslashes, control characters). */
function safeName(n) {
  if (!n || n.length > 200 || /[\\\u0000-\u001f:]/.test(n) || n.startsWith('/')) return null;
  const parts = n.split('/').filter((p, i, a) => p !== '' || i === a.length - 1);
  if (parts.some((p) => p === '..' || p === '.')) return null;
  return parts.join('/');
}

/**
 * zip Buffer -> [{ name, data: Buffer }] (files only). Throws on anything odd: encrypted entries, ZIP64,
 * unsafe names, sizes that do not match, a bad CRC, or more than the limits above.
 */
function unzip(buf, limits) {
  const lim = Object.assign({}, LIMITS, limits);
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('not a zip file');
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(end + 10), cdSize = buf.readUInt32LE(end + 12), cdOff = buf.readUInt32LE(end + 16);
  if (count === 0xffff || cdOff === 0xffffffff) throw new Error('ZIP64 files are not supported');
  if (count > lim.entries) throw new Error('too many files in the zip');
  if (cdOff + cdSize > buf.length) throw new Error('the zip is damaged');
  const out = [], seen = new Set();
  let p = cdOff, total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('the zip is damaged');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const rawName = buf.toString('utf8', p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (rawName.endsWith('/')) continue; // a folder
    if (flags & 1) throw new Error('encrypted zips are not supported');
    const name = safeName(rawName);
    if (!name) throw new Error('unsafe file name in the zip: ' + rawName.slice(0, 60));
    if (seen.has(name.toLowerCase())) throw new Error('the same file is in the zip twice: ' + name);
    seen.add(name.toLowerCase());
    if (usize > lim.file) throw new Error(name + ' is too large');
    total += usize;
    if (total > lim.total) throw new Error('the zip is too large when unpacked');
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('the zip is damaged');
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (start + csize > buf.length) throw new Error('the zip is damaged');
    const comp = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp, { maxOutputLength: lim.file });
    else throw new Error('unsupported compression in the zip');
    if (data.length !== usize || crc32(data) !== crc) throw new Error(name + ' is damaged');
    out.push({ name, data });
  }
  return out;
}

module.exports = { zip, unzip, crc32, safeName, LIMITS };
