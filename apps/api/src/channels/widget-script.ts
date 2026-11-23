/**
 * The website chat widget, served at /api/v1/widget.js. Install with:
 *   <script src="https://YOUR-DOMAIN/api/v1/widget.js" data-key="CHANNEL_KEY" async></script>
 * Plain JS, no dependencies, Shadow DOM so the host page's CSS cannot break it. Everything shown is inserted with
 * textContent (never innerHTML), so a message can never inject markup into the customer's website.
 */
export const WIDGET_SCRIPT = String.raw`(function () {
  var script = document.currentScript;
  if (!script) { var all = document.getElementsByTagName('script'); script = all[all.length - 1]; }
  var key = script && script.getAttribute('data-key');
  if (!key || window.__microagentWidget === key) return;
  window.__microagentWidget = key;
  var base = new URL(script.src).origin + '/api/v1/widget/' + encodeURIComponent(key);
  var store = 'ma_widget_' + key;
  var state = { token: null, last: null, open: false, cfg: null, seen: {}, unread: 0, timer: null };
  try { state.token = localStorage.getItem(store); } catch (e) {}

  function api(path, opts) {
    opts = opts || {};
    return fetch(base + path, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : undefined, body: opts.body ? JSON.stringify(opts.body) : undefined })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) { var e = new Error((j.error && j.error.message) || 'Request failed'); e.status = r.status; throw e; } return j; }); });
  }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  api('/config').then(function (cfg) { state.cfg = cfg; build(); }).catch(function () { /* widget stays hidden if the channel is unavailable */ });

  function build() {
    var color = state.cfg.color || '#8B1E3F';
    var host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;right:20px;bottom:20px;z-index:2147483000;';
    var root = host.attachShadow({ mode: 'open' });
    var css = document.createElement('style');
    css.textContent = ':host{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}*{box-sizing:border-box}' +
      '.btn{width:56px;height:56px;border-radius:50%;border:0;background:' + color + ';color:#fff;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.25);font-size:24px;position:relative}' +
      '.badge{position:absolute;top:-4px;right:-4px;background:#fff;color:' + color + ';border-radius:10px;font-size:11px;min-width:18px;height:18px;line-height:18px;font-weight:700;box-shadow:0 1px 4px rgba(0,0,0,.3)}' +
      '.panel{position:absolute;right:0;bottom:70px;width:340px;max-width:calc(100vw - 32px);height:480px;max-height:calc(100vh - 110px);background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);display:none;flex-direction:column;overflow:hidden}' +
      '.panel.open{display:flex}.head{background:' + color + ';color:#fff;padding:14px 16px;font-weight:600;font-size:15px}' +
      '.list{flex:1;overflow-y:auto;padding:12px;background:#f6f4f5;display:flex;flex-direction:column;gap:8px}' +
      '.m{max-width:82%;padding:8px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}' +
      '.v{align-self:flex-end;background:' + color + ';color:#fff;border-bottom-right-radius:4px}.a{align-self:flex-start;background:#fff;color:#222;border-bottom-left-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.08)}' +
      '.m a{color:inherit;text-decoration:underline}.err{align-self:center;color:#b00020;font-size:12px}' +
      '.row{display:flex;gap:8px;padding:10px;border-top:1px solid #e6e1e3;background:#fff}' +
      'input{flex:1;border:1px solid #d9d2d5;border-radius:20px;padding:9px 14px;font-size:14px;outline:none}input:focus{border-color:' + color + '}' +
      '.send{border:0;background:' + color + ';color:#fff;border-radius:20px;padding:0 16px;cursor:pointer;font-size:14px}.send:disabled{opacity:.5}';
    var btn = el('button', 'btn', '\u{1F4AC}'); btn.setAttribute('aria-label', 'Open chat');
    var badge = el('span', 'badge', ''); badge.style.display = 'none'; btn.appendChild(badge);
    var panel = el('div', 'panel'); panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', state.cfg.title || 'Chat');
    var head = el('div', 'head', state.cfg.title || 'Chat with us');
    var list = el('div', 'list'); list.setAttribute('aria-live', 'polite');
    var row = el('form', 'row'); var input = el('input'); input.placeholder = 'Type your message'; input.maxLength = 2000; input.setAttribute('aria-label', 'Message');
    var send = el('button', 'send', 'Send'); send.type = 'submit'; row.appendChild(input); row.appendChild(send);
    panel.appendChild(head); panel.appendChild(list); panel.appendChild(row);
    root.appendChild(css); root.appendChild(panel); root.appendChild(btn);
    document.body.appendChild(host);
    if (state.cfg.welcome) add({ id: 'welcome', from: 'agent', text: state.cfg.welcome });

    function add(m) {
      if (state.seen[m.id]) return; state.seen[m.id] = 1;
      var d = el('div', 'm ' + (m.from === 'visitor' ? 'v' : 'a'));
      if (m.text) d.appendChild(document.createTextNode(m.text));
      (m.attachments || []).forEach(function (a) { var l = el('a', null, '\u{1F4CE} ' + a.name); l.href = a.url; l.target = '_blank'; l.rel = 'noopener'; var w = el('div'); w.appendChild(l); d.appendChild(w); });
      list.appendChild(d); list.scrollTop = list.scrollHeight;
      if (m.from !== 'visitor' && m.id !== 'welcome' && !state.open) { state.unread++; badge.textContent = state.unread; badge.style.display = 'block'; }
    }
    function note(t) { var d = el('div', 'err', t); list.appendChild(d); list.scrollTop = list.scrollHeight; setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 6000); }
    function ensureSession() {
      if (state.token) return Promise.resolve();
      return api('/session', { method: 'POST', body: {} }).then(function (s) { state.token = s.token; try { localStorage.setItem(store, s.token); } catch (e) {} });
    }
    function poll() {
      if (!state.token) return;
      var q = '?token=' + encodeURIComponent(state.token) + (state.last ? '&after=' + encodeURIComponent(state.last) : '');
      api('/messages' + q).then(function (r) { (r.messages || []).forEach(function (m) { add(m); state.last = m.id; }); })
        .catch(function (e) { if (e.status === 401) { state.token = null; state.last = null; try { localStorage.removeItem(store); } catch (x) {} } });
    }
    function schedule() { clearInterval(state.timer); state.timer = setInterval(poll, state.open ? 3000 : 20000); }
    btn.addEventListener('click', function () {
      state.open = !state.open; panel.classList.toggle('open', state.open);
      if (state.open) { state.unread = 0; badge.style.display = 'none'; input.focus(); }
      schedule(); poll();
    });
    row.addEventListener('submit', function (ev) {
      ev.preventDefault(); var text = input.value.trim(); if (!text) return;
      var cid = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      send.disabled = true;
      ensureSession().then(function () { return api('/messages', { method: 'POST', body: { token: state.token, text: text, clientMsgId: cid } }); })
        .then(function () { input.value = ''; poll(); })
        .catch(function (e) { note(e.status === 429 ? 'Too many messages, please wait a moment.' : 'Message not sent. Try again.'); })
        .then(function () { send.disabled = false; input.focus(); });
    });
    if (state.token) { schedule(); poll(); } else schedule();
  }
})();
`;
