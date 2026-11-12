'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { parseRoutes, originMatcher, readConfig } = require('../lib/config');
const { Store } = require('../lib/store');
const { createProxy, injectTag } = require('../lib/proxy');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fbw-'));

test('state is signed, purpose-bound and expires', () => {
  const dir = tmp();
  const store = new Store(dir);
  const state = store.sign('auth', { o: 'http://localhost:4201' });
  assert.equal(store.verify('auth', state).o, 'http://localhost:4201');
  assert.equal(store.verify('setup', state), null);
  assert.equal(store.verify('auth', state.slice(0, -2) + 'xx'), null);
  assert.equal(store.verify('auth', state, Date.now() + 11 * 60 * 1000), null);
  const [payload, mac] = state.split('.');
  const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), o: 'https://evil.test' })).toString('base64url');
  assert.equal(store.verify('auth', `${forged}.${mac}`), null);
  assert.equal(new Store(dir).verify('auth', state).o, 'http://localhost:4201');
  assert.equal(fs.statSync(path.join(dir, 'state-secret')).mode & 0o777, 0o600);
});

test('app credentials are written with mode 600', () => {
  const dir = tmp();
  const store = new Store(dir);
  store.saveApp({ client_id: 'a', client_secret: 'b' });
  assert.equal(fs.statSync(path.join(dir, 'app.json')).mode & 0o777, 0o600);
  assert.equal(store.getApp().client_id, 'a');
});

test('origin allowlist supports exact origins and wildcards', () => {
  const ok = originMatcher(['https://staging.example.com/', 'https://*.preview.example.com', 'http://localhost:4201']);
  assert.ok(ok('https://staging.example.com'));
  assert.ok(ok('https://pr-12.preview.example.com'));
  assert.ok(ok('http://localhost:4201'));
  assert.ok(!ok('https://a.b.preview.example.com'));
  assert.ok(!ok('https://staging.example.com.evil.com'));
  assert.ok(!ok('http://localhost:4202'));
  assert.ok(!ok('null'));
});

test('config adds PUBLIC_URL and ROUTES origins', () => {
  const c = readConfig({ PUBLIC_URL: 'https://fb.example.com/', ROUTES: '4201|localhost:4200|o/r|next|frontend', ALLOWED_ORIGINS: 'https://dev.example.com' });
  assert.equal(c.publicUrl, 'https://fb.example.com');
  assert.ok(c.isAllowedOrigin('https://fb.example.com'));
  assert.ok(c.isAllowedOrigin('http://localhost:4201'));
  assert.ok(c.isAllowedOrigin('https://dev.example.com'));
  assert.equal(c.port, 4400);
});

test('routes parse', () => {
  const [a, b] = parseRoutes('4201|localhost:4200|Tax-Justice-Network/data-portal|next|frontend, 4301|127.0.0.1:4300|o/r');
  assert.equal(a.listenPort, 4201);
  assert.equal(a.target.host, 'localhost:4200');
  assert.equal(a.branch, 'next');
  assert.equal(a.app, 'frontend');
  assert.equal(b.branch, 'main');
  assert.throws(() => parseRoutes('x|localhost:1|o/r'));
  assert.throws(() => parseRoutes('4201|localhost:1|nope'));
});

test('injectTag places the script before </body> once', () => {
  const tag = '<script src="http://x/widget.js"></script>';
  const out = injectTag('<html><body><p>hi</p></body></html>', tag, 'http://x/widget.js');
  assert.match(out, /<p>hi<\/p><script data-feedback-injected src="http:\/\/x\/widget.js"><\/script><\/body>/);
  assert.equal(injectTag(out, tag, 'http://x/widget.js'), out);
});

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

test('proxy injects into html, passes other content and websockets', async () => {
  const upstream = http.createServer((req, res) => {
    if (req.url === '/app.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'content-length': 9 });
      return res.end('alert(1);');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': 30, 'x-enc': req.headers['accept-encoding'] || 'none' });
    res.end('<html><body>app</body></html>\n');
  });
  upstream.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(`echo:${d}`));
    socket.on('end', () => socket.destroy());
  });
  const upPort = await listen(upstream);
  const [route] = parseRoutes(`1|127.0.0.1:${upPort}|o/r|dev|web`);
  const proxy = createProxy(route, { publicUrl: 'http://fb.test' });
  const port = await listen(proxy);

  const get = (p) =>
    new Promise((resolve, reject) =>
      http.get({ port, path: p, headers: { 'accept-encoding': 'gzip' } }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ res, body }));
      }).on('error', reject),
    );
  const html = await get('/');
  assert.match(html.body, /<script data-feedback-injected src="http:\/\/fb.test\/widget.js" data-repo="o\/r" data-branch="dev" data-app="web" data-auth="http:\/\/fb.test" defer><\/script><\/body>/);
  assert.equal(html.res.headers['content-length'], undefined);
  assert.equal(html.res.headers['x-enc'], 'none');
  const js = await get('/app.js');
  assert.equal(js.body, 'alert(1);');
  assert.equal(js.res.headers['content-length'], '9');

  const echoed = await new Promise((resolve, reject) => {
    const req = http.request({ port, path: '/ws', headers: { Connection: 'Upgrade', Upgrade: 'websocket' } });
    req.on('upgrade', (res, socket) => {
      socket.on('data', (d) => {
        resolve(String(d));
        socket.destroy();
      });
      socket.write('ping');
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(echoed, 'echo:ping');
  for (const s of [proxy, upstream]) {
    s.closeAllConnections();
    s.close();
  }
});
