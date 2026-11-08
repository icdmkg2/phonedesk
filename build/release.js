'use strict';
// Release helper for the GitHub Actions workflow (.github/workflows/release.yml); also handy by hand.
//   node build/release.js versions                       versions in CHANGELOG.md, newest first
//   node build/release.js notes <version> [repo] [ref]   that version's patch notes as a release body
//   node build/release.js commit <version>               last commit whose package.json has that version
// Release bodies don't resolve relative links, so images and file links in the notes are rewritten to
// https://github.com/<repo>/raw/<ref>/<path> (and blob/) at the given commit.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

function sections() {
  const text = fs.readFileSync(CHANGELOG, 'utf8');
  const out = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^## \[(\d+\.\d+\.\d+)\]/.exec(line);
    if (m) { cur = { version: m[1], heading: line, body: [] }; out.push(cur); continue; }
    if (/^## /.test(line) || /^\[[^\]]+\]:\s/.test(line)) { cur = null; continue; } // other headings, link refs
    if (cur) cur.body.push(line);
  }
  return out.map((s) => Object.assign(s, { body: s.body.join('\n').trim() }));
}

function notes(version, repo, ref) {
  const s = sections().find((x) => x.version === version);
  if (!s) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const date = (/—\s*(\d{4}-\d{2}-\d{2})/.exec(s.heading) || [])[1];
  let body = s.body.replace(/^### /gm, '## ');
  if (repo && ref) {
    const abs = (kind, p) => `https://github.com/${repo}/${kind}/${ref}/${p.replace(/^\.?\//, '')}`;
    body = body
      .replace(/!\[([^\]]*)\]\((?!https?:)([^)\s]+)\)/g, (_, alt, p) => `![${alt}](${abs('raw', p)})`)
      .replace(/(^|[^!])\[([^\]]+)\]\((?!https?:|#)([^)\s]+)\)/g, (_, pre, t, p) => `${pre}[${t}](${abs('blob', p)})`)
      .replace(/(src|href)="(?!https?:|#)([^"]+)"/g, (_, a, p) => `${a}="${abs(a === 'src' ? 'raw' : 'blob', p)}"`);
  }
  const foot = repo ? `\n\n---\n${date ? `Released ${date}. ` : ''}Full history: [CHANGELOG.md](https://github.com/${repo}/blob/main/CHANGELOG.md)` : '';
  return body + foot + '\n';
}

function commitOf(version) {
  // The newest commit (merged branches included) whose package.json has that version; a version can span several commits.
  const shas = execFileSync('git', ['log', '--format=%H'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
  for (const sha of shas) {
    let v = null;
    try { v = JSON.parse(execFileSync('git', ['show', `${sha}:package.json`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).version; } catch {}
    if (v === version) return sha;
  }
  throw new Error(`no commit has version ${version}`);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === 'versions') process.stdout.write(sections().map((s) => s.version).join('\n') + '\n');
else if (cmd === 'notes') process.stdout.write(notes(args[0], args[1], args[2]));
else if (cmd === 'commit') process.stdout.write(commitOf(args[0]) + '\n');
else { console.error('usage: node build/release.js versions | notes <version> [repo] [ref] | commit <version>'); process.exit(2); }
