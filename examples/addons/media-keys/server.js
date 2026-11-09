'use strict';
// Media and system keys: each action presses one key combination on the PC.
const KEYS = {
  'volume-up': 'volumeup',
  'volume-down': 'volumedown',
  'volume-mute': 'volumemute',
  'play-pause': 'mediaplay',
  'next-track': 'medianext',
  'previous-track': 'mediaprev',
  'task-view': 'win+tab',
  'clipboard-history': 'win+v',
};

module.exports = (pd) => {
  for (const [id, combo] of Object.entries(KEYS)) {
    pd.action(id, () => pd.keys.send(combo));
  }
};
