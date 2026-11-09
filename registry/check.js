#!/usr/bin/env node
'use strict';
// Checks registry/index.json: the entries are well formed, every download exists, matches its checksum, and the
// package says the same thing as its listing (id, version, permissions). Run by CI on pull requests.
//   node registry/check.js            checks everything, downloading third-party packages from GitHub
//   node registry/check.js --offline  checks the entries and the packages in this repository only
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateRegistryEntry, readPackage, cmpVer } = require('../server/addons');

const INDEX = path.join(__dirname, 'index.json');
const RAW = 'https://raw.githubusercontent.com/icdmkg2/phonedesk/main/registry/packages/';
const offline = process.argv.includes('--offline');
const problems = [];
const bad = (id, msg) => problems.push(`${id}: ${msg}`);

(async () => {
  let index;
  try { index = JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch (e) { console.error('index.json: ' + e.message); process.exit(1); }
  if (!index || !Array.isArray(index.addons)) { console.error('index.json needs an "addons" list'); process.exit(1); }
  const seen = new Set();
  for (const raw of index.addons) {
    const id = (raw && raw.id) || '(no id)';
    let e;
    try { e = validateRegistryEntry(raw); } catch (err) { bad(id, err.message); continue; }
    if (seen.has(e.id)) bad(id, 'listed twice');
    seen.add(e.id);
    // one version of each addon is listed; the listing and the file it points to must agree
    let buf = null;
    if (e.download.startsWith(RAW)) {
      const f = path.join(__dirname, 'packages', e.download.slice(RAW.length));
      if (!/^[\w.-]+\.zip$/.test(e.download.slice(RAW.length)) || !fs.existsSync(f)) { bad(id, 'the package is not in registry/packages: ' + e.download.slice(RAW.length)); continue; }
      buf = fs.readFileSync(f);
    } else {
      if (raw.firstParty) { bad(id, '"firstParty" is only for packages kept in registry/packages'); continue; }
      if (offline) continue;
      try {
        const res = await fetch(e.download, { headers: { 'User-Agent': 'PhoneDesk-registry-check' }, signal: AbortSignal.timeout(60000) });
        if (!res.ok) { bad(id, 'download failed: HTTP ' + res.status); continue; }
        buf = Buffer.from(await res.arrayBuffer());
      } catch (err) { bad(id, 'download failed: ' + err.message); continue; }
    }
    if (buf.length > 20 * 1024 * 1024) { bad(id, 'the package is over 20 MB'); continue; }
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    if (sha !== e.sha256) { bad(id, `sha256 does not match the download (listing ${e.sha256.slice(0, 12)}…, file ${sha.slice(0, 12)}…)`); continue; }
    let pkg;
    try { pkg = readPackage(buf); } catch (err) { bad(id, 'the package is not valid: ' + err.message); continue; }
    const m = pkg.manifest;
    if (m.id !== e.id) bad(id, `the package is "${m.id}", not "${e.id}"`);
    if (m.version !== e.version) bad(id, `the package is version ${m.version}, the listing says ${e.version}`);
    const listed = [...e.permissions].sort().join(','), actual = [...m.permissions].sort().join(',');
    if (listed !== actual) bad(id, `permissions differ: the listing says [${listed}], the package asks for [${actual}]`);
    if (cmpVer(m.phonedesk, e.phonedesk) !== 0) bad(id, `"phonedesk" differs: listing ${e.phonedesk}, package ${m.phonedesk}`);
    if (!problems.some((p) => p.startsWith(id + ':'))) console.log(`ok  ${e.id} ${e.version}  ${e.permissions.length ? e.permissions.join(', ') : 'no permissions'}`);
  }
  if (problems.length) { console.error('\n' + problems.map((p) => 'FAIL ' + p).join('\n')); process.exit(1); }
  console.log(`\n${index.addons.length} addon${index.addons.length === 1 ? '' : 's'} listed, all good.`);
})();
