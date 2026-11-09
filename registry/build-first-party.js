#!/usr/bin/env node
'use strict';
// Packs the addons in examples/addons into registry/packages and lists them in registry/index.json
// (as "firstParty"). Entries from other authors in index.json are left alone.   node registry/build-first-party.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { zip } = require('../server/zip');
const { validateManifest } = require('../server/addons');

const ROOT = path.join(__dirname, '..');
const EXAMPLES = path.join(ROOT, 'examples', 'addons');
const PACKAGES = path.join(__dirname, 'packages');
const INDEX = path.join(__dirname, 'index.json');
const RAW = 'https://raw.githubusercontent.com/icdmkg2/phonedesk/main/registry/packages/';

function readDir(dir) {
  const files = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(full, r); else if (e.isFile()) files.push({ name: r, data: fs.readFileSync(full) });
    }
  };
  walk(dir, '');
  return files.sort((a, b) => (a.name < b.name ? -1 : 1));
}

let index = { schema: 1, addons: [] };
try { index = JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch {}
const others = (index.addons || []).filter((e) => !e.firstParty);
const mine = [];
fs.mkdirSync(PACKAGES, { recursive: true });

for (const name of fs.readdirSync(EXAMPLES)) {
  const dir = path.join(EXAMPLES, name);
  if (!fs.statSync(dir).isDirectory()) continue;
  const files = readDir(dir);
  const m = validateManifest(JSON.parse(files.find((f) => f.name === 'addon.json').data.toString('utf8')), files);
  const buf = zip(files, new Date(2026, 0, 1));
  const file = `${m.id}-${m.version}.zip`;
  for (const old of fs.readdirSync(PACKAGES)) if (old.startsWith(m.id + '-') && old !== file && /^\d/.test(old.slice(m.id.length + 1))) fs.rmSync(path.join(PACKAGES, old));
  fs.writeFileSync(path.join(PACKAGES, file), buf);
  mine.push({
    id: m.id, name: m.name, version: m.version, author: m.author, description: m.description, homepage: m.homepage,
    download: RAW + file, sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    permissions: m.permissions, phonedesk: m.phonedesk, tags: [m.screen ? 'screen' : null, m.server ? 'pc' : null, m.actions.length ? 'actions' : null].filter(Boolean), firstParty: true,
  });
  console.log(`${m.id} ${m.version}  ${file}`);
}
index.addons = mine.concat(others).sort((a, b) => (a.id < b.id ? -1 : 1));
fs.writeFileSync(INDEX, JSON.stringify(index, null, 2) + '\n');
