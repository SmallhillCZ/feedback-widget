(() => {
  'use strict';

  if (window.__feedbackWidget) return;
  const script =
    document.currentScript || document.querySelector('script[src*="widget.js"][data-repo]');
  if (!script) return;

  const ds = script.dataset;
  const scriptOrigin = new URL(script.src, location.href).origin;
  const cfg = {
    repo: (ds.repo || '').trim(),
    branch: (ds.branch || 'main').trim(),
    app: (ds.app || '').trim(),
    auth: (ds.auth || scriptOrigin).replace(/\/+$/, ''),
    api: (ds.api || 'https://api.github.com').replace(/\/+$/, ''),
    label: ds.label || 'feedback',
    poll: Math.max(1, Number(ds.poll) || 30) * 1000,
  };
  if (!/^[\w.-]+\/[\w.-]+$/.test(cfg.repo)) {
    console.warn('[feedback-widget] data-repo="owner/repo" is required');
    return;
  }
  cfg.authOrigin = new URL(cfg.auth, location.href).origin;
  window.__feedbackWidget = { version: 1, cfg };

  const AUTH_KEY = `feedback-widget:auth:${cfg.authOrigin}`;
  const PREFS_KEY = 'feedback-widget:prefs';
  const FOCUS_KEY = 'feedback-widget:focus';
  const META_RE = /<!--\s*feedback-meta\s+(\{[\s\S]*?\})\s*-->/;
  const TABLE_RE = /\n*\|\s*Field\s*\|\s*Value\s*\|[\s\S]*$/;

  const storage = {
    get(key, area = localStorage) {
      try {
        return JSON.parse(area.getItem(key));
      } catch {
        return null;
      }
    },
    set(key, value, area = localStorage) {
      try {
        if (value === null || value === undefined) area.removeItem(key);
        else area.setItem(key, JSON.stringify(value));
      } catch {}
    },
  };

  const state = {
    auth: validAuth(storage.get(AUTH_KEY)),
    issues: new Map(),
    comments: new Map(),
    mode: false,
    showResolved: Boolean((storage.get(PREFS_KEY) || {}).showResolved),
    panelOpen: false,
    hover: null,
    draft: null,
    thread: null,
    loaded: false,
    href: location.href,
    focus: storage.get(FOCUS_KEY, sessionStorage),
    pending: new Map(),
  };

  function validAuth(a) {
    if (!a || typeof a.token !== 'string' || !a.user) return null;
    if (a.expiresAt && a.expiresAt < Date.now() + 60 * 1000) return null;
    return a;
  }

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const CSS = `
:host{all:initial}
*{box-sizing:border-box}
.root{--purple:#7c3aed;--orange:#f08c00;--green:#2f9e44;--card:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--soft:#f6f8fa;--bar:#1f1f23;
font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--fg);-webkit-font-smoothing:antialiased}
@media (prefers-color-scheme:dark){.root{--card:#1c2128;--fg:#e6edf3;--muted:#8d96a0;--line:#373e47;--soft:#22272e;--bar:#000}}
button{font:inherit;color:inherit;cursor:pointer;border:0;background:none;padding:0}
textarea{font:inherit;color:var(--fg);background:var(--card);width:100%;min-height:72px;max-height:240px;resize:vertical;border:1px solid var(--line);border-radius:8px;padding:8px 10px;outline:none}
textarea:focus{border-color:var(--purple);box-shadow:0 0 0 3px rgba(124,58,237,.18)}
a{color:var(--purple)}
.bar{position:fixed;right:16px;bottom:16px;display:flex;align-items:center;gap:4px;padding:4px;background:var(--bar);color:#fff;border-radius:999px;box-shadow:0 6px 24px rgba(0,0,0,.28);z-index:3;user-select:none}
.bar button{height:34px;padding:0 14px;border-radius:999px;font-weight:600;white-space:nowrap}
.bar button:hover{background:rgba(255,255,255,.12)}
.bar .on{background:var(--purple)!important}
.bar .icon{width:34px;padding:0;display:grid;place-items:center}
.bar img{width:26px;height:26px;border-radius:50%;display:block}
.count{display:inline-block;min-width:18px;margin-left:6px;padding:0 5px;border-radius:9px;background:rgba(255,255,255,.18);font-size:11px;line-height:18px;text-align:center}
.hl{position:fixed;pointer-events:none;border:2px solid var(--purple);background:rgba(124,58,237,.08);border-radius:3px;z-index:1}
.hl-label{position:absolute;left:-2px;bottom:100%;margin-bottom:4px;padding:2px 7px;border-radius:4px;background:var(--purple);color:#fff;font-size:11px;font-weight:600;white-space:nowrap;max-width:420px;overflow:hidden;text-overflow:ellipsis}
.hl-label.below{bottom:auto;top:100%;margin:4px 0 0}
.pin{position:fixed;width:28px;height:28px;margin:-28px 0 0 0;border-radius:50% 50% 50% 0;background:var(--purple);color:#fff;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.3);font-size:11px;font-weight:700;display:grid;place-items:center;z-index:2;transition:transform .1s}
.pin:hover,.pin.active{transform:scale(1.15)}
.pin.answered{background:var(--orange)}
.pin.closed{background:var(--green)}
.pin.lost{opacity:.55;border-style:dashed}
.pin.draft{background:var(--purple);opacity:.85}
.pop{position:fixed;width:340px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);z-index:4;padding:12px}
.pop-head{display:flex;align-items:center;gap:8px;margin-bottom:8px;color:var(--muted);font-size:12px}
.pop-head .grow{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.x{width:24px;height:24px;border-radius:6px;font-size:16px;line-height:24px;color:var(--muted)}
.x:hover{background:var(--soft)}
.actions{display:flex;align-items:center;gap:8px;margin-top:8px}
.actions .grow{flex:1}
.btn{height:30px;padding:0 12px;border-radius:6px;font-weight:600;border:1px solid var(--line);background:var(--card)}
.btn:hover{background:var(--soft)}
.btn.primary{background:var(--purple);border-color:var(--purple);color:#fff}
.btn.primary:hover{filter:brightness(1.1)}
.btn:disabled{opacity:.5;cursor:default}
.hint{color:var(--muted);font-size:11px}
.msg{display:flex;gap:8px;padding:8px 0;border-top:1px solid var(--line)}
.msg:first-of-type{border-top:0;padding-top:0}
.msg img{width:24px;height:24px;border-radius:50%;flex:none}
.msg .who{font-weight:600}
.msg .when{color:var(--muted);font-size:11px;margin-left:4px}
.msg .text{white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere}
.status{display:inline-block;padding:0 7px;border-radius:9px;color:#fff;font-size:11px;font-weight:600;background:var(--purple)}
.status.answered{background:var(--orange)}
.status.closed{background:var(--green)}
.note{margin-top:8px;padding:6px 8px;border-radius:6px;background:var(--soft);color:var(--muted);font-size:11px}
.err{color:#cf222e;font-size:12px;margin-top:6px}
.panel{position:fixed;right:16px;bottom:64px;width:360px;max-width:calc(100vw - 32px);max-height:min(70vh,560px);display:flex;flex-direction:column;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.25);z-index:4}
.panel-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line)}
.panel-head strong{flex:1}
.panel-head label{display:flex;align-items:center;gap:4px;color:var(--muted);font-size:12px;cursor:pointer}
.items{overflow:auto;padding:4px}
.item{display:flex;gap:10px;width:100%;text-align:left;padding:8px;border-radius:8px}
.item:hover{background:var(--soft)}
.item.here{box-shadow:inset 3px 0 0 var(--purple)}
.dot{flex:none;width:22px;height:22px;border-radius:50% 50% 50% 0;background:var(--purple);color:#fff;font-size:10px;font-weight:700;display:grid;place-items:center}
.dot.answered{background:var(--orange)}
.dot.closed{background:var(--green)}
.item .t{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item .s{color:var(--muted);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item .body{min-width:0;flex:1}
.empty{padding:20px;text-align:center;color:var(--muted)}
.toast{position:fixed;left:50%;bottom:72px;transform:translateX(-50%);max-width:min(520px,calc(100vw - 32px));padding:9px 14px;border-radius:8px;background:var(--bar);color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.28);z-index:5}
.toast.error{background:#cf222e}
[hidden]{display:none!important}
`;

  const host = h('feedback-widget', { 'data-feedback-widget': '' });
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });
  const root = h('div', { class: 'root' });
  shadow.append(h('style', {}, CSS), root);

  const ui = {
    hl: h('div', { class: 'hl', hidden: true }),
    hlLabel: h('div', { class: 'hl-label' }),
    pins: h('div', { class: 'pins' }),
    pop: h('div', { class: 'pop', hidden: true }),
    panel: h('div', { class: 'panel', hidden: true }),
    bar: h('div', { class: 'bar' }),
    toast: h('div', { class: 'toast', hidden: true, role: 'status' }),
  };
  ui.hl.append(ui.hlLabel);
  root.append(ui.hl, ui.pins, ui.pop, ui.panel, ui.bar, ui.toast);

  function mount() {
    if (!host.isConnected) document.documentElement.append(host);
  }

  const isOurs = (e) => e.composedPath().includes(host);

  let toastTimer;
  function toast(text, kind = 'info') {
    ui.toast.textContent = text;
    ui.toast.className = `toast ${kind}`;
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (ui.toast.hidden = true), kind === 'error' ? 8000 : 4000);
  }

  function pageKey(url = location) {
    let path = url.pathname.replace(/\/+$/, '') || '/';
    if (url.hash && url.hash.startsWith('#/')) path += url.hash.split('?')[0];
    return path;
  }

  function avatar(url, size = 48) {
    if (!url) return '';
    return `${url}${url.includes('?') ? '&' : '?'}s=${size}`;
  }

  function ago(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
    return new Date(iso).toLocaleDateString();
  }

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
    }
  }

  async function gh(path, { method = 'GET', body } = {}) {
    if (!state.auth) throw new ApiError(401, 'Not signed in');
    const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${state.auth.token}` };
    if (body) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(cfg.api + path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-cache' });
    } catch {
      throw new ApiError(0, 'GitHub is not reachable');
    }
    if (res.status === 401) {
      signOut();
      toast('Your GitHub sign-in expired. Sign in again.', 'error');
      throw new ApiError(401, 'Sign-in expired');
    }
    if (!res.ok) {
      let message = '';
      try {
        message = (await res.json()).message || '';
      } catch {}
      throw new ApiError(res.status, explain(res, message));
    }
    return res.status === 204 ? null : res.json();
  }

  function explain(res, message) {
    if (res.status === 404) return `Can't access ${cfg.repo}. Is the feedback GitHub App installed on it, and do you have access?`;
    if (res.status === 403 && /not accessible by integration/i.test(message)) return `The feedback GitHub App isn't installed on ${cfg.repo}, or you lack permission for this action.`;
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') return 'GitHub rate limit reached. Try again later.';
    if (res.status === 410) return `Issues are disabled on ${cfg.repo}.`;
    return message ? `GitHub: ${message}` : `GitHub error ${res.status}`;
  }

  function parseMeta(body) {
    const m = META_RE.exec(body || '');
    if (!m) return null;
    try {
      const meta = JSON.parse(m[1]);
      return meta && typeof meta === 'object' && typeof meta.page === 'string' ? meta : null;
    } catch {
      return null;
    }
  }

  function commentText(body) {
    return String(body || '')
      .replace(META_RE, '')
      .replace(TABLE_RE, '')
      .trim();
  }

  function toRecord(issue) {
    if (!issue || issue.pull_request) return null;
    const meta = parseMeta(issue.body);
    if (!meta) return null;
    if ((meta.app || '') !== cfg.app) return null;
    return {
      number: issue.number,
      title: issue.title,
      state: issue.state,
      comments: issue.comments || 0,
      url: issue.html_url,
      user: issue.user || {},
      created: issue.created_at,
      updated: issue.updated_at,
      labels: (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
      meta,
      text: commentText(issue.body),
    };
  }

  function status(rec) {
    if (rec.state === 'closed') return 'closed';
    return rec.comments > 0 ? 'answered' : 'open';
  }

  async function loadIssues() {
    const found = new Map();
    const add = (issue) => {
      const rec = toRecord(issue);
      if (rec) found.set(rec.number, rec);
    };
    for (let page = 1; page <= 10; page++) {
      const list = await gh(`/repos/${cfg.repo}/issues?labels=${encodeURIComponent(cfg.label)}&state=all&per_page=100&page=${page}`);
      list.forEach(add);
      if (list.length < 100) break;
    }
    const recent = await gh(`/repos/${cfg.repo}/issues?state=all&sort=created&direction=desc&per_page=100`);
    recent.forEach(add);
    return found;
  }

  let refreshing = null;
  function refresh() {
    if (!state.auth) return Promise.resolve();
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const before = state.issues;
        const next = await loadIssues();
        for (const [n, rec] of before) if (!next.has(n) && state.pending.has(n)) next.set(n, rec);
        state.issues = next;
        state.loaded = true;
        if (state.thread) {
          const rec = next.get(state.thread.number);
          const old = before.get(state.thread.number);
          if (rec && (!old || old.comments !== rec.comments || old.updated !== rec.updated)) loadComments(rec.number);
        }
      } catch (err) {
        if (err.status !== 401) toast(err.message, 'error');
      } finally {
        refreshing = null;
        renderAll();
      }
    })();
    return refreshing;
  }

  async function loadComments(number) {
    try {
      const list = await gh(`/repos/${cfg.repo}/issues/${number}/comments?per_page=100`);
      state.comments.set(number, list);
      const rec = state.issues.get(number);
      if (rec) rec.comments = list.length;
    } catch (err) {
      if (err.status !== 401) toast(err.message, 'error');
    }
    renderThread();
    renderPins();
    renderPanel();
  }

  let authResolve = null;
  function signIn() {
    const w = 600;
    const ht = 720;
    const left = Math.max(0, window.screenX + (window.outerWidth - w) / 2);
    const top = Math.max(0, window.screenY + (window.outerHeight - ht) / 2);
    const popup = window.open(
      `${cfg.auth}/auth/start?origin=${encodeURIComponent(location.origin)}`,
      'feedback-widget-auth',
      `popup,width=${w},height=${ht},left=${left},top=${top}`,
    );
    if (!popup) {
      toast('Allow pop-ups for this site to sign in with GitHub.', 'error');
      return Promise.resolve(false);
    }
    if (authResolve) authResolve(false);
    return new Promise((resolve) => {
      authResolve = resolve;
      const timer = setInterval(() => {
        if (!popup.closed) return;
        clearInterval(timer);
        setTimeout(() => {
          if (authResolve === resolve) {
            authResolve = null;
            resolve(false);
          }
        }, 500);
      }, 500);
    });
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== cfg.authOrigin) return;
    const d = e.data;
    if (!d || typeof d !== 'object' || d.type !== 'feedback-auth') return;
    const resolve = authResolve;
    authResolve = null;
    if (d.error || typeof d.token !== 'string' || !d.user || typeof d.user.login !== 'string') {
      toast(`Sign-in failed: ${d.error || 'invalid response'}`, 'error');
      if (resolve) resolve(false);
      return;
    }
    state.auth = {
      token: d.token,
      expiresAt: typeof d.expiresAt === 'number' ? d.expiresAt : null,
      user: { login: d.user.login, name: d.user.name || null, avatar_url: d.user.avatar_url || '', html_url: d.user.html_url || '' },
    };
    storage.set(AUTH_KEY, state.auth);
    toast(`Signed in as ${state.auth.user.login}`);
    renderAll();
    refresh();
    if (resolve) resolve(true);
  });

  function signOut() {
    state.auth = null;
    storage.set(AUTH_KEY, null);
    state.issues = new Map();
    state.comments = new Map();
    state.loaded = false;
    closePop();
    setMode(false);
    renderAll();
  }

  async function ensureSignedIn() {
    if (state.auth && validAuth(state.auth)) return true;
    if (state.auth) signOut();
    return signIn();
  }

  function goodId(id) {
    return id.length < 64 && !/\d{3,}|^(ng|mat|cdk|react|radix|headlessui|ember|mui|chakra)[-_:]|[:]/i.test(id);
  }

  const ATTR_ANCHORS = ['data-testid', 'data-test', 'data-cy', 'data-feedback-id'];

  function cssString(v) {
    return `"${String(v).replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a ')}"`;
  }

  function isUnique(sel) {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  }

  function selectorFor(el) {
    const parts = [];
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      if (node === document.body || node === document.documentElement) {
        parts.unshift(node.localName);
        break;
      }
      let part;
      if (node.id && goodId(node.id)) part = `#${window.CSS.escape(node.id)}`;
      else {
        part = window.CSS.escape(node.localName);
        const attr = ATTR_ANCHORS.find((a) => node.hasAttribute(a));
        if (attr) part += `[${attr}=${cssString(node.getAttribute(attr))}]`;
        const parent = node.parentElement;
        if (parent && !attr) {
          const same = Array.from(parent.children).filter((c) => c.localName === node.localName);
          if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      if ((parts.length > 1 || part.startsWith('#')) && isUnique(parts.join(' > '))) return parts.join(' > ');
    }
    return parts.join(' > ');
  }

  function frameworkName(el) {
    try {
      const key = Object.keys(el).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
      if (key) {
        for (let f = el[key]; f; f = f.return) {
          const t = f.type;
          if (typeof t === 'function' && (t.displayName || t.name) && /^[A-Z]/.test(t.displayName || t.name)) return t.displayName || t.name;
        }
      }
      const vue = el.__vueParentComponent;
      if (vue && vue.type) return vue.type.name || vue.type.__name || null;
    } catch {}
    return null;
  }

  function components(el) {
    const out = [];
    for (let n = el; n && out.length < 6; n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null) {
      if (n.localName && n.localName.includes('-')) out.push(n.localName);
    }
    if (!out.length) {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        const name = frameworkName(n);
        if (name) {
          out.push(name);
          break;
        }
      }
    }
    return out;
  }

  function describe(el, comps = components(el)) {
    let s = el.localName;
    const cls = Array.from(el.classList)
      .filter((c) => !/^(ng-|_ng|cdk-|is-|has-)|^[a-z0-9]{6,}$/.test(c) && c.length < 40)
      .slice(0, 2);
    if (cls.length) s += `.${cls.join('.')}`;
    const outer = comps.find((c) => c !== el.localName);
    if (outer) s += /-/.test(outer) ? ` in <${outer}>` : ` in ${outer}`;
    return s;
  }

  function elementText(el) {
    return String(el.innerText || el.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
  }

  function makeTitle(text) {
    const s = text.replace(/\s+/g, ' ').trim();
    if (s.length <= 60) return s;
    const sp = s.slice(0, 61).lastIndexOf(' ');
    return `${(sp > 30 ? s.slice(0, sp) : s.slice(0, 60)).replace(/[\s,.;:|-]+$/, '')}…`;
  }

  function mdCode(v) {
    const s = String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    if (!s) return '—';
    const ticks = s.includes('`') ? '``' : '`';
    return `${ticks}${ticks.length > 1 ? ' ' : ''}${s}${ticks.length > 1 ? ' ' : ''}${ticks}`;
  }

  function safeJson(obj) {
    return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  }

  function buildBody(text, d) {
    const meta = {
      page: d.page,
      url: d.path,
      app: cfg.app,
      branch: cfg.branch,
      selector: d.selector,
      fx: d.fx,
      fy: d.fy,
      components: d.components,
      viewport: d.viewport,
      x: d.x,
      y: d.y,
    };
    const rows = [
      ['Page', location.href.replace(/\|/g, '%7C')],
      ['Element', mdCode(d.label)],
      ['Text', mdCode(d.text)],
      ['Selector', mdCode(d.selector)],
      ['Branch', mdCode(cfg.branch)],
      ['App', cfg.app ? mdCode(cfg.app) : '—'],
      ['Viewport', d.viewport],
    ];
    return `${text}\n\n| Field | Value |\n| --- | --- |\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n')}\n\n<!-- feedback-meta ${safeJson(meta)} -->\n`;
  }

  function capture(el, clientX, clientY) {
    const r = el.getBoundingClientRect();
    const round = (n) => Math.round(Math.min(1, Math.max(0, n)) * 1000) / 1000;
    const comps = components(el);
    return {
      el,
      page: pageKey(),
      path: location.pathname + location.search + location.hash,
      selector: selectorFor(el),
      fx: round(r.width ? (clientX - r.left) / r.width : 0.5),
      fy: round(r.height ? (clientY - r.top) / r.height : 0.5),
      x: Math.round(clientX + window.scrollX),
      y: Math.round(clientY + window.scrollY),
      label: describe(el, comps),
      components: comps,
      text: elementText(el),
      viewport: `${window.innerWidth}x${window.innerHeight}`,
    };
  }

  const resolved = new Map();
  function resolveTarget(meta) {
    const cached = resolved.get(meta.selector);
    if (cached && cached.isConnected) return cached;
    let el = null;
    try {
      el = document.querySelector(meta.selector);
    } catch {}
    if (el) resolved.set(meta.selector, el);
    else resolved.delete(meta.selector);
    return el;
  }

  function pointFor(meta) {
    const el = resolveTarget(meta);
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return null;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') return null;
      return { x: r.left + meta.fx * r.width, y: r.top + meta.fy * r.height, lost: false };
    }
    if (typeof meta.x === 'number' && typeof meta.y === 'number') {
      return { x: meta.x - window.scrollX, y: meta.y - window.scrollY, lost: true };
    }
    return null;
  }

  function onPage(rec) {
    return rec.meta.page === pageKey();
  }

  function visible(rec) {
    return state.showResolved || rec.state !== 'closed' || (state.thread && state.thread.number === rec.number);
  }

  const pinEls = new Map();

  function renderPins() {
    const want = new Set();
    for (const rec of state.issues.values()) {
      if (!onPage(rec) || !visible(rec)) continue;
      want.add(rec.number);
      let el = pinEls.get(rec.number);
      if (!el) {
        el = h('button', { class: 'pin', onclick: (e) => (e.stopPropagation(), openThread(rec.number)) });
        el.dataset.number = rec.number;
        pinEls.set(rec.number, el);
        ui.pins.append(el);
      }
      const current = state.issues.get(rec.number);
      el.textContent = String(rec.number);
      el.className = `pin ${status(current)}${state.thread && state.thread.number === rec.number ? ' active' : ''}`;
      el.title = `#${rec.number} ${current.title}`;
      el.setAttribute('aria-label', `Feedback #${rec.number}: ${current.title}`);
    }
    for (const [n, el] of pinEls) {
      if (!want.has(n)) {
        el.remove();
        pinEls.delete(n);
      }
    }
    if (state.draft) {
      if (!state.draft.pin) {
        state.draft.pin = h('div', { class: 'pin draft' }, '+');
        ui.pins.append(state.draft.pin);
      }
    }
    layout();
  }

  function place(el, p) {
    if (!p || p.x < -40 || p.y < -40 || p.x > window.innerWidth + 40 || p.y > window.innerHeight + 40) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.style.left = `${Math.round(p.x)}px`;
    el.style.top = `${Math.round(p.y)}px`;
    el.classList.toggle('lost', Boolean(p.lost));
  }

  function layout() {
    mount();
    for (const [n, el] of pinEls) {
      const rec = state.issues.get(n);
      place(el, rec && pointFor(rec.meta));
    }
    if (state.draft && state.draft.pin) {
      const el = state.draft.el;
      if (el && el.isConnected) {
        const r = el.getBoundingClientRect();
        place(state.draft.pin, { x: r.left + state.draft.fx * r.width, y: r.top + state.draft.fy * r.height });
      } else place(state.draft.pin, { x: state.draft.x - window.scrollX, y: state.draft.y - window.scrollY });
    }
    if (state.hover && state.hover.isConnected && state.mode && !state.draft) {
      const r = state.hover.getBoundingClientRect();
      Object.assign(ui.hl.style, { left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
      ui.hlLabel.classList.toggle('below', r.top < 28);
      ui.hl.hidden = false;
    } else ui.hl.hidden = true;
    positionPop();
    if (state.focus) tryFocus();
  }

  let frame = 0;
  function scheduleLayout() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      layout();
    });
  }

  function renderBar() {
    ui.bar.replaceChildren();
    const recs = Array.from(state.issues.values());
    const openHere = recs.filter((r) => r.state === 'open' && onPage(r)).length;
    const openAll = recs.filter((r) => r.state === 'open').length;
    ui.bar.append(
      h(
        'button',
        { class: state.panelOpen ? 'on' : '', title: 'All feedback', 'aria-label': 'All feedback', 'data-action': 'list', onclick: togglePanel },
        '☰',
        state.loaded ? h('span', { class: 'count', title: `${openHere} open on this page, ${openAll} open in total` }, `${openHere}/${openAll}`) : null,
      ),
      h(
        'button',
        { class: state.mode ? 'on' : '', title: 'Comment mode (C)', 'data-action': 'comment', onclick: () => toggleMode() },
        '💬 Comment',
      ),
    );
    if (state.auth) {
      ui.bar.append(
        h(
          'button',
          {
            class: 'icon',
            'data-action': 'user',
            title: `Signed in as ${state.auth.user.login}. Click to sign out.`,
            onclick: () => {
              if (window.confirm(`Sign out ${state.auth.user.login} from feedback?`)) signOut();
            },
          },
          h('img', { src: avatar(state.auth.user.avatar_url, 52), alt: state.auth.user.login }),
        ),
      );
    } else {
      ui.bar.append(h('button', { 'data-action': 'signin', onclick: () => ensureSignedIn() }, 'Sign in'));
    }
  }

  function togglePanel() {
    state.panelOpen = !state.panelOpen;
    if (state.panelOpen) {
      closePop();
      if (!state.auth) {
        state.panelOpen = false;
        ensureSignedIn().then((ok) => {
          if (ok) {
            state.panelOpen = true;
            renderAll();
          }
        });
        return;
      }
      refresh();
    }
    renderAll();
  }

  function renderPanel() {
    ui.panel.hidden = !state.panelOpen;
    if (!state.panelOpen) return;
    const recs = Array.from(state.issues.values())
      .filter((r) => state.showResolved || r.state !== 'closed')
      .sort((a, b) => Number(onPage(b)) - Number(onPage(a)) || b.number - a.number);
    const toggle = h('input', {
      type: 'checkbox',
      checked: state.showResolved,
      onchange: (e) => {
        state.showResolved = e.target.checked;
        storage.set(PREFS_KEY, { showResolved: state.showResolved });
        renderAll();
      },
    });
    ui.panel.replaceChildren(
      h(
        'div',
        { class: 'panel-head' },
        h('strong', {}, 'Feedback'),
        h('label', {}, toggle, 'Show resolved'),
        h('button', { class: 'x', title: 'Close', onclick: togglePanel }, '×'),
      ),
      h(
        'div',
        { class: 'items' },
        !state.loaded
          ? h('div', { class: 'empty' }, 'Loading…')
          : recs.length
            ? recs.map((r) =>
                h(
                  'button',
                  { class: `item${onPage(r) ? ' here' : ''}`, 'data-number': String(r.number), onclick: () => goTo(r) },
                  h('span', { class: `dot ${status(r)}` }, String(r.number)),
                  h(
                    'span',
                    { class: 'body' },
                    h('div', { class: 't' }, r.title),
                    h('div', { class: 's' }, `${r.meta.page} · ${r.user.login || '?'} · ${ago(r.created)}${r.comments ? ` · ${r.comments} ${r.comments === 1 ? 'reply' : 'replies'}` : ''}`),
                  ),
                ),
              )
            : h('div', { class: 'empty' }, state.showResolved ? 'No feedback yet.' : 'No open feedback.'),
      ),
      h('div', { class: 'panel-head hint', style: 'border-top:1px solid var(--line);border-bottom:0' }, `${cfg.repo} · branch ${cfg.branch}`),
    );
  }

  function renderAll() {
    renderBar();
    renderPins();
    renderPanel();
    renderThread();
  }

  function goTo(rec) {
    state.panelOpen = false;
    renderAll();
    if (onPage(rec)) {
      state.focus = { number: rec.number, until: Date.now() + 8000 };
      tryFocus();
      return;
    }
    const target = rec.meta.url && rec.meta.url.startsWith('/') ? rec.meta.url : rec.meta.page;
    state.focus = { number: rec.number, until: Date.now() + 10000 };
    storage.set(FOCUS_KEY, state.focus, sessionStorage);
    let changed = false;
    const mo = new MutationObserver(() => (changed = true));
    mo.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
    history.pushState(null, '', target);
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    checkPage();
    setTimeout(() => {
      mo.disconnect();
      if (!changed) location.reload();
    }, 1500);
  }

  function tryFocus() {
    const f = state.focus;
    if (!f) return;
    if (Date.now() > f.until) {
      state.focus = null;
      storage.set(FOCUS_KEY, null, sessionStorage);
      return;
    }
    const rec = state.issues.get(f.number);
    if (!rec || !onPage(rec)) return;
    const el = resolveTarget(rec.meta);
    if (!el && state.loaded && Date.now() < f.until - 7000) return;
    state.focus = null;
    storage.set(FOCUS_KEY, null, sessionStorage);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    else if (typeof rec.meta.y === 'number') window.scrollTo({ top: rec.meta.y - window.innerHeight / 2, behavior: 'smooth' });
    setTimeout(() => openThread(rec.number), 350);
  }

  function setMode(on) {
    if (state.mode === on) return;
    state.mode = on;
    state.hover = null;
    document.documentElement.toggleAttribute('data-feedback-commenting', on);
    cursorStyle.disabled = !on;
    if (!on && state.draft && !state.draft.input.value.trim()) closePop();
    renderBar();
    layout();
  }

  async function toggleMode(force) {
    const on = force === undefined ? !state.mode : force;
    if (on && !(await ensureSignedIn())) return;
    if (on) {
      state.panelOpen = false;
      renderPanel();
    }
    setMode(on);
    if (on) toast('Click any element to comment. Esc to cancel.');
  }

  const cursorStyle = document.createElement('style');
  cursorStyle.textContent = 'html[data-feedback-commenting],html[data-feedback-commenting] *{cursor:crosshair!important}';
  (document.head || document.documentElement).append(cursorStyle);
  cursorStyle.disabled = true;

  function popAnchor() {
    if (state.draft) {
      const p = state.draft.pin;
      return p && p.style.display !== 'none' ? p.getBoundingClientRect() : null;
    }
    if (state.thread) {
      const p = pinEls.get(state.thread.number);
      return p && p.style.display !== 'none' ? p.getBoundingClientRect() : null;
    }
    return null;
  }

  function positionPop() {
    if (ui.pop.hidden) return;
    const a = popAnchor();
    const w = ui.pop.offsetWidth || 340;
    const ph = ui.pop.offsetHeight || 200;
    let x;
    let y;
    if (a) {
      x = a.right + 10;
      y = a.top;
      if (x + w > window.innerWidth - 12) x = a.left - w - 10;
      if (x < 12) x = Math.min(window.innerWidth - w - 12, Math.max(12, a.left));
    } else {
      x = window.innerWidth - w - 16;
      y = window.innerHeight - ph - 72;
    }
    y = Math.min(Math.max(12, y), window.innerHeight - ph - 12);
    ui.pop.style.left = `${Math.round(Math.max(12, x))}px`;
    ui.pop.style.top = `${Math.round(Math.max(12, y))}px`;
  }

  function closePop() {
    if (state.draft && state.draft.pin) state.draft.pin.remove();
    state.draft = null;
    state.thread = null;
    ui.pop.hidden = true;
    ui.pop.replaceChildren();
    renderPins();
  }

  function submitOnShortcut(fn) {
    return (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        fn();
      }
    };
  }

  function openDraft(el, clientX, clientY) {
    const prevText = state.draft ? state.draft.input.value : '';
    closePop();
    const d = capture(el, clientX, clientY);
    const text = h('textarea', { placeholder: 'Leave a comment…', 'aria-label': 'Comment' });
    text.value = prevText;
    const save = h('button', { class: 'btn primary', 'data-action': 'save' }, 'Comment');
    const err = h('div', { class: 'err', hidden: true });
    state.draft = { ...d, input: text };
    const submit = async () => {
      const body = text.value.trim();
      if (!body || save.disabled) return;
      save.disabled = true;
      err.hidden = true;
      const ok = await createIssue(state.draft, body).catch((e) => {
        err.textContent = e.message;
        err.hidden = false;
        return false;
      });
      save.disabled = false;
      if (ok) closePop();
    };
    save.addEventListener('click', submit);
    text.addEventListener('keydown', submitOnShortcut(submit));
    ui.pop.replaceChildren(
      h(
        'div',
        { class: 'pop-head' },
        h('span', { class: 'grow', title: d.selector }, d.label),
        h('button', { class: 'x', title: 'Cancel (Esc)', onclick: closePop }, '×'),
      ),
      text,
      err,
      h(
        'div',
        { class: 'actions' },
        h('span', { class: 'hint grow' }, `${navigator.platform.startsWith('Mac') ? '⌘' : 'Ctrl'}+Enter to save`),
        h('button', { class: 'btn', onclick: closePop }, 'Cancel'),
        save,
      ),
    );
    ui.pop.hidden = false;
    renderPins();
    text.focus();
  }

  async function createIssue(d, text) {
    const body = buildBody(text, d);
    const issue = await gh(`/repos/${cfg.repo}/issues`, {
      method: 'POST',
      body: { title: makeTitle(text), body, labels: [cfg.label, `branch:${cfg.branch}`] },
    });
    const rec = toRecord(issue);
    if (rec) {
      state.issues.set(rec.number, rec);
      state.pending.set(rec.number, Date.now());
      setTimeout(() => state.pending.delete(rec.number), 60000);
      renderAll();
    }
    if (rec && !rec.labels.includes(cfg.label)) {
      toast(`Created #${issue.number}. GitHub dropped the labels (you lack triage access); it is still tracked.`);
    } else toast(`Created #${issue.number}`);
    return true;
  }

  function openThread(number) {
    const rec = state.issues.get(number);
    if (!rec) return;
    if (state.draft && state.draft.pin) state.draft.pin.remove();
    state.draft = null;
    state.panelOpen = false;
    state.thread = {
      number,
      text: h('textarea', { placeholder: 'Reply…', 'aria-label': 'Reply' }),
      list: h('div', { class: 'msgs' }),
      head: h('div', { class: 'pop-head' }),
      actions: h('div', { class: 'actions' }),
      err: h('div', { class: 'err', hidden: true }),
      note: h('div', { class: 'note', hidden: true }),
    };
    const t = state.thread;
    t.text.addEventListener('keydown', submitOnShortcut(() => reply()));
    ui.pop.replaceChildren(t.head, t.list, t.note, t.text, t.err, t.actions);
    ui.pop.hidden = false;
    renderAll();
    loadComments(number);
    t.text.focus({ preventScroll: true });
  }

  function message(user, when, text) {
    return h(
      'div',
      { class: 'msg' },
      h('img', { src: avatar(user.avatar_url, 48), alt: '' }),
      h('div', { style: 'min-width:0' }, h('div', {}, h('span', { class: 'who' }, user.login || '?'), h('span', { class: 'when' }, ago(when))), h('div', { class: 'text' }, text)),
    );
  }

  function renderThread() {
    const t = state.thread;
    if (!t) return;
    const rec = state.issues.get(t.number);
    if (!rec) return closePop();
    const st = status(rec);
    t.head.replaceChildren(
      h('span', { class: `status ${st}` }, st === 'closed' ? 'Resolved' : st === 'answered' ? 'Answered' : 'Open'),
      h('span', { class: 'grow', title: rec.meta.selector }, `#${rec.number} · ${rec.title}`),
      h('button', { class: 'x', title: 'Close (Esc)', onclick: closePop }, '×'),
    );
    const comments = state.comments.get(t.number);
    t.list.replaceChildren(
      ...[
        message(rec.user, rec.created, rec.text),
        comments ? comments.map((c) => message(c.user || {}, c.created_at, c.body || '')) : rec.comments ? h('div', { class: 'hint' }, 'Loading replies…') : null,
      ]
        .flat()
        .filter(Boolean),
    );
    t.note.hidden = rec.labels.includes(cfg.label);
    t.note.textContent = `No "${cfg.label}" label: GitHub drops labels when the author lacks triage access. A maintainer can add it.`;
    const closed = rec.state === 'closed';
    t.actions.replaceChildren(
      h('a', { href: rec.url, target: '_blank', rel: 'noopener noreferrer', class: 'hint grow' }, 'Open on GitHub ↗'),
      h('button', { class: 'btn', 'data-action': closed ? 'reopen' : 'resolve', onclick: () => setIssueState(t.number, closed ? 'open' : 'closed') }, closed ? 'Reopen' : 'Resolve'),
      h('button', { class: 'btn primary', 'data-action': 'reply', onclick: () => reply() }, 'Reply'),
    );
    positionPop();
  }

  async function reply() {
    const t = state.thread;
    if (!t) return;
    const body = t.text.value.trim();
    if (!body) return;
    t.err.hidden = true;
    t.text.disabled = true;
    try {
      const c = await gh(`/repos/${cfg.repo}/issues/${t.number}/comments`, { method: 'POST', body: { body } });
      const list = state.comments.get(t.number) || [];
      list.push(c);
      state.comments.set(t.number, list);
      const rec = state.issues.get(t.number);
      if (rec) rec.comments = list.length;
      t.text.value = '';
    } catch (e) {
      t.err.textContent = e.message;
      t.err.hidden = false;
    }
    t.text.disabled = false;
    renderAll();
    t.text.focus({ preventScroll: true });
  }

  async function setIssueState(number, next) {
    const t = state.thread;
    try {
      const body = next === 'closed' ? { state: 'closed', state_reason: 'completed' } : { state: 'open' };
      const issue = await gh(`/repos/${cfg.repo}/issues/${number}`, { method: 'PATCH', body });
      const rec = toRecord(issue);
      if (rec) {
        const old = state.issues.get(number);
        if (old) rec.comments = Math.max(rec.comments, old.comments);
        state.issues.set(number, rec);
      }
      toast(next === 'closed' ? `Resolved #${number}` : `Reopened #${number}`);
    } catch (e) {
      if (t) {
        t.err.textContent = e.message;
        t.err.hidden = false;
      }
    }
    renderAll();
  }

  function targetOf(e) {
    const t = e.target;
    if (!t || t.nodeType !== 1 || t === host || t === document.documentElement) return null;
    return t;
  }

  function block(e) {
    if (!state.mode || isOurs(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu', 'auxclick', 'touchstart', 'touchend', 'submit']) {
    window.addEventListener(type, block, { capture: true, passive: false });
  }

  window.addEventListener(
    'click',
    (e) => {
      if (!state.mode || isOurs(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const el = targetOf(e);
      if (el) openDraft(el, e.clientX, e.clientY);
    },
    true,
  );

  window.addEventListener(
    'mousemove',
    (e) => {
      if (!state.mode || isOurs(e)) {
        if (state.hover && state.mode) {
          state.hover = null;
          scheduleLayout();
        }
        return;
      }
      const el = targetOf(e);
      if (el !== state.hover) {
        state.hover = el;
        if (el) ui.hlLabel.textContent = describe(el);
        scheduleLayout();
      }
    },
    true,
  );

  document.addEventListener('pointerdown', (e) => {
    if (state.mode || isOurs(e)) return;
    if (state.thread || state.panelOpen) {
      state.panelOpen = false;
      closePop();
      renderAll();
    }
  });

  function isTyping(e) {
    const t = e.composedPath()[0];
    if (!t || t.nodeType !== 1) return false;
    return /^(input|textarea|select)$/i.test(t.localName) || t.isContentEditable;
  }

  host.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (state.draft || state.thread) closePop();
      else if (state.panelOpen) togglePanel();
      else setMode(false);
    }
  });
  host.addEventListener('keyup', (e) => e.stopPropagation());
  host.addEventListener('keypress', (e) => e.stopPropagation());

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.defaultPrevented && !state.mode) return;
      if (isTyping(e) || isOurs(e)) return;
      if (e.key === 'Escape') {
        if (state.draft || state.thread) closePop();
        else if (state.panelOpen) togglePanel();
        else if (state.mode) setMode(false);
        else return;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey && !e.altKey && !e.repeat) {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleMode();
      }
    },
    true,
  );

  function checkPage() {
    if (location.href === state.href) return;
    const prevPage = pageKey(new URL(state.href));
    state.href = location.href;
    if (pageKey() !== prevPage) {
      if (state.draft) closePop();
      if (state.thread) {
        const rec = state.issues.get(state.thread.number);
        if (!rec || !onPage(rec)) closePop();
      }
      resolved.clear();
      renderAll();
    }
  }

  for (const fn of ['pushState', 'replaceState']) {
    const orig = history[fn];
    history[fn] = function (...args) {
      const r = orig.apply(this, args);
      setTimeout(checkPage, 0);
      return r;
    };
  }
  window.addEventListener('popstate', () => setTimeout(checkPage, 0));
  window.addEventListener('hashchange', checkPage);
  window.addEventListener('scroll', scheduleLayout, { capture: true, passive: true });
  window.addEventListener('resize', scheduleLayout, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });

  function start() {
    mount();
    new MutationObserver(scheduleLayout).observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    setInterval(() => {
      checkPage();
      layout();
    }, 700);
    setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, cfg.poll);
    renderAll();
    refresh();
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
