'use strict';
// Builds the website into site/dist (hosted by Dokploy, see site/Dockerfile).
//   node site/build.js
// No dependencies: the pages are templates filled from package.json and CHANGELOG.md, and the
// screenshots are the ones in docs/changelog (served from /shots).
const fs = require('fs');
const path = require('path');
const changelog = require('../server/changelog');
const docs = require('./docs');
const { permissionInfo } = require('../server/permissions');

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


// Screenshots get their real width and height, so the layout does not shift while they load lazily
// (a shift above the target would stop a jump to an old version short).
const dimCache = {};
function pngSize(rel) {
  if (!(rel in dimCache)) {
    dimCache[rel] = null;
    try {
      const fd = fs.openSync(path.join(ROOT, 'docs', 'changelog', rel), 'r');
      const b = Buffer.alloc(24); fs.readSync(fd, b, 0, 24, 0); fs.closeSync(fd);
      if (b.toString('latin1', 1, 4) === 'PNG') dimCache[rel] = [b.readUInt32BE(16), b.readUInt32BE(20)];
    } catch { /* leave it without */ }
  }
  return dimCache[rel];
}
function withDims(html) {
  return html.replace(/<img src="shots\/([\w./-]+)"/g, (m, rel) => { const d = pngSize(rel); return d ? `${m} width="${d[0]}" height="${d[1]}"` : m; });
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
        <div class="notes">${withDims(changelog.render(s.md, opts))}</div>
      </article>`).join('\n');


// ---------------------------------------------------------------- addons: the marketplace and the developer docs
function shell(o) {
  const b = o.base || '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.desc)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(o.title.split(':')[0])}">
<meta property="og:description" content="${esc(o.desc)}">
<meta property="og:image" content="https://phonedesk.orreinis.me/share.jpg">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#07090d">
<link rel="icon" href="${b}assets/favicon.svg" type="image/svg+xml">
<link rel="canonical" href="https://phonedesk.orreinis.me/${o.canon}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,600;12..96,700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${b}assets/site.css">
</head>
<body>
<a class="skip" href="#top">Skip to content</a>
<header class="nav">
  <div class="wrap nav__bar">
    <a class="logo" href="${b || './'}" translate="no"><img src="${b}assets/favicon.svg" alt="" width="28" height="28">PhoneDesk</a>
    <nav class="nav__links" aria-label="Main">
      <a href="${b}./#screens">Screens</a>
      <a href="${b}./#window">On the PC</a>
      <a href="${b}./#setup">Setup</a>
      <a href="${b}./#faq">Questions</a>
      <a href="${b}addons.html"${o.current === 'addons' ? ' aria-current="page"' : ''}>Addons</a>
      <a href="${b}changelog.html">Changelog</a>
    </nav>
    <a class="btn btn--p btn--sm" href="https://github.com/icdmkg2/phonedesk/releases/latest">Download for Windows</a>
  </div>
</header>
${o.main}
<footer class="foot">
  <div class="wrap foot__row">
    <span>&copy; 2026 PhoneDesk · v${esc(version)}</span>
    <nav aria-label="Project">
      <a href="https://github.com/icdmkg2/phonedesk">GitHub</a>
      <a href="https://github.com/icdmkg2/phonedesk/releases">Releases</a>
      <a href="${b}addons.html">Addons</a>
      <a href="${b}changelog.html">Changelog</a>
      <a href="https://github.com/icdmkg2/phonedesk/issues/new/choose">Report a problem</a>
    </nav>
    <span>Lyrics via Spicy Lyrics and LRCLIB, weather via Open-Meteo.</span>
  </div>
</footer>
</body>
</html>
`;
}

