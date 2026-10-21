'use strict';
/**
 * Text clipboard sync between paired desktops.
 *
 * Polls the local clipboard (Electron has no change event on any OS) and broadcasts
 * new text. Text that arrived from a peer is remembered so it is not echoed back,
 * which would otherwise make two machines ping-pong forever.
 */
const crypto = require('crypto');

const hash = (s) => crypto.createHash('sha1').update(s).digest('hex');

class ClipboardSync {
  /**
   * @param {object} o
   * @param {() => string} o.read
   * @param {(text: string) => void} o.write
   * @param {(text: string) => void} o.onLocalChange   broadcast to peers
   * @param {number} [o.intervalMs]
   * @param {number} [o.maxBytes]  don't sync huge blobs
   */
  constructor({ read, write, onLocalChange, intervalMs = 600, maxBytes = 512 * 1024 }) {
    Object.assign(this, { read, write, onLocalChange, intervalMs, maxBytes });
    this.lastHash = null;
    this.timer = null;
  }

  get running() {
    return !!this.timer;
  }

  start() {
    if (this.timer) return;
    this.lastHash = hash(this._safeRead()); // don't broadcast whatever was there before enabling
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const text = this._safeRead();
    if (!text) return;
    const h = hash(text);
    if (h === this.lastHash) return;
    this.lastHash = h;
    if (Buffer.byteLength(text) > this.maxBytes) return;
    this.onLocalChange(text);
  }

  /** Text received from a peer. */
  applyRemote(text) {
    if (typeof text !== 'string' || !text) return false;
    const h = hash(text);
    if (h === this.lastHash) return false;
    this.lastHash = h; // set before writing so the next tick sees no change
    this.write(text);
    return true;
  }

  _safeRead() {
    try {
      return this.read() || '';
    } catch {
      return '';
    }
  }
}

module.exports = { ClipboardSync };
