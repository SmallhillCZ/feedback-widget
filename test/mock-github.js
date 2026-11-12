'use strict';

const http = require('node:http');

function createMockGitHub() {
  const db = {
    issues: [],
    comments: new Map(),
    tokens: new Map([['other-token', { login: 'maintainer', id: 2 }]]),
    manifests: [],
    triage: true,
    requests: [],
  };
  let base = '';

  function json(res, status, data, extra = {}) {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', ...extra });
    res.end(data === undefined ? '' : JSON.stringify(data));
  }

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  function userObj(u) {
    return { login: u.login, id: u.id, avatar_url: `${base}/avatar/${u.login}.png`, html_url: `${base}/${u.login}` };
  }

  function addComment(number, user, body) {
    const list = db.comments.get(number) || [];
    const c = { id: Date.now() + list.length, body, user: userObj(user), created_at: new Date().toISOString() };
    list.push(c);
    db.comments.set(number, list);
    const issue = db.issues.find((i) => i.number === number);
    issue.comments = list.length;
    issue.updated_at = new Date().toISOString();
    return c;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const p = url.pathname;
    db.requests.push(`${req.method} ${p}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'Authorization, Content-Type, If-None-Match',
        'access-control-allow-methods': 'GET, POST, PATCH, DELETE',
      });
      return res.end();
    }
    if (p.endsWith('.png')) {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#888"/></svg>');
    }
    if (p === '/settings/apps/new' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const manifest = JSON.parse(form.get('manifest'));
      db.manifests.push(manifest);
      const target = new URL(manifest.redirect_url);
      target.searchParams.set('code', 'manifest-code');
      target.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: target.toString() });
      return res.end();
    }
    if (p === '/app-manifests/manifest-code/conversions' && req.method === 'POST') {
      return json(res, 201, {
        id: 42,
        slug: 'feedback-test',
        name: 'Feedback test',
        owner: { login: 'octo' },
        html_url: `${base}/apps/feedback-test`,
        client_id: 'Iv1.test',
        client_secret: 'secret-xyz',
        pem: '-----BEGIN RSA PRIVATE KEY-----\nTEST\n-----END RSA PRIVATE KEY-----\n',
        webhook_secret: null,
      });
    }
    if (p === '/login/oauth/authorize') {
      const target = new URL(url.searchParams.get('redirect_uri'));
      target.searchParams.set('code', `code-for-${url.searchParams.get('client_id')}`);
      target.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: target.toString() });
      return res.end();
    }
    if (p === '/login/oauth/access_token' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      if (body.code !== 'code-for-Iv1.test' || body.client_secret !== 'secret-xyz') return json(res, 200, { error: 'bad_verification_code' });
      const token = `ghu_${Math.random().toString(36).slice(2)}`;
      db.tokens.set(token, { login: 'reviewer', id: 1, name: 'Rita Reviewer' });
      return json(res, 200, { access_token: token, expires_in: 28800, refresh_token: 'r', token_type: 'bearer' });
    }
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const user = db.tokens.get(auth);
    if (!user) return json(res, 401, { message: 'Bad credentials' });
    if (p === '/user') return json(res, 200, { ...userObj(user), name: user.name || null });
    const m = p.match(/^\/repos\/([\w.-]+)\/([\w.-]+)\/issues(?:\/(\d+))?(\/comments)?$/);
    if (!m) return json(res, 404, { message: 'Not Found' });
    if (`${m[1]}/${m[2]}` !== 'octo/site') return json(res, 404, { message: 'Not Found' });
    const number = m[3] ? Number(m[3]) : null;
    if (!number && req.method === 'GET') {
      let list = db.issues.slice();
      const labels = url.searchParams.get('labels');
      if (labels) list = list.filter((i) => i.labels.some((l) => l.name === labels));
      const st = url.searchParams.get('state') || 'open';
      if (st !== 'all') list = list.filter((i) => i.state === st);
      list.sort((a, b) => b.number - a.number);
      return json(res, 200, list.slice(0, Number(url.searchParams.get('per_page') || 30)));
    }
    if (!number && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const issue = {
        number: db.issues.length + 1,
        title: body.title,
        body: body.body,
        state: 'open',
        comments: 0,
        labels: db.triage ? (body.labels || []).map((name) => ({ name })) : [],
        user: userObj(user),
        html_url: `${base}/octo/site/issues/${db.issues.length + 1}`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        author_association: 'COLLABORATOR',
      };
      db.issues.push(issue);
      return json(res, 201, issue);
    }
    const issue = db.issues.find((i) => i.number === number);
    if (!issue) return json(res, 404, { message: 'Not Found' });
    if (m[4] && req.method === 'GET') return json(res, 200, db.comments.get(number) || []);
    if (m[4] && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      return json(res, 201, addComment(number, user, body.body));
    }
    if (req.method === 'PATCH') {
      const body = JSON.parse(await readBody(req));
      if (body.state) issue.state = body.state;
      issue.updated_at = new Date().toISOString();
      return json(res, 200, issue);
    }
    if (req.method === 'GET') return json(res, 200, issue);
    json(res, 404, { message: 'Not Found' });
  });

  return {
    db,
    addComment,
    listen() {
      return new Promise((resolve) =>
        server.listen(0, '127.0.0.1', () => {
          base = `http://127.0.0.1:${server.address().port}`;
          resolve(base);
        }),
      );
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

module.exports = { createMockGitHub };
