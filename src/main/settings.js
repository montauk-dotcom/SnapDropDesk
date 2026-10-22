'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomId } = require('../core/util');

const DEFAULTS = {
  name: os.hostname().replace(/\.local$/, ''),
  port: 47321,
  hotkey: 'CommandOrControl+Shift+Space',
  clipboardSync: false,
  notifications: true,
  copyIncomingText: true,
  menuBarLabel: '', // optional text next to the menu-bar icon on macOS ('' = icon only)
  showInDock: false,
  theme: 'system',     // system | light | dark
  accent: '#ff5a1f',
};

class Settings {
  constructor(dir, downloadsDir) {
    this.file = path.join(dir, 'settings.json');
    let data = {};
    try { data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    this.data = {
      ...DEFAULTS,
      downloadDir: path.join(downloadsDir, 'SnapDrop'),
      ...data,
    };
    // Generated once and kept: identity must survive restarts so pairings keep working.
    delete this.data.menuBarTitle; // ≤0.1.4 showed “SDD” by default; now icon only
    this.data.id ||= randomId(8);
    this.data.webToken ||= randomId(12);
    this.data.trust ||= { incoming: {}, outgoing: {} };
    this.save();
  }

  get(k) { return this.data[k]; }

  set(k, v) {
    this.data[k] = v;
    this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Settings };
