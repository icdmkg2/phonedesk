'use strict';
// The patch notes in CHANGELOG.md (shipped with the app) as HTML, for the dashboard's "What's new" dialog.
// The website build (site/build.js) uses the same renderer.
// A small Markdown subset: headings, paragraphs, lists, **bold**, *italic*, `code`, links, images and the
// <p><img …></p> rows the changelog uses. Everything else is escaped.
const fs = require('fs');
const path = require('path');

const REPO = 'icdmkg2/phonedesk';
const FILE = path.join(__dirname, '..', 'CHANGELOG.md');

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

/** Relative paths (docs/changelog/…) become absolute GitHub URLs at the given ref; http(s) stays; anything else is dropped. */
function url(u, ref, kind) {
  u = String(u || '').trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (/^[\w./-]+$/.test(u) && !u.includes('..')) {
    const p = u.replace(/^\.?\//, '');
    return kind === 'img' ? `https://raw.githubusercontent.com/${REPO}/${ref}/${p}` : `https://github.com/${REPO}/blob/${ref}/${p}`;
  }
  return '';
}

function inline(text, opt) {
  // Pull out code spans first so their contents stay literal.
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, u) => {
    const src = (opt.imgUrl || url)(u, opt.ref, 'img');
    return src ? `<img src="${esc(src)}" alt="${alt}" loading="lazy">` : '';
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
    const href = (opt.linkUrl || url)(u.replace(/&amp;/g, '&'), opt.ref, 'link');
    return href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${t}</a>` : t;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<i>$2</i>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
}

/** Markdown (the subset above) -> HTML. opt: { ref, imgUrl(u, ref), linkUrl(u, ref) } */
function render(md, opt = {}) {
  opt = Object.assign({ ref: 'main' }, opt);
  const out = [];
  let para = [], list = null, item = null;
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(' '), opt)}</p>`); para = []; };
  const flushList = () => {
    if (item !== null) list.push(item);
    if (list) out.push('<ul>' + list.map((li) => `<li>${inline(li, opt)}</li>`).join('') + '</ul>');
    list = null; item = null;
  };
  const lines = String(md).replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // <p><img …></p> rows: keep only the images, with their src/alt.
    if (/^<p>\s*$/.test(line)) {
      flushPara(); flushList();
      const imgs = [];
      for (i++; i < lines.length && !/^<\/p>/.test(lines[i]); i++) {
        const src = /src="([^"]+)"/.exec(lines[i]), alt = /alt="([^"]*)"/.exec(lines[i]);
        if (src) { const u = (opt.imgUrl || url)(src[1], opt.ref, 'img'); if (u) imgs.push(`<img src="${esc(u)}" alt="${esc(alt ? alt[1] : '')}" loading="lazy">`); }
      }
      if (imgs.length) out.push(`<div class="shots">${imgs.join('')}</div>`);
      continue;
    }
    const h = /^(#{2,4})\s+(.*)$/.exec(line);
    if (h) { flushPara(); flushList(); const n = Math.min(4, h[1].length + 1); out.push(`<h${n}>${inline(h[2], opt)}</h${n}>`); continue; }
    const li = /^\s*-\s+(.*)$/.exec(line);
    if (li && !/^\s{4,}/.test(line)) { flushPara(); if (!list) list = []; if (item !== null) list.push(item); item = li[1]; continue; }
    if (list && /^\s+\S/.test(line)) { item += ' ' + line.trim().replace(/^-\s+/, '· '); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (/^---+$/.test(line.trim())) { flushPara(); flushList(); out.push('<hr>'); continue; }
    flushList();
    const img = /^!\[[^\]]*\]\([^)]+\)$/.test(line.trim());
    if (img) { flushPara(); out.push(`<div class="shots">${inline(line.trim(), opt)}</div>`); continue; }
    para.push(line.trim());
  }
  flushPara(); flushList();
  return out.join('\n');
}

/** All versions in CHANGELOG.md: [{ version, date, md }] newest first. */
function sections(text) {
  if (text == null) { try { text = fs.readFileSync(FILE, 'utf8'); } catch { return []; } }
  const out = [];
  let cur = null;
  for (const line of String(text).replace(/\r/g, '').split('\n')) {
    const m = /^## \[(\d+\.\d+\.\d+)\](?:\s*—\s*(\S+))?/.exec(line);
    if (m) { cur = { version: m[1], date: m[2] || '', lines: [] }; out.push(cur); continue; }
    if (/^## /.test(line) || /^\[[^\]]+\]:\s/.test(line)) { cur = null; continue; }
    if (cur) cur.lines.push(line);
  }
  return out.map((s) => ({ version: s.version, date: s.date, md: s.lines.join('\n').trim() }));
}

module.exports = {
  REPO, render, sections, esc,
  /** { version, date, html, url } for one version, or null when the changelog doesn't have it. */
  forVersion(version) {
    const s = sections().find((x) => x.version === version);
    if (!s) return null;
    return { version: s.version, date: s.date, html: render(s.md, { ref: 'v' + version }), url: `https://github.com/${REPO}/releases/tag/v${version}` };
  },
};
