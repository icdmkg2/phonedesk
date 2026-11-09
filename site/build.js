'use strict';
// Builds the website into site/dist (published to GitHub Pages by .github/workflows/pages.yml).
//   node site/build.js
// No dependencies: the pages are templates filled from package.json and CHANGELOG.md, and the
// screenshots are the ones in docs/changelog (served from /shots).
const fs = require('fs');
const path = require('path');
const changelog = require('../server/changelog');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'dist');
const version = require('../package.json').version;
const all = changelog.sections(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'));
const esc = changelog.esc;

// docs/changelog/1.8.0/x.png -> shots/1.8.0/x.png (local copies); other links go to GitHub.
const opts = {
  ref: 'main',
  imgUrl(u) { const m = /^(?:\.\/)?docs\/changelog\/([\w./-]+)$/.exec(u); return m ? 'shots/' + m[1] : /^https?:/.test(u) ? u : ''; },
  linkUrl(u) {
    if (/^https?:\/\//.test(u)) return u;
    if (/^[\w./-]+$/.test(u) && !u.includes('..')) return `https://github.com/${changelog.REPO}/blob/main/${u.replace(/^\.?\//, '')}`;
    return '';
  },
};

function firstPara(md) {
  const p = md.split(/\n\s*\n/).find((b) => b.trim() && !/^#|^-|^!|^</.test(b.trim()));
  return p ? p.replace(/\s+/g, ' ').trim() : '';
}
function firstImage(md) {
  const m = /docs\/changelog\/([\w./-]+\.png)/.exec(md);
  return m ? 'shots/' + m[1] : '';
}
function plain(md) { return md.replace(/\*\*|`|\*/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); }

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

function fillTemplate(file, vars) {
  let s = fs.readFileSync(path.join(__dirname, file), 'utf8');
  for (const [k, v] of Object.entries(vars)) s = s.split(`{{${k}}}`).join(v);
  const left = /\{\{[A-Z_]+\}\}/.exec(s);
  if (left) throw new Error(`${file}: ${left[0]} was not filled`);
  fs.writeFileSync(path.join(OUT, file), s);
}

// ---------------------------------------------------------------- build
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'assets', 'fonts'), { recursive: true });
copyDir(path.join(__dirname, 'assets'), path.join(OUT, 'assets')); // the taste-skill kit, the changelog page's style.css and main.js
for (const f of ['Inter.woff2']) fs.copyFileSync(path.join(ROOT, 'public', 'dashboard', 'fonts', f), path.join(OUT, 'assets', 'fonts', f));
fs.copyFileSync(path.join(ROOT, 'public', 'favicon.svg'), path.join(OUT, 'assets', 'favicon.svg'));
copyDir(path.join(ROOT, 'docs', 'changelog'), path.join(OUT, 'shots'));
copyDir(path.join(__dirname, 'img'), path.join(OUT, 'img')); // web-sized copies for the home page (make-images.py)
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');
fs.copyFileSync(path.join(__dirname, 'share.jpg'), path.join(OUT, 'share.jpg')); // the hero's tile from shoot.mjs, for link previews

const latest = all.find((s) => s.version === version) || all[0];
const headline = plain(firstPara(latest.md)).replace(/\.$/, '');

const recent = all.slice(0, 3).map((s) => {
  const img = firstImage(s.md);
  return `      <a class="ver-card" href="changelog.html#v${s.version.replace(/\./g, '-')}">
        <span class="v">${esc(s.version)}</span><span class="d">${esc(s.date)}</span>
        <p>${esc(plain(firstPara(s.md)) || 'Fixes and improvements.')}</p>
        ${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ''}
      </a>`;
}).join('\n');

const toc = all.map((s, i) => `      <a href="#v${s.version.replace(/\./g, '-')}">${esc(s.version)}${i === 0 ? ' <small>latest</small>' : ''}</a>`).join('\n');
const releases = all.map((s, i) => `      <article class="release" id="v${s.version.replace(/\./g, '-')}">
        <div class="rel-head"><h2>${esc(s.version)}</h2><span class="date">${esc(s.date)}</span>${i === 0 ? '<span class="tag">Latest</span>' : ''}<a class="link" href="https://github.com/${changelog.REPO}/releases/tag/v${esc(s.version)}">GitHub release</a></div>
        <div class="notes">${changelog.render(s.md, opts)}</div>
      </article>`).join('\n');

const common = { VERSION: esc(version), VERSION_COUNT: String(all.length) };
fillTemplate('index.html', Object.assign({}, common, { HEADLINE: esc(headline.length > 60 ? headline.slice(0, 58).replace(/\s+\S*$/, '') + '…' : headline), RECENT: recent }));
fillTemplate('changelog.html', Object.assign({}, common, { TOC: toc, RELEASES: releases }));

// Every image the pages use must exist.
const missing = [];
for (const f of ['index.html', 'changelog.html']) {
  const html = fs.readFileSync(path.join(OUT, f), 'utf8');
  for (const m of html.matchAll(/src="([^"]+)"/g)) {
    if (/^https?:/.test(m[1])) continue;
    if (!fs.existsSync(path.join(OUT, m[1].split('?')[0]))) missing.push(`${f}: ${m[1]}`);
  }
}
if (missing.length) { console.error('Missing files:\n  ' + missing.join('\n  ')); process.exit(1); }
console.log(`Built site/dist for PhoneDesk ${version} (${all.length} versions)`);
