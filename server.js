#!/usr/bin/env node
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { loadEnvFile, readConfig } = require('./lib/config');
const { Store } = require('./lib/store');
const { startProxies, scriptTag } = require('./lib/proxy');

const WIDGET_FILE = path.join(__dirname, 'public', 'widget.js');
const DEMO_FILE = path.join(__dirname, 'demo', 'index.html');

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src https: data:; form-action https: http:; base-uri 'none'";

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--accent:#7c3aed}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8d96a0;--line:#30363d}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:640px;margin:48px auto;padding:0 16px}
h1{font-size:22px;margin:0 0 16px}
label{display:block;margin:14px 0 4px;font-weight:600}
input{width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;font:inherit}
button,.btn{display:inline-block;margin-top:18px;padding:9px 16px;border:0;border-radius:6px;background:var(--accent);color:#fff;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
.muted{color:var(--muted);font-size:13px}
code{font-size:13px;background:rgba(127,127,127,.15);padding:1px 5px;border-radius:4px}
.box{border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:16px 0}
</style></head><body><main>${body}</main></body></html>`;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...headers });
  res.end(body);
}

function sendPage(res, status, title, body) {
  send(res, status, page(title, body), { 'content-security-policy': PAGE_CSP, 'x-frame-options': 'DENY' });
}

async function githubJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { accept: 'application/json', 'user-agent': 'feedback-widget', ...(options.headers || {}) },
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: text.slice(0, 200) };
  }
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status}: ${data.message || data.error || 'request failed'}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function createApp(config, { log = console.log } = {}) {
  const store = new Store(config.dataDir);

  function setupAllowed(url) {
    return !config.setupToken || url.searchParams.get('token') === config.setupToken;
  }

  function installLink(app) {
    return `${app.html_url}/installations/new`;
  }

  function routeSetup(req, res, url) {
    if (!setupAllowed(url)) return sendPage(res, 403, 'Forbidden', '<h1>Forbidden</h1><p>Open /setup?token=SETUP_TOKEN.</p>');
    const app = store.getApp();
    if (app) {
      return sendPage(
        res,
        200,
        'Feedback widget setup',
        `<h1>GitHub App is configured</h1>
<div class="box"><p><strong>${esc(app.name || app.slug)}</strong> (id ${esc(app.id)}, owner ${esc(app.owner || '?')})</p>
<p class="muted">Credentials are stored in <code>${esc(path.join(config.dataDir, 'app.json'))}</code>. Delete that file and restart to create a different app.</p></div>
<p>Install the app on every repository that should receive feedback:</p>
<a class="btn" href="${esc(installLink(app))}">Install on repositories</a>
<p class="muted">Sign-in callback: <code>${esc(config.publicUrl)}/auth/callback</code><br>Allowed origins: ${config.allowedOrigins.map((o) => `<code>${esc(o)}</code>`).join(' ')}</p>`,
      );
    }
    const token = url.searchParams.get('token') || '';
    sendPage(
      res,
      200,
      'Feedback widget setup',
      `<h1>Create the GitHub App</h1>
<p>This creates a private GitHub App with <code>Issues: write</code> and <code>Metadata: read</code>, no webhook. Reviewers sign in with it and issues are created under their own account.</p>
<form method="get" action="/setup/go">
<input type="hidden" name="token" value="${esc(token)}">
<label for="org">Organization</label>
<input id="org" name="org" placeholder="leave empty for your personal account" autocomplete="off">
<label for="name">App name</label>
<input id="name" name="name" value="Feedback widget" required maxlength="34">
<p class="muted">App names are unique across GitHub. Callback URL: <code>${esc(config.publicUrl)}/auth/callback</code></p>
<button type="submit">Create GitHub App</button>
</form>`,
    );
  }

  function routeSetupGo(req, res, url) {
    if (!setupAllowed(url)) return sendPage(res, 403, 'Forbidden', '<h1>Forbidden</h1>');
    if (store.getApp()) return sendPage(res, 409, 'Already configured', '<h1>Already configured</h1><p><a href="/setup">Back</a></p>');
    const org = (url.searchParams.get('org') || '').trim();
    const name = (url.searchParams.get('name') || 'Feedback widget').trim().slice(0, 34);
    if (org && !/^[A-Za-z0-9-]+$/.test(org)) return sendPage(res, 400, 'Invalid', '<h1>Invalid organization name</h1>');
    const manifest = {
      name,
      url: config.publicUrl,
      description: 'Click-to-comment feedback that becomes GitHub issues.',
      public: false,
      default_permissions: { issues: 'write', metadata: 'read' },
      default_events: [],
      hook_attributes: { url: `${config.publicUrl}/webhook-disabled`, active: false },
      callback_urls: [`${config.publicUrl}/auth/callback`],
      redirect_url: `${config.publicUrl}/setup/done`,
      request_oauth_on_install: false,
      setup_on_update: false,
    };
    const state = store.sign('setup', {});
    const base = org ? `${config.githubUrl}/organizations/${encodeURIComponent(org)}/settings/apps/new` : `${config.githubUrl}/settings/apps/new`;
    sendPage(
      res,
      200,
      'Redirecting to GitHub',
      `<h1>Redirecting to GitHub…</h1>
<form id="f" method="post" action="${esc(`${base}?state=${encodeURIComponent(state)}`)}">
<input type="hidden" name="manifest" value="${esc(JSON.stringify(manifest))}">
<button type="submit">Continue to GitHub</button>
</form>
<script>document.getElementById('f').submit()</script>`,
    );
  }

  async function routeSetupDone(req, res, url) {
    if (store.getApp()) return sendPage(res, 409, 'Already configured', '<h1>Already configured</h1><p><a href="/setup">Back</a></p>');
    if (!store.verify('setup', url.searchParams.get('state'))) {
      return sendPage(res, 400, 'Setup expired', '<h1>Setup link expired or invalid</h1><p><a href="/setup">Start again</a></p>');
    }
    const code = url.searchParams.get('code') || '';
    if (!/^[A-Za-z0-9_-]+$/.test(code)) return sendPage(res, 400, 'Invalid', '<h1>Missing code</h1>');
    let data;
    try {
      data = await githubJson(`${config.githubApi}/app-manifests/${code}/conversions`, {
        method: 'POST',
        headers: { accept: 'application/vnd.github+json' },
      });
    } catch (err) {
      log(`setup: conversion failed (${err.status || err.message})`);
      return sendPage(res, 502, 'Setup failed', `<h1>GitHub refused the app creation</h1><p>${esc(err.message)}</p><p><a href="/setup">Start again</a></p>`);
    }
    const app = {
      id: data.id,
      slug: data.slug,
      name: data.name,
      owner: data.owner && data.owner.login,
      html_url: data.html_url,
      client_id: data.client_id,
      client_secret: data.client_secret,
      pem: data.pem,
      webhook_secret: data.webhook_secret || null,
      created_at: new Date().toISOString(),
    };
    store.saveApp(app);
    log(`setup: GitHub App "${app.slug}" (id ${app.id}) saved`);
    sendPage(
      res,
      200,
      'GitHub App created',
      `<h1>GitHub App created</h1>
<p><strong>${esc(app.name)}</strong> is ready. Now install it on the repositories that should receive feedback.</p>
<a class="btn" href="${esc(installLink(app))}">Install on repositories</a>
<p class="muted">Credentials were saved to the data directory. Make sure every site that shows the widget is listed in <code>ALLOWED_ORIGINS</code>.</p>`,
    );
  }

  function routeAuthStart(req, res, url) {
    const origin = url.searchParams.get('origin') || '';
    if (!config.isAllowedOrigin(origin)) {
      log(`auth: rejected origin ${origin.slice(0, 100)}`);
      return sendPage(res, 403, 'Origin not allowed', `<h1>Origin not allowed</h1><p><code>${esc(origin)}</code> is not in <code>ALLOWED_ORIGINS</code> of this feedback service.</p>`);
    }
    const app = store.getApp();
    if (!app) return sendPage(res, 503, 'Not configured', '<h1>Feedback service is not configured</h1><p>Open <code>/setup</code> on the service first.</p>');
    const state = store.sign('auth', { o: origin });
    const target = new URL(`${config.githubUrl}/login/oauth/authorize`);
    target.searchParams.set('client_id', app.client_id);
    target.searchParams.set('redirect_uri', `${config.publicUrl}/auth/callback`);
    target.searchParams.set('state', state);
    res.writeHead(302, { location: target.toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end();
  }

  function authResult(res, origin, message) {
    const ok = !message.error;
    sendPage(
      res,
      ok ? 200 : 400,
      ok ? 'Signed in' : 'Sign-in failed',
      `<h1 id="m">${ok ? 'Signed in. You can close this window.' : esc(`Sign-in failed: ${message.error}`)}</h1>
<script>(function(){var d=${jsonForScript(message)};var o=${jsonForScript(origin)};if(window.opener){window.opener.postMessage(d,o);${ok ? 'window.close();' : ''}}else{document.getElementById('m').textContent=${jsonForScript(
        ok ? 'Signed in, but the page that opened this window is gone. Close this window and try again.' : `Sign-in failed: ${message.error}`,
      )};}})();</script>`,
    );
  }

  async function routeAuthCallback(req, res, url) {
    const state = store.verify('auth', url.searchParams.get('state'));
    if (!state || !config.isAllowedOrigin(state.o)) {
      return sendPage(res, 400, 'Sign-in expired', '<h1>Sign-in link expired or invalid</h1><p>Close this window and try again.</p>');
    }
    const origin = state.o;
    if (url.searchParams.get('error')) {
      return authResult(res, origin, { type: 'feedback-auth', error: url.searchParams.get('error_description') || url.searchParams.get('error') });
    }
    const app = store.getApp();
    if (!app) return authResult(res, origin, { type: 'feedback-auth', error: 'service is not configured' });
    try {
      const token = await githubJson(`${config.githubUrl}/login/oauth/access_token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: app.client_id,
          client_secret: app.client_secret,
          code: url.searchParams.get('code') || '',
          redirect_uri: `${config.publicUrl}/auth/callback`,
        }),
      });
      if (!token.access_token) throw new Error(token.error_description || token.error || 'no access token');
      const user = await githubJson(`${config.githubApi}/user`, {
        headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token.access_token}` },
      });
      log(`auth: ${user.login} signed in for ${origin}`);
      authResult(res, origin, {
        type: 'feedback-auth',
        token: token.access_token,
        expiresAt: token.expires_in ? Date.now() + Number(token.expires_in) * 1000 : null,
        user: { login: user.login, name: user.name || null, avatar_url: user.avatar_url, html_url: user.html_url },
      });
    } catch (err) {
      log(`auth: token exchange failed (${err.status || err.message})`);
      authResult(res, origin, { type: 'feedback-auth', error: err.message });
    }
  }

  function routeWidget(req, res) {
    fs.readFile(WIDGET_FILE, (err, data) => {
      if (err) return send(res, 500, 'widget.js missing');
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'access-control-allow-origin': '*',
        'cross-origin-resource-policy': 'cross-origin',
        'cache-control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  function routeDemo(req, res, url) {
    const cookies = Object.fromEntries(
      String(req.headers.cookie || '')
        .split(';')
        .map((c) => c.trim().split('='))
        .filter((p) => p.length === 2)
        .map(([k, v]) => [k, decodeURIComponent(v)]),
    );
    const headers = {};
    let repo = url.searchParams.get('repo');
    if (repo !== null) {
      repo = repo.trim();
      headers['set-cookie'] = `demo_repo=${encodeURIComponent(repo)}; Path=/demo; SameSite=Lax`;
    } else repo = cookies.demo_repo || config.demo.repo;
    if (repo && !/^[\w.-]+\/[\w.-]+$/.test(repo)) repo = '';
    const branch = url.searchParams.get('branch') || config.demo.branch;
    const tag = repo ? scriptTag({ publicUrl: config.publicUrl, repo, branch, app: config.demo.app, api: config.demo.api, poll: config.demo.poll }) : '';
    fs.readFile(DEMO_FILE, 'utf8', (err, html) => {
      if (err) return send(res, 500, 'demo missing');
      send(res, 200, html.replace('<!--FEEDBACK_WIDGET-->', tag).replace(/\{\{REPO\}\}/g, esc(repo)), headers);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, config.publicUrl);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    log(`${req.method} ${url.pathname}`);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    if (p === '/widget.js') return routeWidget(req, res);
    if (p === '/setup') return routeSetup(req, res, url);
    if (p === '/setup/go') return routeSetupGo(req, res, url);
    if (p === '/setup/done') return routeSetupDone(req, res, url);
    if (p === '/auth/start') return routeAuthStart(req, res, url);
    if (p === '/auth/callback') return routeAuthCallback(req, res, url);
    if (p === '/demo' || p.startsWith('/demo/')) return routeDemo(req, res, url);
    if (p === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, configured: Boolean(store.getApp()) }));
    }
    if (p === '/') {
      const app = store.getApp();
      return sendPage(
        res,
        200,
        'Feedback widget',
        `<h1>Feedback widget</h1>
<p>${app ? `GitHub App <strong>${esc(app.name || app.slug)}</strong> is configured.` : 'Not configured yet.'} <a href="/setup">Setup</a> · <a href="/demo">Demo</a></p>
<p>Add to a dev or staging build:</p>
<div class="box"><code>${esc(scriptTag({ publicUrl: config.publicUrl, repo: 'owner/repo', branch: 'dev', app: 'frontend' }))}</code></div>`,
      );
    }
    send(res, 404, 'Not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`error: ${err.message}`);
      if (!res.headersSent) send(res, 500, 'Internal error');
      else res.end();
    });
  });

  return { server, store };
}

if (require.main === module) {
  loadEnvFile(path.join(process.cwd(), '.env'));
  const config = readConfig();
  const { server, store } = createApp(config);
  server.listen(config.port, config.host, () => {
    console.log(`feedback-widget on ${config.publicUrl} (listening on ${config.host}:${config.port})`);
    console.log(store.getApp() ? 'GitHub App configured' : `Not configured: open ${config.publicUrl}/setup`);
  });
  startProxies(config.routes, { publicUrl: config.publicUrl, log: console.log });
}

module.exports = { createApp };
