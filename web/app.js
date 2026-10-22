/* SnapDrop phone client — plain JS so it runs on any mobile browser with nothing to install. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  // Token comes from the QR code URL; keep it so a reload or home-screen launch still works.
  const params = new URLSearchParams(location.search);
  const token = params.get('t') || store.get('snap.token');
  if (params.get('t')) {
    store.set('snap.token', params.get('t'));
    history.replaceState(null, '', location.pathname); // keep the token out of screenshots/history
  }
  let cid = store.get('snap.cid');
  if (!cid) { cid = Math.random().toString(36).slice(2, 10); store.set('snap.cid', cid); }
  const ua = navigator.userAgent;
  const myName = store.get('snap.name') || (/iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : 'Browser');

  let webId = null;
  let ws = null;          // the one live socket; stale sockets are ignored by generation number
  let gen = 0;
  let retry = 0;
  let retryTimer = null;
  let lastHeard = 0;      // any message from the computer, pongs included

  // Delivery state survives reloads: iOS often discards a background tab and reloads it later.
  let epoch = store.get('snap.epoch') || '';
  let lastSeq = Number(store.get('snap.seq')) || 0;
  let inbox = [];
  try { inbox = JSON.parse(store.get('snap.inbox') || '[]'); } catch { inbox = []; }
  const INBOX_MAX = 60;

  const toast = (msg) => {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.h);
    toast.h = setTimeout(() => t.classList.remove('show'), 2200);
  };
  const fmt = (n) => n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`;
  const setStatus = (on, text) => { $('dot').className = 'dot ' + (on ? 'on' : 'off'); $('statusText').textContent = text; };

  if (!token) { $('gate').hidden = false; setStatus(false, 'not paired'); return; }
  $('app').hidden = false;

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({ t: token, cid, name: myName, epoch, since: String(lastSeq) });
    return `${proto}://${location.host}/ws?${q}`;
  }

  function connect() {
    clearTimeout(retryTimer);
    if (ws) { ws.onclose = ws.onmessage = ws.onerror = null; try { ws.close(); } catch { /* already gone */ } }
    const my = ++gen;
    const sock = new WebSocket(wsUrl());
    ws = sock;
    setStatus(false, 'connecting…');
    sock.onopen = () => { if (my === gen) { retry = 0; lastHeard = Date.now(); } };
    sock.onmessage = (e) => {
      if (my !== gen) return;
      lastHeard = Date.now();
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'hello') {
        webId = msg.id;
        if (msg.epoch !== epoch) { epoch = msg.epoch; lastSeq = 0; store.set('snap.epoch', epoch); store.set('snap.seq', '0'); }
        $('targetName').textContent = msg.device.name;
        $('targetIcon').textContent = { mac: '💻', windows: '🖥️', linux: '🐧' }[msg.device.platform] || '💻';
        setStatus(true, 'connected');
      } else if (msg.type === 'file' || msg.type === 'text') {
        receive(msg);
      }
    };
    sock.onclose = (e) => {
      if (my !== gen) return;
      ws = null;
      webId = null;
      if (e.code === 4001) { store.set('snap.token', ''); $('app').hidden = true; $('gate').hidden = false; setStatus(false, 'link expired — scan the QR again'); return; }
      setStatus(false, 'reconnecting…');
      retryTimer = setTimeout(connect, Math.min(5000, 400 * 2 ** retry++));
    };
  }

  function send(obj) {
    if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch { /* closing */ } }
  }

  // A socket can look open while being dead (phone slept, Wi‑Fi switched). Ping it and
  // reconnect if the computer stays silent — reconnecting also fetches anything missed.
  setInterval(() => {
    if (document.hidden) return;
    if (!ws || ws.readyState > 1) return connect();
    if (ws.readyState === 1) {
      if (Date.now() - lastHeard > 25000) return connect();
      send({ type: 'ping' });
    }
  }, 8000);

  function wakeUp() {
    if (document.hidden) return;
    if (!ws || ws.readyState !== 1) return connect();
    const asked = Date.now();
    send({ type: 'ping' });
    setTimeout(() => { if (lastHeard < asked) connect(); }, 2500);
  }
  document.addEventListener('visibilitychange', wakeUp);
  window.addEventListener('pageshow', wakeUp);
  window.addEventListener('focus', wakeUp);
  window.addEventListener('online', () => connect());
  connect();

  /* ---------------- inbox ---------------- */
  function receive(msg) {
    const key = `${epoch}:${msg.seq}`;
    if (msg.seq > lastSeq) { lastSeq = msg.seq; store.set('snap.seq', String(lastSeq)); }
    if (!inbox.some((it) => it.key === key)) {
      const item = { key, type: msg.type, from: msg.from, ts: msg.ts || Date.now(), text: msg.text, kind: msg.kind, name: msg.name, size: msg.size, url: msg.url };
      inbox.unshift(item);
      inbox = inbox.slice(0, INBOX_MAX);
      store.set('snap.inbox', JSON.stringify(inbox));
      render(item, true);
    }
    send({ type: 'ack', seq: lastSeq }); // tells the computer it arrived
  }

  function render(item, fresh) {
    const el = item.type === 'file' ? fileCard(item) : textCard(item);
    $('empty')?.remove();
    $('clearInbox').hidden = false;
    if (fresh) {
      $('inbox').prepend(el);
      el.classList.add('fresh');
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      if (navigator.vibrate) navigator.vibrate(30);
      toast(item.type === 'file' ? `${item.name} received — tap Save` : 'New text received');
    } else {
      $('inbox').appendChild(el);
    }
  }

  const when = (ts) => {
    const d = new Date(ts);
    const today = new Date().toDateString() === d.toDateString();
    return (today ? '' : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ') + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  function fileCard(item) {
    const el = document.createElement('div');
    el.className = 'card item';
    el.innerHTML = `<div class="top"><span class="name"></span><a class="btn accent" download>Save</a></div><div class="meta"></div>`;
    el.querySelector('.name').textContent = item.name;
    el.querySelector('.meta').textContent = `${fmt(item.size)} · from ${item.from} · ${when(item.ts)}`;
    const a = el.querySelector('a');
    a.href = item.url;
    a.setAttribute('download', item.name);
    return el;
  }

  function textCard(item) {
    const el = document.createElement('div');
    el.className = 'card item';
    el.innerHTML = `<pre></pre><div class="top"><span class="meta" style="flex:1"></span><button class="btn">Copy</button></div>`;
    el.querySelector('pre').textContent = item.text;
    el.querySelector('.meta').textContent = `from ${item.from}${item.kind === 'clipboard' ? ' · clipboard' : ''} · ${when(item.ts)}`;
    const t = (item.text || '').trim();
    if (/^https?:\/\/\S+$/.test(t)) {
      const open = document.createElement('a');
      open.className = 'btn ghost'; open.textContent = 'Open'; open.href = t; open.target = '_blank'; open.rel = 'noopener';
      el.querySelector('.top').insertBefore(open, el.querySelector('button'));
    }
    el.querySelector('button').onclick = () => copy(item.text);
    return el;
  }

  inbox.forEach((it) => render(it, false));
  $('clearInbox').onclick = () => {
    inbox = [];
    store.set('snap.inbox', '[]');
    $('inbox').innerHTML = '<div class="empty" id="empty">Files and text sent from the computer appear here.</div>';
    $('clearInbox').hidden = true;
  };

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); }
    catch {
      // navigator.clipboard needs HTTPS on most browsers; plain-HTTP LAN fallback:
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast('Copied');
  }

  /* ---------------- sending ---------------- */
  function upload(file) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('x-snap-token', token);
      if (webId) xhr.setRequestHeader('x-snap-web-id', webId);
      xhr.setRequestHeader('x-snap-filename', encodeURIComponent(file.name || 'file'));
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) $('bar').firstElementChild.style.width = `${(e.loaded / e.total) * 100}%`; };
      xhr.onload = () => (xhr.status === 200 ? resolve() : reject(new Error(xhr.status === 401 ? 'Link expired — rescan QR' : `Failed (${xhr.status})`)));
      xhr.onerror = () => reject(new Error('Connection lost'));
      xhr.send(file);
    });
  }

  async function sendFiles(files) {
    if (!files.length) return;
    $('bar').hidden = false;
    let ok = 0;
    for (const f of files) {
      $('bar').firstElementChild.style.width = '0';
      try { await upload(f); ok++; } catch (e) { toast(e.message); break; }
    }
    $('bar').hidden = true;
    if (ok) toast(ok === 1 ? `Sent ${files[0].name}` : `Sent ${ok} files`);
  }

  $('fileInput').addEventListener('change', (e) => { sendFiles([...e.target.files]); e.target.value = ''; });
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('hover'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('hover')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); sendFiles([...e.dataTransfer.files]); });

  $('sendText').onclick = async () => {
    const text = $('text').value;
    if (!text.trim()) return;
    const r = await fetch('/api/text', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-snap-token': token, ...(webId ? { 'x-snap-web-id': webId } : {}) },
      body: JSON.stringify({ text, kind: 'message' }),
    }).catch(() => null);
    if (r && r.ok) { $('text').value = ''; toast('Sent — it’s on the computer’s clipboard'); }
    else toast('Could not send');
  };

  $('pasteBtn').onclick = async () => {
    try { $('text').value = await navigator.clipboard.readText(); }
    catch { $('text').focus(); toast('Long-press the box and choose Paste'); }
  };
})();
