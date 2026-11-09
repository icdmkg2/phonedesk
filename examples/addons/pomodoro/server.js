'use strict';
// Pomodoro, PC side: remembers how many focus sessions were finished today, and the lengths from the settings.
module.exports = (pd) => {
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  const minutes = (key, fallback) => Math.min(180, Math.max(1, Math.round(pd.settings.get(key, fallback)) || fallback));
  const view = () => ({
    type: 'config',
    focus: minutes('focusMinutes', 25), short: minutes('shortMinutes', 5), long: minutes('longMinutes', 15),
    done: pd.storage.get('days', {})[today()] || 0,
  });

  pd.screen.on((m) => {
    if (!m) return;
    if (m.type === 'hello') pd.screen.send(view());
    if (m.type === 'done' && m.mode === 'focus') {
      const days = pd.storage.get('days', {});
      days[today()] = (days[today()] || 0) + 1;
      // keep the last two weeks
      Object.keys(days).sort().slice(0, -14).forEach((k) => delete days[k]);
      pd.storage.set('days', days);
      pd.log.info('focus session finished (' + days[today()] + ' today)');
      pd.screen.send(view());
    }
  });
  pd.on('settings', () => pd.screen.send(view()));
};
