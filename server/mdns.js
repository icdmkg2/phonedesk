'use strict';
// Minimal mDNS responder: answers "phonedesk.local" (or a custom name) with this PC's LAN IP.
// That way phones can always reach the PC by name, even when the router hands it a new IP.
// No router setup, nothing exposed to the internet. Also publishes an _http._tcp service so
// network browsers / apps that do DNS-SD can discover it.
const dgram = require('dgram');
const os = require('os');
const log = require('./log');

const GROUP = '224.0.0.251';
const PORT = 5353;
const TTL = 120;

let sock = null;
let name = 'phonedesk.local';
let httpPort = 80;
let ifaceTimer = null;
let joined = new Set();

function lanInterfaces() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const n of Object.keys(ifs)) {
    if (/vethernet|virtualbox|vmware|docker|wsl|hyper-v|loopback/i.test(n)) continue;
    for (const a of ifs[n] || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.') || a.address.startsWith('192.168.56.')) continue;
      out.push({ address: a.address, netmask: a.netmask });
    }
  }
  return out;
}

const ipToInt = (ip) => ip.split('.').reduce((n, o) => (n << 8) + (+o), 0) >>> 0;
function sameSubnet(a, b, mask) { const m = ipToInt(mask); return (ipToInt(a) & m) === (ipToInt(b) & m); }

// ---------------------------------------------------------------- DNS wire format
function readName(buf, off) {
  const labels = [];
  let jumped = false, end = off, guard = 0;
  while (guard++ < 64) {
    const len = buf[off];
    if (len === undefined) throw new Error('bad name');
    if (len === 0) { if (!jumped) end = off + 1; break; }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) end = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1];
      jumped = true;
      continue;
    }
    labels.push(buf.toString('utf8', off + 1, off + 1 + len));
    off += 1 + len;
  }
  return { name: labels.join('.'), end };
}

function encodeName(n) {
  const parts = n.split('.').filter(Boolean);
  const bufs = parts.map((p) => { const b = Buffer.from(p, 'utf8'); return Buffer.concat([Buffer.from([b.length]), b]); });
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

let legacy = false; // building a reply for a one-shot (non-5353) resolver: no cache-flush bit, short TTL
function rr(rname, type, data, cacheFlush = true) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(cacheFlush && !legacy ? 0x8001 : 0x0001, 2); // class IN (+ cache-flush bit for unique records)
  head.writeUInt32BE(legacy ? 10 : TTL, 4);
  head.writeUInt16BE(data.length, 8);
  return Buffer.concat([encodeName(rname), head, data]);
}

function buildResponse(id, answers, question, additional = []) {
  const h = Buffer.alloc(12);
  h.writeUInt16BE(id, 0);
  h.writeUInt16BE(0x8400, 2); // response, authoritative
  // One-shot resolvers (Android, nslookup, ...) validate that the reply repeats their question
  // (RFC 6762 section 6.7), otherwise they drop it.
  if (question) h.writeUInt16BE(question.count, 4);
  h.writeUInt16BE(answers.length, 6);
  h.writeUInt16BE(additional.length, 10);
  return Buffer.concat([h, ...(question ? [question.bytes] : []), ...answers, ...additional]);
}

// "This name has an A record and nothing else" (RFC 6762 section 6.1). Lets IPv6 lookups fail fast
// instead of waiting for a timeout, which is what made browsers hang on the .local name.
function nsecRecord() { return rr(name, 47, Buffer.concat([encodeName(name), Buffer.from([0, 1, 0x40])])); }

function aRecord(ip) { return rr(name, 1, Buffer.from(ip.split('.').map(Number))); }

function serviceRecords(ip) {
  const inst = 'PhoneDesk._http._tcp.local';
  const srv = Buffer.alloc(6);
  srv.writeUInt16BE(0, 0); srv.writeUInt16BE(0, 2); srv.writeUInt16BE(httpPort, 4);
  const txt = Buffer.from('\x05path=');
  return [
    rr('_http._tcp.local', 12, encodeName(inst), false), // PTR
    rr(inst, 33, Buffer.concat([srv, encodeName(name)])), // SRV
    rr(inst, 16, txt), // TXT
    aRecord(ip),
  ];
}

