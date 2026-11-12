'use strict';

const fs = require('node:fs');
const path = require('node:path');

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#') || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

function list(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function trimSlash(url) {
  return String(url).replace(/\/+$/, '');
}

function parseRoutes(value) {
  return String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [listen, target, repo, branch, app] = entry.split('|').map((s) => (s || '').trim());
      const listenPort = Number(listen);
      if (!Number.isInteger(listenPort) || listenPort <= 0) throw new Error(`ROUTES: invalid listen port in "${entry}"`);
      const targetUrl = new URL(/^https?:\/\//.test(target) ? target : `http://${target}`);
      if (!targetUrl.port && !/^https?:\/\//.test(target)) throw new Error(`ROUTES: target must be host:port in "${entry}"`);
      if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) throw new Error(`ROUTES: repo must be owner/repo in "${entry}"`);
      return { listenPort, target: targetUrl, repo, branch: branch || 'main', app: app || '' };
    });
}

function originMatcher(patterns) {
  const exact = new Set();
  const wild = [];
  for (const p of patterns) {
    if (p.includes('*')) {
      const re = p
        .replace(/\/+$/, '')
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '[a-z0-9-]+');
      wild.push(new RegExp(`^${re}$`, 'i'));
    } else {
      try {
        exact.add(new URL(p).origin);
      } catch {}
    }
  }
  return (origin) => {
    if (typeof origin !== 'string' || !/^https?:\/\/[^/]+$/i.test(origin)) return false;
    return exact.has(origin) || wild.some((re) => re.test(origin));
  };
}

function readConfig(env = process.env) {
  const port = Number(env.PORT || 4400);
  const publicUrl = trimSlash(env.PUBLIC_URL || `http://localhost:${port}`);
  const routes = parseRoutes(env.ROUTES);
  const origins = list(env.ALLOWED_ORIGINS);
  origins.push(new URL(publicUrl).origin);
  for (const r of routes) origins.push(`http://localhost:${r.listenPort}`, `http://127.0.0.1:${r.listenPort}`);
  return {
    port,
    host: env.HOST || '0.0.0.0',
    publicUrl,
    allowedOrigins: origins,
    isAllowedOrigin: originMatcher(origins),
    routes,
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
    githubUrl: trimSlash(env.GITHUB_URL || 'https://github.com'),
    githubApi: trimSlash(env.GITHUB_API || 'https://api.github.com'),
    setupToken: env.SETUP_TOKEN || '',
    demo: { repo: env.DEMO_REPO || '', branch: env.DEMO_BRANCH || 'main', app: env.DEMO_APP || 'demo', api: env.DEMO_API || '', poll: env.DEMO_POLL || '' },
  };
}

module.exports = { loadEnvFile, readConfig, parseRoutes, originMatcher };
