'use strict';

const http = require('node:http');
const net = require('node:net');

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function scriptTag({ publicUrl, repo, branch, app, api, poll }) {
  const attrs = [
    `src="${escapeAttr(`${publicUrl}/widget.js`)}"`,
    `data-repo="${escapeAttr(repo)}"`,
    `data-branch="${escapeAttr(branch)}"`,
    app ? `data-app="${escapeAttr(app)}"` : '',
    `data-auth="${escapeAttr(publicUrl)}"`,
    api ? `data-api="${escapeAttr(api)}"` : '',
    poll ? `data-poll="${escapeAttr(poll)}"` : '',
    'defer',
  ].filter(Boolean);
  return `<script ${attrs.join(' ')}></script>`;
}

function injectTag(html, tag, src) {
  if (html.includes('data-feedback-injected') || (src && html.includes(src))) return html;
  const marked = tag.replace('<script ', '<script data-feedback-injected ');
  const body = html.lastIndexOf('</body>');
  if (body !== -1) return html.slice(0, body) + marked + html.slice(body);
  const head = html.indexOf('</head>');
  if (head !== -1) return html.slice(0, head) + marked + html.slice(head);
  return html + marked;
}

function isLocal(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

function forwardHeaders(req, route) {
  const headers = { ...req.headers };
  delete headers['accept-encoding'];
  headers['x-forwarded-host'] = req.headers.host || '';
  headers['x-forwarded-proto'] = 'http';
  if (!isLocal(route.target.hostname)) headers.host = route.target.host;
  return headers;
}

function createProxy(route, { publicUrl, log = () => {} }) {
  const tag = scriptTag({ publicUrl, repo: route.repo, branch: route.branch, app: route.app });
  const server = http.createServer((req, res) => {
    const upstream = http.request(
      {
        host: route.target.hostname,
        port: route.target.port || 80,
        method: req.method,
        path: req.url,
        headers: forwardHeaders(req, route),
      },
      (up) => {
        const type = String(up.headers['content-type'] || '');
        const encoding = String(up.headers['content-encoding'] || 'identity');
        const injectable =
          /text\/html/i.test(type) && encoding === 'identity' && req.method !== 'HEAD' && ![204, 304].includes(up.statusCode);
        if (!injectable) {
          res.writeHead(up.statusCode, up.rawHeaders.length ? rawToObject(up.rawHeaders) : up.headers);
          up.pipe(res);
          return;
        }
        const chunks = [];
        up.on('data', (c) => chunks.push(c));
        up.on('end', () => {
          const html = injectTag(Buffer.concat(chunks).toString('utf8'), tag, `${publicUrl}/widget.js`);
          const headers = rawToObject(up.rawHeaders, ['content-length', 'transfer-encoding']);
          res.writeHead(up.statusCode, headers);
          res.end(html);
        });
        up.on('error', () => res.destroy());
      },
    );
    upstream.on('error', (err) => {
      log(`proxy ${route.listenPort} -> ${route.target.host}: ${err.code || err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`feedback-widget proxy: ${route.target.host} is not reachable (${err.code || err.message})`);
    });
    req.pipe(upstream);
  });

  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(Number(route.target.port || 80), route.target.hostname, () => {
      const headers = forwardHeaders(req, route);
      let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        const lower = name.toLowerCase();
        if (lower === 'host') raw += `Host: ${headers.host}\r\n`;
        else raw += `${name}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      upstream.write(`${raw}\r\n`);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    const close = () => {
      socket.destroy();
      upstream.destroy();
    };
    upstream.on('error', close);
    socket.on('error', close);
    upstream.on('close', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });

  return server;
}

function rawToObject(raw, drop = []) {
  const out = {};
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i];
    if (drop.includes(name.toLowerCase())) continue;
    if (out[name] === undefined) out[name] = raw[i + 1];
    else out[name] = [].concat(out[name], raw[i + 1]);
  }
  return out;
}

function startProxies(routes, options) {
  return routes.map((route) => {
    const server = createProxy(route, options);
    server.listen(route.listenPort, () =>
      (options.log || console.log)(
        `proxy http://localhost:${route.listenPort} -> ${route.target.origin} (${route.repo}, branch ${route.branch}${route.app ? `, app ${route.app}` : ''})`,
      ),
    );
    return server;
  });
}

module.exports = { createProxy, startProxies, injectTag, scriptTag };
