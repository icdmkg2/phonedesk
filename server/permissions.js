'use strict';
// What an addon may ask for, in plain words (shown to people before install and on the website), and the
// checks that go with it. No dependencies, so the website build can use it too.

// What an addon may ask for. Shown to the user before install; the PC-side API checks them on every call.
const PERMISSIONS = {
  media: { label: 'Read what is playing', level: 'low' },
  volume: { label: 'Read the PC\'s volume', level: 'low' },
  stats: { label: 'Read CPU, memory and GPU use', level: 'low' },
  control: { label: 'Control playback and volume', level: 'medium' },
  keys: { label: 'Press keys on the PC', level: 'high' },
  run: { label: 'Run programs on the PC', level: 'high' },
};
const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
function permissionInfo(p) {
  if (PERMISSIONS[p]) return Object.assign({ id: p }, PERMISSIONS[p]);
  if (p === 'network:lan') return { id: p, label: 'Talk to devices on your home network', detail: 'Addresses like 192.168.x.x, 10.x.x.x or names ending in .local.', level: 'high' };
  const m = /^network:(.+)$/.exec(p);
  if (m && HOST_RE.test(m[1])) return { id: p, label: 'Talk to ' + m[1] + ' over the internet or your network', level: 'high' };
  return null;
}
/** A home-network address: private IPv4 ranges, localhost, or a .local name. */
function isLan(host) {
  if (host === 'localhost' || host === '127.0.0.1' || host.endsWith('.local')) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [+m[1], +m[2]];
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
/** May this host be contacted with the granted permissions? (network:example.com, network:*.example.com) */
function hostAllowed(perms, host) {
  host = String(host).toLowerCase();
  return perms.some((p) => {
    const m = /^network:(.+)$/.exec(p);
    if (!m) return false;
    if (m[1] === 'lan') return isLan(host);
    return m[1].startsWith('*.') ? host.endsWith(m[1].slice(1)) && host.length > m[1].length - 1 : host === m[1];
  });
}


module.exports = { PERMISSIONS, permissionInfo, hostAllowed, isLan, HOST_RE };