// ---------------------------------------------------------------- responder
function onMessage(msg, rinfo) {
  if (msg.length < 12) return;
  const flags = msg.readUInt16BE(2);
  if (flags & 0x8000) return; // a response, not a query
  const qd = msg.readUInt16BE(4);
  let off = 12;
  const wanted = [];
  try {
    for (let i = 0; i < qd; i++) {
      const q = readName(msg, off);
      const type = msg.readUInt16BE(q.end);
      const cls = msg.readUInt16BE(q.end + 2);
      off = q.end + 4;
      wanted.push({ name: q.name.toLowerCase(), type, unicast: !!(cls & 0x8000) });
    }
  } catch { return; }

  const ifaces = lanInterfaces();
  // Answer with the address on the same subnet as whoever asked.
  const iface = ifaces.find((i) => sameSubnet(i.address, rinfo.address, i.netmask)) || ifaces[0];
  if (!iface) return;

  legacy = rinfo.port !== PORT; // legacy one-shot resolvers want a direct unicast reply
  const answers = [];
  const additional = [];
  let unicast = legacy;
  for (const q of wanted) {
    if (q.name === name && (q.type === 1 || q.type === 255)) { answers.push(aRecord(iface.address)); unicast = unicast || q.unicast; }
    else if (q.name === name) {
      // Any other type (usually AAAA): we have no such record. Say so, and hand over the A record.
      unicast = unicast || q.unicast;
      if (legacy) { if (!additional.length) additional.push(aRecord(iface.address)); }
      else { answers.push(nsecRecord()); additional.push(aRecord(iface.address)); }
    }
    else if (q.name === '_http._tcp.local' && (q.type === 12 || q.type === 255)) answers.push(...serviceRecords(iface.address));
    else if (q.name === 'phonedesk._http._tcp.local') answers.push(...serviceRecords(iface.address).slice(1));
  }
  if (!answers.length && !additional.length) { legacy = false; return; }
  // Legacy unicast queries need the original id and question echoed back.
  const pkt = legacy
    ? buildResponse(msg.readUInt16BE(0), answers, { count: qd, bytes: msg.slice(12, off) }, additional)
    : buildResponse(0, answers, null, additional);
  legacy = false;
  try {
    if (unicast) sock.send(pkt, rinfo.port, rinfo.address);
    else { sock.setMulticastInterface(iface.address); sock.send(pkt, PORT, GROUP); }
  } catch {}
}

function joinAll() {
  if (!sock) return;
  const now = new Set(lanInterfaces().map((i) => i.address));
  for (const addr of now) {
    if (joined.has(addr)) continue;
    try { sock.addMembership(GROUP, addr); joined.add(addr); announce(addr); } catch {}
  }
  for (const addr of [...joined]) {
    if (!now.has(addr)) { try { sock.dropMembership(GROUP, addr); } catch {} joined.delete(addr); }
  }
}

// Tell the network about us right away (and when the IP changes) so caches update.
function announce(addr) {
  if (!sock) return;
  const pkt = buildResponse(0, [aRecord(addr)]);
  const send = () => { try { sock.setMulticastInterface(addr); sock.send(pkt, PORT, GROUP); } catch {} };
  send();
  setTimeout(send, 1000);
}

module.exports = {
  start(opts) {
    name = (String(opts.name || 'phonedesk').toLowerCase().replace(/\.local$/, '').replace(/[^a-z0-9-]/g, '') || 'phonedesk') + '.local';
    httpPort = opts.port || 80;
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (e) => { log.warn('mDNS unavailable: ' + e.message); try { sock.close(); } catch {} sock = null; });
    sock.on('message', onMessage);
    sock.bind(PORT, () => {
      try { sock.setMulticastTTL(255); sock.setMulticastLoopback(true); } catch {}
      joinAll();
      log.info(`Phone (by name): http://${name}${httpPort === 80 ? '' : ':' + httpPort}`);
    });
    // Watch for network changes (laptop moves networks, DHCP gives a new IP).
    ifaceTimer = setInterval(joinAll, 10000);
    ifaceTimer.unref();
  },
  stop() {
    clearInterval(ifaceTimer);
    if (sock) { try { sock.close(); } catch {} sock = null; }
    joined = new Set();
  },
  name: () => name,
};