let registry = { addons: [] };
try { registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'registry', 'index.json'), 'utf8')); } catch { /* no registry yet */ }
const cards = (registry.addons || []).map((a) => {
  const perms = (a.permissions || []).map(permissionInfo).filter(Boolean);
  const chips = perms.length
    ? perms.map((p) => `<span class="chip${p.level === 'high' ? ' chip--warn' : ''}" title="${esc(p.label)}">${esc(p.label)}</span>`).join('')
    : '<span class="chip">Needs no permissions</span>';
  return `      <article class="addon-card">
        <div><h3>${esc(a.name)}</h3><p class="small">v${esc(a.version)} · ${esc(a.author)}${a.firstParty ? ' · official' : ''}</p></div>
        <p>${esc(a.description)}</p>
        <div class="chips">${chips}</div>
        ${a.homepage ? `<a class="link" href="${esc(a.homepage)}" rel="noopener">Details and source</a>` : ''}
      </article>`;
}).join('\n');
const addonsMain = `
<main id="top" class="cl">
  <div class="wrap">
    <h1>Addons</h1>
    <p class="lead">Add screens and features to PhoneDesk: a Home Assistant panel, a timer, new shortcut actions. ${(registry.addons || []).length} to choose from, and anyone can build one.</p>
    <div class="hero__cta">
      <a class="btn btn--p" href="docs/addons">Build an addon</a>
      <a class="btn btn--g" href="https://github.com/icdmkg2/phonedesk/blob/main/docs/addons/publishing.md" rel="noopener">Publish yours</a>
    </div>
    <div class="addon-grid">
${cards}
    </div>
    <div class="steps" style="margin-top:56px">
      <div class="step"><i>01</i><h3>Open Addons in PhoneDesk</h3><p>In the PhoneDesk window on your PC, pick Addons in the menu. The marketplace is listed there.</p></div>
      <div class="step"><i>02</i><h3>Check what it can do</h3><p>Before anything installs you see every permission the addon asks for, in plain words. You approve them all, or you don’t install it.</p></div>
      <div class="step"><i>03</i><h3>Swipe to it</h3><p>A new screen is one more page on the phone. Turn it on or off, or reorder it, in Phone display.</p></div>
    </div>
    <h2 style="margin-top:72px;font-size:32px">How addons stay safe</h2>
    <div class="faq">
      <div><h3>Reviewed and checked</h3><p>Marketplace listings are reviewed in pull requests, download only from GitHub, and must match their checksum.</p></div>
      <div><h3>Sandboxed screens</h3><p>A screen runs in a sealed frame with no network and no access to the rest of PhoneDesk.</p></div>
      <div><h3>PC code with limits</h3><p>PC-side code runs in its own process, can only touch its own folder, and every powerful call is checked against the permissions you approved.</p></div>
      <div><h3>An honest limit</h3><p>Network access can’t be fully blocked at the system level, so read the permissions and install powerful ones only from authors you trust. <a class="link" href="docs/addons#security">The details</a>.</p></div>
    </div>
  </div>
</main>`;

const DOC_FILES = [['README', 'overview', 'Overview'], ['manifest', 'manifest', 'The manifest'], ['api', 'api', 'The API'], ['security', 'security', 'Security'], ['publishing', 'publishing', 'Publishing']];
const linkMap = Object.fromEntries(DOC_FILES.map(([f, id]) => [f, id]));
const docToc = [], docBody = [];
for (const [file, id] of DOC_FILES) {
  let md = '';
  try { md = fs.readFileSync(path.join(ROOT, 'docs', 'addons', file + '.md'), 'utf8'); } catch { continue; }
  const r = docs.render(md, { id, linkMap });
  docToc.push(`      <a href="#${id}">${esc(r.headings[0] ? r.headings[0].text : id)}</a>`);
  r.headings.filter((h) => h.level === 3).forEach((h) => docToc.push(`      <a class="sub" href="#${h.id}">${esc(h.text)}</a>`));
  docBody.push(`      <section class="doc-sec">\n${r.html}\n      </section>`);
}
const docsMain = `
<main id="top" class="cl">
  <div class="wrap">
    <h1>Build an addon</h1>
    <p class="lead">An addon is a folder with a manifest, a screen for the phone and, if it needs one, code that runs on the PC. Start with <code>node tools/pd-addon.js init my-addon</code>.</p>
    <div class="cl-layout">
      <nav class="cl-toc" aria-label="Contents">
${docToc.join('\n')}
      </nav>
      <div class="doc">
${docBody.join('\n')}
      </div>
    </div>
  </div>
</main>`;
fs.mkdirSync(path.join(OUT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'addons.html'), shell({ title: 'PhoneDesk addons: screens and features made by everyone', desc: 'Add screens and features to PhoneDesk with addons: Home Assistant, timers, shortcut actions. Every permission is shown before anything installs.', canon: 'addons.html', current: 'addons', main: addonsMain }));
fs.writeFileSync(path.join(OUT, 'docs', 'addons.html'), shell({ title: 'Build a PhoneDesk addon: the developer guide', desc: 'How to build, test and publish a PhoneDesk addon: the manifest, the phone and PC APIs, security, and the marketplace.', canon: 'docs/addons', base: '../', current: 'addons', main: docsMain }));

const common = { VERSION: esc(version), VERSION_COUNT: String(all.length) };
fillTemplate('index.html', Object.assign({}, common, { HEADLINE: esc(headline.length > 60 ? headline.slice(0, 58).replace(/\s+\S*$/, '') + '…' : headline), RECENT: recent }));
fillTemplate('changelog.html', Object.assign({}, common, { TOC: toc, RELEASES: releases }));

// Every image and stylesheet the pages use must exist (paths are relative to the page).
const missing = [];
for (const f of ['index.html', 'changelog.html', 'addons.html', path.join('docs', 'addons.html')]) {
  const html = fs.readFileSync(path.join(OUT, f), 'utf8');
  for (const m of html.matchAll(/(?:src|href)="([^"#?]+\.(?:webp|png|jpg|svg|css|js))[^"]*"/g)) {
    if (/^https?:/.test(m[1])) continue;
    if (!fs.existsSync(path.join(OUT, path.dirname(f), m[1]))) missing.push(`${f}: ${m[1]}`);
  }
}
if (missing.length) { console.error('Missing files:\n  ' + missing.join('\n  ')); process.exit(1); }
console.log(`Built site/dist for PhoneDesk ${version} (${all.length} versions)`);
