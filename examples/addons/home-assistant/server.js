'use strict';
// Home Assistant, PC side: reads the entities you chose and toggles them. The token never leaves this PC.
const TOGGLE = new Set(['light', 'switch', 'fan', 'input_boolean']); // toggled with homeassistant.toggle
const SCENE = 'scene';                                                 // activated with scene.turn_on

module.exports = (pd) => {
  let timer = null, busy = false;

  const config = () => {
    const url = String(pd.settings.get('url', '')).trim().replace(/\/+$/, '');
    const token = String(pd.settings.get('token', '')).trim();
    const entities = String(pd.settings.get('entities', '')).split(/[,\s]+/).filter((e) => /^[a-z_]+\.[a-z0-9_]+$/.test(e)).slice(0, 24);
    return { url, token, entities };
  };
  const headers = (token) => ({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' });

  async function refresh() {
    if (busy) return;
    busy = true;
    try {
      const { url, token, entities } = config();
      if (!url || !token || !entities.length) return pd.screen.send({ type: 'setup' });
      const out = [];
      for (const id of entities) {
        try {
          const s = await pd.http.json(url + '/api/states/' + id, { headers: headers(token) });
          out.push({ id, name: (s.attributes && s.attributes.friendly_name) || id, state: String(s.state), domain: id.split('.')[0] });
        } catch (e) { out.push({ id, name: id, state: 'unavailable', domain: id.split('.')[0], error: e.message }); }
      }
      pd.screen.send({ type: 'states', entities: out });
    } catch (e) {
      pd.screen.send({ type: 'error', message: e.message });
    } finally { busy = false; }
  }

  async function toggle(id) {
    const { url, token, entities } = config();
    if (!entities.includes(id)) return; // only what the user listed
    const domain = id.split('.')[0];
    const service = TOGGLE.has(domain) ? '/api/services/homeassistant/toggle' : domain === SCENE ? '/api/services/scene/turn_on' : null;
    if (!service) return;
    await pd.http.request({ url: url + service, method: 'POST', headers: headers(token), body: { entity_id: id } });
    setTimeout(refresh, 400);
  }

  pd.screen.on((m) => {
    if (!m) return;
    if (m.type === 'hello') refresh();
    if (m.type === 'toggle' && typeof m.id === 'string') toggle(m.id).catch((e) => pd.screen.send({ type: 'error', message: e.message }));
  });
  pd.on('settings', refresh);
  timer = setInterval(refresh, 6000);
  pd.on('stop', () => clearInterval(timer));
  refresh();
};
