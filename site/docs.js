'use strict';
// A small Markdown renderer for the addon docs (docs/addons/*.md): headings, paragraphs, lists, indented code blocks,
// `code`, **bold** and links. Everything is escaped. Relative .md links become links to the matching section.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

function inline(text, linkMap) {
  const codes = [];
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = s.replace(/(\w)'(\w)/g, '$1’$2');
  s = esc(s);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
    u = u.replace(/&amp;/g, '&');
    const m = /^([\w-]+)\.md(?:#([\w-]+))?$/.exec(u);
    if (m && linkMap[m[1]]) return `<a href="#${linkMap[m[1]]}${m[2] ? '-' + m[2] : ''}">${t}</a>`;
    if (/^https:\/\//.test(u)) return `<a href="${esc(u)}" rel="noopener">${t}</a>`;
    return t;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
}

/** md -> { html, headings: [{ level, text, id }] }. The first "# Title" becomes an h2 and the section's anchor. */
function render(md, opt) {
  opt = opt || {};
  const linkMap = opt.linkMap || {};
  const lines = String(md).replace(/\r/g, '').split('\n');
  const out = [], headings = [];
  let para = [], list = null, code = null;
  const flushPara = () => { if (para.length) out.push(`<p>${inline(para.join(' '), linkMap)}</p>`); para = []; };
  const flushList = () => { if (list) out.push('<ul>' + list.map((li) => `<li>${inline(li, linkMap)}</li>`).join('') + '</ul>'); list = null; };
  const flushCode = () => { if (code) { out.push(`<pre><code>${esc(code.join('\n').replace(/\n+$/, ''))}</code></pre>`); code = null; } };
  let prevBlank = true;
  for (const line of lines) {
    if (code) {
      if (/^( {4}|\t)/.test(line) || !line.trim()) { code.push(line.replace(/^( {4}|\t)/, '')); continue; }
      flushCode();
    }
    if (!line.trim()) { flushPara(); flushList(); prevBlank = true; continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      flushPara(); flushList();
      const level = h[1].length === 1 ? 2 : h[1].length + 1; // # -> h2, ## -> h3
      const base = opt.id || '';
      const id = level === 2 ? base || slug(h[2]) : (base ? base + '-' : '') + slug(h[2]);
      headings.push({ level, text: h[2], id });
      out.push(`<h${level} id="${id}">${inline(h[2], linkMap)}</h${level}>`);
      prevBlank = true; continue;
    }
    if (prevBlank && !list && /^( {4}|\t)\S/.test(line)) { flushPara(); code = [line.replace(/^( {4}|\t)/, '')]; prevBlank = false; continue; }
    const li = /^- (.*)$/.exec(line);
    if (li) { flushPara(); if (!list) list = []; list.push(li[1]); prevBlank = false; continue; }
    if (list && /^\s+\S/.test(line)) { list[list.length - 1] += ' ' + line.trim(); continue; }
    flushList();
    para.push(line.trim());
    prevBlank = false;
  }
  flushCode(); flushPara(); flushList();
  return { html: out.join('\n'), headings };
}

module.exports = { render, esc, slug };
