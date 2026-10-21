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
  let ws = null;
  let retry = 0;

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

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws?t=${encodeURIComponent(token)}&cid=${cid}&name=${encodeURIComponent(myName)}`);
    ws.onopen = () => { retry = 0; };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'hello') {
        webId = msg.id;
        $('targetName').textContent = msg.device.name;
        $('targetIcon').textContent = { mac: '💻', windows: '🖥️', linux: '🐧' }[msg.device.platform] || '💻';
        setStatus(true, 'connected');
      } else if (msg.type === 'file') addFile(msg);
      else if (msg.type === 'text') addText(msg);
    };
    ws.onclose = (e) => {
      webId = null;
      if (e.code === 4001) { store.set('snap.token', ''); $('app').hidden = true; $('gate').hidden = false; setStatus(false, 'link expired'); return; }
      setStatus(false, 'reconnecting…');
      setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
    };
  }
  connect();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && (!ws || ws.readyState > 1)) connect();
  });

  /* ---------------- inbox ---------------- */
  function addItem(node) {
    $('empty')?.remove();
    $('inbox').prepend(node);
    if (navigator.vibrate) navigator.vibrate(30);
  }

  function addFile(msg) {
    const el = document.createElement('div');
    el.className = 'card item';
    el.innerHTML = `<div class="top"><span class="name"></span><a class="btn accent" download>Save</a></div><div class="meta"></div>`;
    el.querySelector('.name').textContent = msg.name;
    el.querySelector('.meta').textContent = `${fmt(msg.size)} · from ${msg.from}`;
    const a = el.querySelector('a');
    a.href = msg.url;
    a.setAttribute('download', msg.name);
    addItem(el);
    toast(`${msg.name} received — tap Save`);
  }

  function addText(msg) {
    const el = document.createElement('div');
    el.className = 'card item';
    el.innerHTML = `<pre></pre><div class="top"><span class="meta" style="flex:1"></span><button class="btn">Copy</button></div>`;
    el.querySelector('pre').textContent = msg.text;
    el.querySelector('.meta').textContent = `from ${msg.from}${msg.kind === 'clipboard' ? ' · clipboard' : ''}`;
    const linkMatch = /^https?:\/\/\S+$/.test(msg.text.trim());
    if (linkMatch) {
      const open = document.createElement('a');
      open.className = 'btn ghost'; open.textContent = 'Open'; open.href = msg.text.trim(); open.target = '_blank'; open.rel = 'noopener';
      el.querySelector('.top').insertBefore(open, el.querySelector('button'));
    }
    el.querySelector('button').onclick = () => copy(msg.text);
    addItem(el);
  }

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
