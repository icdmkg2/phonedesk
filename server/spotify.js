'use strict';
// Spotify extras: what's up next, and a "like" (save to Liked Songs) button.
// Uses Spotify's Web API with your own free developer app (Spotify requires one) and the PKCE
// sign-in flow, so there's no secret to store. Tokens stay in PhoneDesk's data folder.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA } = require('./paths');
const log = require('./log');

const TOKEN_FILE = path.join(DATA, 'spotify.json');
const SCOPES = 'user-read-currently-playing user-read-playback-state user-library-read user-library-modify';

let tokens = load();          // { access, refresh, expires }
let pending = null;           // { verifier, state, clientId, redirect }
let current = null;           // { id, liked, next: { title, artist } }
let lastId = '';
let timer = null;
let onUpdate = () => {};

function load() { try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; } }
function save() {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    if (tokens) fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens)); else fs.rmSync(TOKEN_FILE, { force: true });
  } catch (e) { log.warn('spotify: could not save sign-in: ' + e.message); }
}
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function tokenRequest(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error_description || j.error || 'HTTP ' + res.status);
  return j;
}

async function accessToken(clientId) {
  if (!tokens) return null;
  if (tokens.expires - Date.now() > 60000) return tokens.access;
  try {
    const j = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh, client_id: clientId });
    tokens = { access: j.access_token, refresh: j.refresh_token || tokens.refresh, expires: Date.now() + j.expires_in * 1000 };
    save();
    return tokens.access;
  } catch (e) {
    log.event('problem', 'Spotify sign-in expired. Connect Spotify again in PhoneDesk.');
    tokens = null; save();
    return null;
  }
}

async function api(clientId, method, url) {
  const token = await accessToken(clientId);
  if (!token) return null;
  const res = await fetch('https://api.spotify.com/v1' + url, { method, headers: { Authorization: 'Bearer ' + token } });
  if (res.status === 204) return {};
  if (!res.ok) throw new Error(`${url.split('?')[0]}: HTTP ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

function artists(item) { return (item && item.artists || []).map((a) => a.name).join(', '); }

async function poll(cfg) {
  if (!tokens || !cfg.spotifyClientId) return;
  try {
    const now = await api(cfg.spotifyClientId, 'GET', '/me/player/currently-playing');
    const item = now && now.item;
    if (!item || !item.id) { if (current) { current = null; lastId = ''; onUpdate(null); } return; }
    if (item.id === lastId && current) return;
    lastId = item.id;
    const [liked, queue] = await Promise.all([
      api(cfg.spotifyClientId, 'GET', '/me/tracks/contains?ids=' + item.id).catch(() => null),
      api(cfg.spotifyClientId, 'GET', '/me/player/queue').catch(() => null),
    ]);
    const next = queue && queue.queue && queue.queue[0];
    current = {
      id: item.id,
      title: item.name,
      liked: Array.isArray(liked) ? !!liked[0] : null,
      next: next ? { title: next.name, artist: artists(next) } : null,
    };
    onUpdate(current);
  } catch (e) {
    log.warn('spotify: ' + e.message);
  }
}

module.exports = {
  connected: () => !!tokens,
  latest: () => current,

  /** Start the sign-in. Returns the URL to open in a browser. */
  loginUrl(clientId, redirect) {
    const verifier = b64url(crypto.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(12));
    pending = { verifier, state, clientId, redirect };
    return 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
      client_id: clientId, response_type: 'code', redirect_uri: redirect, scope: SCOPES,
      code_challenge_method: 'S256', code_challenge: challenge, state,
    });
  },

  /** The browser came back from Spotify. */
  async callback(params) {
    if (!pending || params.get('state') !== pending.state) throw new Error('This sign-in link is old. Start again from PhoneDesk.');
    if (params.get('error')) throw new Error(params.get('error') === 'access_denied' ? 'You declined access.' : params.get('error'));
    const p = pending; pending = null;
    const j = await tokenRequest({
      grant_type: 'authorization_code', code: params.get('code'), redirect_uri: p.redirect,
      client_id: p.clientId, code_verifier: p.verifier,
    });
    tokens = { access: j.access_token, refresh: j.refresh_token, expires: Date.now() + j.expires_in * 1000 };
    save();
    lastId = '';
    log.event('info', 'Spotify connected');
  },

  disconnect() { tokens = null; current = null; lastId = ''; save(); onUpdate(null); },

  async toggleLike(cfg) {
    if (!current || !cfg.spotifyClientId) return;
    const want = !current.liked;
    await api(cfg.spotifyClientId, want ? 'PUT' : 'DELETE', '/me/tracks?ids=' + current.id);
    current = Object.assign({}, current, { liked: want });
    onUpdate(current);
  },

  /** Poll while Spotify is what's playing. */
  start(getConfig, isSpotifyPlaying, cb) {
    onUpdate = cb;
    clearInterval(timer);
    timer = setInterval(() => { if (isSpotifyPlaying()) poll(getConfig()); }, 4000);
    timer.unref();
  },
  /** Check right away (track changed). */
  kick(cfg) { lastId = ''; poll(cfg); },
};
