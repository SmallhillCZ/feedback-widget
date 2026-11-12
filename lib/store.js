'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const STATE_TTL_MS = 10 * 60 * 1000;

function writeSecure(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.appFile = path.join(dataDir, 'app.json');
    this.secret = this.loadSecret();
  }

  loadSecret() {
    const file = path.join(this.dataDir, 'state-secret');
    if (fs.existsSync(file)) {
      const value = fs.readFileSync(file, 'utf8').trim();
      if (value.length >= 32) return Buffer.from(value, 'hex');
    }
    const secret = crypto.randomBytes(32);
    writeSecure(file, secret.toString('hex'));
    return secret;
  }

  getApp() {
    try {
      const app = JSON.parse(fs.readFileSync(this.appFile, 'utf8'));
      return app && app.client_id && app.client_secret ? app : null;
    } catch {
      return null;
    }
  }

  saveApp(app) {
    writeSecure(this.appFile, JSON.stringify(app, null, 2));
  }

  sign(purpose, data) {
    const payload = b64url(JSON.stringify({ p: purpose, t: Date.now(), n: b64url(crypto.randomBytes(9)), ...data }));
    const mac = b64url(crypto.createHmac('sha256', this.secret).update(payload).digest());
    return `${payload}.${mac}`;
  }

  verify(purpose, state, now = Date.now()) {
    if (typeof state !== 'string') return null;
    const [payload, mac] = state.split('.');
    if (!payload || !mac) return null;
    const expected = crypto.createHmac('sha256', this.secret).update(payload).digest();
    const given = Buffer.from(mac, 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    let data;
    try {
      data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (data.p !== purpose || typeof data.t !== 'number') return null;
    if (now - data.t > STATE_TTL_MS || data.t - now > 60 * 1000) return null;
    return data;
  }
}

module.exports = { Store, STATE_TTL_MS };
