'use strict';
/**
 * Zero-config discovery over mDNS / Bonjour (_snapdrop._tcp).
 * macOS has Bonjour built in, Windows 10+ answers mDNS natively, Linux needs nothing extra
 * because bonjour-service is a pure-JS responder.
 */
const { EventEmitter } = require('events');
const { Bonjour } = require('bonjour-service');

const SERVICE_TYPE = 'snapdrop';

class Discovery extends EventEmitter {
  constructor({ id, name, platform, port }) {
    super();
    Object.assign(this, { id, name, platform, port });
    this.known = new Map(); // service fqdn -> peer id
  }

  start() {
    this.bonjour = new Bonjour();
    this._publish();
    this.browser = this.bonjour.find({ type: SERVICE_TYPE });
    this.browser.on('up', (s) => this._onUp(s));
    this.browser.on('down', (s) => this._onDown(s));
    // Re-query periodically: some routers drop multicast and peers would otherwise go stale.
    this._timer = setInterval(() => this.browser.update(), 15000).unref();
  }

  _publish() {
    this.service = this.bonjour.publish({
      name: `SnapDrop ${this.name} ${this.id.slice(0, 4)}`,
      type: SERVICE_TYPE,
      port: this.port,
      txt: { id: this.id, name: this.name, platform: this.platform, v: '1' },
    });
    this.service.on('error', (e) => this.emit('error', e));
  }

  /** Re-announce after a rename. */
  rename(name) {
    this.name = name;
    this.service?.stop?.(() => this._publish());
  }

  _onUp(s) {
    const txt = s.txt || {};
    if (!txt.id || txt.id === this.id) return;
    const host = (s.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || s.referer?.address || s.host;
    this.known.set(s.fqdn, txt.id);
    this.emit('up', { id: txt.id, name: txt.name || s.name, platform: txt.platform || 'unknown', host, port: s.port });
  }

  _onDown(s) {
    const id = this.known.get(s.fqdn) || s.txt?.id;
    this.known.delete(s.fqdn);
    if (id) this.emit('down', id);
  }

  stop() {
    clearInterval(this._timer);
    return new Promise((resolve) => {
      if (!this.bonjour) return resolve();
      this.browser?.stop();
      this.bonjour.unpublishAll(() => {
        this.bonjour.destroy();
        resolve();
      });
    });
  }
}

module.exports = { Discovery, SERVICE_TYPE };
