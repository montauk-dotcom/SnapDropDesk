'use strict';
/**
 * SnapNode — the networking core of SnapDrop Desk.
 *
 * One HTTP server per device does everything:
 *   GET  /                    mobile web client (phones open it from the QR code)
 *   GET  /api/info            who am I (used by manual "add by IP" and discovery checks)
 *   POST /api/upload          receive one file (streamed straight to disk)
 *   POST /api/text            receive text / clipboard
 *   GET  /api/download/:id    phones fetch files a desktop pushed to them
 *   WS   /ws                  live channel for phones (push files/text to them)
 *
 * Trust model
 *   Desktops: the first transfer from an unknown device asks the user (approve callback).
 *   "Always allow" makes the receiver mint a random key that it returns to the sender;
 *   later requests must carry that key, so a spoofed device id is not enough.
 *   Phones: they authenticate with the web token embedded in the QR code — scanning it
 *   requires physically seeing the screen.
 *
 * Electron-free on purpose: the same core runs the desktop app, the headless CLI and the tests.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { WebSocketServer } = require('ws');
const { randomId, lanAddresses, uniquePath, platformLabel, safeEqual, safeFileName } = require('./util');

const VERSION = require('../../package.json').version;
const DEFAULT_PORT = 47321;
const BATCH_TTL_MS = 5 * 60 * 1000;
const STAGE_TTL_MS = 24 * 60 * 60 * 1000; // links stay valid for phones that were asleep
const OUTBOX_MAX = 100;                     // messages kept per phone for replay
const WEB_PEER_TTL_MS = 12 * 60 * 60 * 1000; // forget a phone that has been away this long
const ACK_WAIT_MS = 2500;
const MAX_TEXT_BYTES = 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

class SnapNode extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.id            stable device id
   * @param {string} o.name          human name shown to other devices
   * @param {string} o.downloadDir   where received files go
   * @param {number} [o.port]        preferred port (next free one is used if busy)
   * @param {string} [o.webToken]    token phones need (from QR code)
   * @param {object} [o.trust]       { incoming: {peerId: key}, outgoing: {peerId: key} }
   * @param {(req:{peer:object, kind:string, name?:string, size?:number}) => Promise<'accept'|'always'|'deny'>} [o.approve]
   * @param {() => boolean} [o.acceptClipboard]  whether incoming clipboard sync is enabled
   * @param {string} [o.webRoot]     folder with the mobile web client
   */
  constructor(o) {
    super();
    this.id = o.id || randomId();
    this.name = o.name || require('os').hostname();
    this.platform = o.platform || platformLabel();
    this.downloadDir = o.downloadDir;
    this.preferredPort = o.port ?? DEFAULT_PORT;
    this.webToken = o.webToken || randomId(12);
    this.trust = { incoming: {}, outgoing: {}, ...(o.trust || {}) };
    this.approve = o.approve || (async () => 'deny');
    this.acceptClipboard = o.acceptClipboard || (() => true);
    this.webRoot = o.webRoot || path.join(__dirname, '..', '..', 'web');
    this.heartbeatMs = o.heartbeatMs || 15000;
    this.epoch = randomId(4); // changes on every start, so phones know old sequence numbers are void

    this.peers = new Map(); // id -> {id,name,platform,host,port,kind,ws?}
    this.batches = new Map(); // `${peerId}:${batchId}` -> expiry
    this.staged = new Map(); // downloadId -> {path,name,size,expires}
    this.server = null;
    this.port = null;
  }

  /* ------------------------------------------------------------------ lifecycle */

  async start() {
    fs.mkdirSync(this.downloadDir, { recursive: true });
    this.server = http.createServer((req, res) => this._handle(req, res).catch((err) => {
      this.emit('error', err);
      if (!res.headersSent) this._json(res, 500, { error: 'internal' });
      else res.destroy();
    }));
    this.server.requestTimeout = 0; // big files can take a while
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => this._upgrade(req, socket, head));

    for (let port = this.preferredPort, tries = 0; ; port++, tries++) {
      try {
        await new Promise((resolve, reject) => {
          this.server.once('error', reject);
          this.server.listen(port, '0.0.0.0', () => {
            this.server.off('error', reject);
            resolve();
          });
        });
        break;
      } catch (err) {
        if (err.code !== 'EADDRINUSE' || tries > 20 || this.preferredPort === 0) throw err;
      }
    }
    this.port = this.server.address().port;
    this._gcTimer = setInterval(() => this._gc(), 60 * 1000).unref();
    return this.port;
  }

  async stop() {
    clearInterval(this._gcTimer);
    for (const p of this.peers.values()) for (const ws of p.sockets || []) ws.terminate();
    this.wss?.close();
    if (!this.server) return;
    const closed = new Promise((r) => this.server.close(() => r()));
    this.server.closeAllConnections?.();
    await closed;
  }

  info() {
    return { app: 'snapdrop-desk', version: VERSION, id: this.id, name: this.name, platform: this.platform, port: this.port };
  }

  /** URL a phone should open (encoded into the QR code). */
  webUrl(host = lanAddresses()[0] || '127.0.0.1') {
    return `http://${host}:${this.port}/?t=${this.webToken}`;
  }

  appearance() {
    return { theme: this.theme || 'system', accent: this.accent || '#ff5a1f' };
  }

  /** Theme / accent picked on the computer; connected phones restyle live. */
  setAppearance({ theme, accent } = {}) {
    if (theme) this.theme = theme;
    if (accent) this.accent = accent;
    const msg = JSON.stringify({ type: 'appearance', ...this.appearance() });
    for (const p of this.peers.values()) {
      if (p.kind !== 'web') continue;
      for (const ws of p.sockets) if (ws.readyState === 1) ws.send(msg);
    }
  }

  resetWebToken() {
    this.webToken = randomId(12);
    for (const p of [...this.peers.values()]) {
      if (p.kind !== 'web') continue;
      for (const ws of p.sockets) ws.close(4001, 'token reset');
      this.removePeer(p.id);
    }
    return this.webToken;
  }

  /* ------------------------------------------------------------------ peers */

  /** Called by discovery (mDNS) or after a manual "add by IP". */
  upsertPeer(peer) {
    if (!peer?.id || peer.id === this.id) return;
    const prev = this.peers.get(peer.id);
    const next = { kind: 'desktop', ...prev, ...peer, lastSeen: Date.now() };
    this.peers.set(peer.id, next);
    if (!prev) this.emit('peer-up', this.publicPeer(next));
    else if (prev.name !== next.name || prev.host !== next.host) this.emit('peer-update', this.publicPeer(next));
  }

  removePeer(id) {
    const p = this.peers.get(id);
    if (!p) return;
    this.peers.delete(id);
    this.emit('peer-down', this.publicPeer(p));
  }

  /** Probe host:port and register it as a peer. Works when mDNS is blocked (guest Wi-Fi, VPN). */
  async addManualPeer(host, port = DEFAULT_PORT) {
    const info = await httpJson({ host, port, path: '/api/info', method: 'GET', timeout: 4000 });
    if (info.app !== 'snapdrop-desk') throw new Error('Not a SnapDrop Desk device');
    this.upsertPeer({ id: info.id, name: info.name, platform: info.platform, host, port: info.port || port, manual: true });
    return this.publicPeer(this.peers.get(info.id));
  }

  listPeers() {
    return [...this.peers.values()].map((p) => this.publicPeer(p));
  }

  publicPeer(p) {
    return {
      id: p.id, name: p.name, platform: p.platform, kind: p.kind, host: p.host, port: p.port,
      trusted: !!(this.trust.outgoing[p.id] && this.trust.incoming[p.id]),
      online: p.kind === 'web' ? p.sockets.size > 0 : true,
      ...(p.kind === 'web' ? { pending: p.outbox.filter((m) => m.seq > p.acked).length } : {}),
    };
  }

  isTrusted(id) {
    return !!this.trust.incoming[id];
  }

  untrust(id) {
    delete this.trust.incoming[id];
    delete this.trust.outgoing[id];
    this.emit('trust-changed', this.trust);
  }

  /* ------------------------------------------------------------------ sending */

  /**
   * Send files to a peer. Desktop peers get them over HTTP; phones get a download link via WS.
   * @returns {Promise<{sent:number, delivered:boolean}>}  delivered=false: queued for a phone that is asleep
   */
  async sendFiles(peerId, filePaths) {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Unknown device');
    const files = filePaths.filter((f) => fs.existsSync(f) && fs.statSync(f).isFile());
    if (!files.length) throw new Error('Nothing to send (folders are not supported yet)');

    if (peer.kind === 'web') {
      const acks = files.map((f) => {
        const id = randomId(12);
        const size = fs.statSync(f).size;
        this.staged.set(id, { path: f, name: path.basename(f), size, expires: Date.now() + STAGE_TTL_MS });
        return this._pushToWeb(peer, {
          type: 'file', id, name: path.basename(f), size, from: this.name,
          url: `/api/download/${id}?t=${encodeURIComponent(this.webToken)}`,
        });
      });
      const delivered = (await Promise.all(acks)).every(Boolean);
      return { sent: files.length, delivered };
    }

    const batch = randomId(6);
    for (const f of files) await this._uploadTo(peer, f, batch);
    return { sent: files.length, delivered: true };
  }

  async sendText(peerId, text, kind = 'message') {
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error('Unknown device');
    if (peer.kind === 'web') {
      return { delivered: await this._pushToWeb(peer, { type: 'text', text, kind, from: this.name }) };
    }
    const body = Buffer.from(JSON.stringify({ text, kind }));
    const res = await httpJson({
      host: peer.host, port: peer.port, path: '/api/text', method: 'POST', body,
      headers: { ...this._authHeaders(peer), 'content-type': 'application/json' },
      timeout: kind === 'clipboard' ? 5000 : 90 * 1000,
    });
    this._learnKey(peer, res);
    return { delivered: true };
  }

  _authHeaders(peer) {
    const h = { 'x-snap-from': this.id, 'x-snap-name': encodeURIComponent(this.name), 'x-snap-platform': this.platform, 'x-snap-port': String(this.port) };
    if (this.trust.outgoing[peer.id]) h['x-snap-key'] = this.trust.outgoing[peer.id];
    return h;
  }

  _learnKey(peer, res) {
    if (res && res.key && res.key !== this.trust.outgoing[peer.id]) {
      this.trust.outgoing[peer.id] = res.key;
      this.emit('trust-changed', this.trust);
    }
  }

  _uploadTo(peer, filePath, batch) {
    const size = fs.statSync(filePath).size;
    const name = path.basename(filePath);
    const transferId = randomId(6);
    let sent = 0;
    const source = fs.createReadStream(filePath);
    const progress = new Transform({
      transform: (chunk, _enc, cb) => {
        sent += chunk.length;
        this.emit('progress', { id: transferId, direction: 'out', peer: peer.name, name, sent, total: size });
        cb(null, chunk);
      },
    });

    return new Promise((resolve, reject) => {
      const req = http.request({
        host: peer.host, port: peer.port, path: '/api/upload', method: 'POST',
        headers: {
          ...this._authHeaders(peer),
          'content-type': 'application/octet-stream',
          'content-length': size,
          'x-snap-filename': encodeURIComponent(name),
          'x-snap-batch': batch,
        },
      }, (res) => {
        let buf = '';
        res.on('data', (d) => (buf += d));
        res.on('end', () => {
          let json = {};
          try { json = JSON.parse(buf || '{}'); } catch { /* ignore */ }
          if (res.statusCode === 200) {
            this._learnKey(peer, json);
            this.emit('sent', { peer: peer.name, name, size });
            resolve(json);
          } else {
            source.destroy(); // stop streaming the rest of the file
            req.destroy();
            reject(new Error(json.error === 'denied' ? `${peer.name} declined the transfer` : `Transfer failed (${res.statusCode})`));
          }
        });
      });
      // The receiver may answer 403 before reading the body (user declined); errors after a
      // settled response are expected and ignored because the promise is already settled.
      req.on('error', reject);
      pipeline(source, progress, req).catch((err) => {
        if (!['ERR_STREAM_DESTROYED', 'ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET', 'EPIPE'].includes(err.code)) reject(err);
      });
    });
  }

  /* ------------------------------------------------------------------ receiving */

  async _handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (req.method === 'GET' && p === '/api/info') return this._json(res, 200, this.info());
    if (req.method === 'POST' && p === '/api/upload') return this._receiveFile(req, res, url);
    if (req.method === 'POST' && p === '/api/text') return this._receiveText(req, res, url);
    if (req.method === 'GET' && p.startsWith('/api/download/')) return this._serveDownload(req, res, url);
    if (req.method === 'GET' && !p.startsWith('/api/')) return this._serveStatic(res, p);
    return this._json(res, 404, { error: 'not found' });
  }

  /** Works out who is calling and whether they may. Returns {peer, key?} or null (response already sent). */
  async _authorize(req, res, url, kind, meta = {}) {
    // Phone with the QR token
    const token = req.headers['x-snap-token'] || url.searchParams.get('t');
    if (token) {
      if (!safeEqual(token, this.webToken)) return this._json(res, 401, { error: 'bad token' }), null;
      // Phones send their stable client id with every request, so a send that races a
      // reconnect (iOS drops the socket while the photo picker is open) still works.
      const cid = String(req.headers['x-snap-cid'] || req.headers['x-snap-web-id'] || '').replace(/^web-/, '');
      const name = safeDecode(req.headers['x-snap-name']).slice(0, 40) || undefined; // keep the known name
      return { peer: this._webPeer(cid, { name }) };
    }

    // Another desktop
    const from = req.headers['x-snap-from'];
    if (!from || from === this.id) return this._json(res, 400, { error: 'missing sender' }), null;
    const name = safeDecode(req.headers['x-snap-name']) || 'Unknown device';
    const host = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const port = Number(req.headers['x-snap-port']) || DEFAULT_PORT;
    const platform = String(req.headers['x-snap-platform'] || 'unknown').slice(0, 16);
    this.upsertPeer({ id: from, name, platform, host, port });
    const peer = this.peers.get(from);

    const known = this.trust.incoming[from];
    if (known) {
      if (safeEqual(req.headers['x-snap-key'] || '', known)) return { peer };
      return this._json(res, 403, { error: 'bad key' }), null; // id spoofing or stale pairing
    }

    if (kind === 'clipboard') return this._json(res, 403, { error: 'clipboard requires pairing' }), null;

    const batchKey = `${from}:${req.headers['x-snap-batch'] || ''}`;
    if (req.headers['x-snap-batch'] && (this.batches.get(batchKey) || 0) > Date.now()) return { peer };

    const decision = await this.approve({ peer: this.publicPeer(peer), kind, ...meta });
    if (decision === 'deny' || !decision) return this._json(res, 403, { error: 'denied' }), null;
    if (req.headers['x-snap-batch']) this.batches.set(batchKey, Date.now() + BATCH_TTL_MS);
    if (decision === 'always') {
      const key = randomId(16);
      this.trust.incoming[from] = key;
      this.emit('trust-changed', this.trust);
      return { peer, key };
    }
    return { peer };
  }

  async _receiveFile(req, res, url) {
    const name = safeFileName(safeDecode(req.headers['x-snap-filename']) || url.searchParams.get('name') || 'file');
    const size = Number(req.headers['content-length']) || 0;
    const auth = await this._authorize(req, res, url, 'file', { name, size });
    if (!auth) return req.resume();

    const target = uniquePath(this.downloadDir, name);
    const partial = target + '.snapdrop-part';
    const transferId = randomId(6);
    let got = 0;
    const meter = new Transform({
      transform: (chunk, _e, cb) => {
        got += chunk.length;
        this.emit('progress', { id: transferId, direction: 'in', peer: auth.peer.name, name, sent: got, total: size });
        cb(null, chunk);
      },
    });
    try {
      await pipeline(req, meter, fs.createWriteStream(partial));
      if (size && got !== size) throw new Error('incomplete');
      fs.renameSync(partial, target);
    } catch (err) {
      fs.rmSync(partial, { force: true });
      if (['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'ENOENT'].includes(err.code)) {
        // Disk problem on this computer (no permission for Downloads, disk full…), not the network.
        this.emit('save-error', { dir: this.downloadDir, code: err.code, name });
        if (!res.headersSent) this._json(res, 507, { error: 'save-failed', code: err.code });
      } else if (!res.headersSent) this._json(res, 400, { error: 'upload interrupted' });
      return;
    }
    const out = { path: target, name: path.basename(target), size: got, from: this.publicPeer(auth.peer) };
    this.emit('file-received', out);
    this._json(res, 200, { ok: true, ...(auth.key ? { key: auth.key } : {}) });
  }

  async _receiveText(req, res, url) {
    // Read body first (it is small) so we know whether this is clipboard sync.
    const chunks = [];
    let total = 0;
    for await (const c of req) {
      total += c.length;
      if (total > MAX_TEXT_BYTES) return this._json(res, 413, { error: 'too large' });
      chunks.push(c);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return this._json(res, 400, { error: 'bad json' }); }
    const text = String(body.text ?? '');
    const kind = body.kind === 'clipboard' ? 'clipboard' : 'message';
    if (kind === 'clipboard' && !this.acceptClipboard()) return this._json(res, 409, { error: 'clipboard sync off' });

    const auth = await this._authorize(req, res, url, kind, { preview: text.slice(0, 120) });
    if (!auth) return;
    this.emit('text-received', { text, kind, from: this.publicPeer(auth.peer) });
    this._json(res, 200, { ok: true, ...(auth.key ? { key: auth.key } : {}) });
  }

  _serveDownload(req, res, url) {
    if (!safeEqual(url.searchParams.get('t') || '', this.webToken)) return this._json(res, 401, { error: 'bad token' });
    const item = this.staged.get(url.pathname.split('/').pop());
    if (!item || item.expires < Date.now() || !fs.existsSync(item.path)) return this._json(res, 404, { error: 'expired' });
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': item.size,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(item.name)}`,
      'cache-control': 'no-store',
    });
    fs.createReadStream(item.path).pipe(res);
  }

  _serveStatic(res, p) {
    const rel = p === '/' ? 'index.html' : decodeURIComponent(p).replace(/^\/+/, '');
    const file = path.resolve(this.webRoot, rel);
    if (!file.startsWith(path.resolve(this.webRoot) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return this._json(res, 404, { error: 'not found' });
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  /* ------------------------------------------------------------------ phones (WebSocket) */

  /*
   * Delivery to phones has to survive the phone going to sleep: mobile browsers freeze
   * background tabs and drop sockets without closing them. So every message goes into a
   * per-phone outbox with a sequence number; the phone acks what it has shown and, on
   * reconnect, says "since N" — everything newer is replayed. Heartbeats in both
   * directions catch sockets that look open but are dead.
   */
  _upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws' || !safeEqual(url.searchParams.get('t') || '', this.webToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const name = (url.searchParams.get('name') || 'Phone').slice(0, 40);
      const ua = req.headers['user-agent'] || '';
      const platform = /iphone|ipad|ios/i.test(ua) ? 'ios' : /android/i.test(ua) ? 'android' : 'web';
      const sameEpoch = url.searchParams.get('epoch') === this.epoch;
      const since = sameEpoch ? Number(url.searchParams.get('since')) || 0 : 0;

      const known = this.peers.get(this._webId(url.searchParams.get('cid')));
      const wasListed = !!known;
      const wasOnline = !!known?.sockets.size;
      const peer = this._webPeer(url.searchParams.get('cid') || randomId(4), { name, quiet: true });
      const wid = peer.id;
      Object.assign(peer, { platform, host: (req.socket.remoteAddress || '').replace(/^::ffff:/, ''), lastSeen: Date.now() });
      peer.acked = Math.max(peer.acked, since);
      peer.sockets.add(ws); // several tabs / overlapping reconnects are fine — all get messages
      this._settleAcks(peer);
      this.emit(wasListed || wasOnline ? 'peer-update' : 'peer-up', this.publicPeer(peer));

      ws.send(JSON.stringify({ type: 'hello', id: wid, epoch: this.epoch, device: this.info(), appearance: this.appearance() }));
      for (const m of peer.outbox) if (m.seq > since) ws.send(JSON.stringify(m));

      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('message', (raw) => {
        ws.isAlive = true;
        peer.lastSeen = Date.now();
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
        else if (msg.type === 'ack' && Number(msg.seq) > peer.acked) {
          peer.acked = Math.min(Number(msg.seq), peer.seq);
          this._settleAcks(peer);
          this.emit('peer-update', this.publicPeer(peer));
        }
      });
      const beat = setInterval(() => {
        if (!ws.isAlive) return ws.terminate(); // no pong since last beat: the phone is gone
        ws.isAlive = false;
        try { ws.ping(); } catch { /* closing */ }
      }, this.heartbeatMs);
      ws.on('close', () => {
        clearInterval(beat);
        peer.sockets.delete(ws);
        peer.lastSeen = Date.now();
        // Keep the phone listed (offline): messages sent now are queued for its return.
        if (!peer.sockets.size && this.peers.get(wid) === peer) this.emit('peer-update', this.publicPeer(peer));
      });
      ws.on('error', () => {});
    });
  }

  _webId(cid) {
    return 'web-' + String(cid || '').replace(/[^a-z0-9]/gi, '').slice(0, 16);
  }

  /** Find or create the record for a phone (it may currently be offline). */
  _webPeer(cid, { name, quiet = false } = {}) {
    const id = this._webId(cid || 'anon');
    let peer = this.peers.get(id);
    if (!peer) {
      peer = { id, kind: 'web', name: name || 'Phone', platform: 'web', sockets: new Set(), outbox: [], seq: 0, acked: 0, waiters: new Map(), lastSeen: Date.now() };
      this.peers.set(id, peer);
      if (!quiet) this.emit('peer-up', this.publicPeer(peer));
    }
    if (name) peer.name = name;
    return peer;
  }

  /** Queue a message for a phone and resolve true once the phone confirms it, false if it is asleep. */
  _pushToWeb(peer, msg) {
    msg.seq = ++peer.seq;
    msg.ts = Date.now();
    peer.outbox.push(msg);
    if (peer.outbox.length > OUTBOX_MAX) peer.outbox.splice(0, peer.outbox.length - OUTBOX_MAX);
    const data = JSON.stringify(msg);
    for (const ws of peer.sockets) if (ws.readyState === 1) ws.send(data);
    this.emit('peer-update', this.publicPeer(peer));
    if (!peer.sockets.size) return Promise.resolve(false);
    return new Promise((resolve) => {
      const t = setTimeout(() => { peer.waiters.delete(msg.seq); resolve(false); }, ACK_WAIT_MS);
      peer.waiters.set(msg.seq, (ok) => { clearTimeout(t); resolve(ok); });
    });
  }

  _settleAcks(peer) {
    for (const [seq, done] of peer.waiters) {
      if (seq <= peer.acked) { peer.waiters.delete(seq); done(true); }
    }
  }

  /* ------------------------------------------------------------------ helpers */

  _json(res, status, obj) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  _gc() {
    const now = Date.now();
    for (const [k, exp] of this.batches) if (exp < now) this.batches.delete(k);
    for (const [k, s] of this.staged) if (s.expires < now) this.staged.delete(k);
    for (const p of [...this.peers.values()]) {
      if (p.kind === 'web' && !p.sockets.size && now - p.lastSeen > WEB_PEER_TTL_MS) this.removePeer(p.id);
    }
  }
}

function safeDecode(v) {
  if (!v) return '';
  try { return decodeURIComponent(String(v)); } catch { return String(v); }
}

function httpJson({ host, port, path: p, method, headers = {}, body, timeout = 10000 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path: p, method, headers: { ...headers, ...(body ? { 'content-length': body.length } : {}) }, timeout }, (res) => {
      let buf = '';
      res.on('data', (d) => (buf += d));
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(buf || '{}'); } catch { /* ignore */ }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
        else {
          const err = new Error(json.error === 'denied' ? 'The other device declined' : json.error || `HTTP ${res.statusCode}`);
          err.status = res.statusCode;
          err.code = json.error;
          reject(err);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Device did not respond')));
    req.on('error', reject);
    req.end(body);
  });
}

module.exports = { SnapNode, DEFAULT_PORT, httpJson };
