'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const { readConfig } = require('../lib/config');
const { createApp } = require('../server');
const { createMockGitHub } = require('./mock-github');

const SHOTS = process.env.SCREENSHOT_DIR;

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

test('setup, sign-in, comment, pins, replies and resolve', { timeout: 120000 }, async (t) => {
  const gh = createMockGitHub();
  const ghBase = await gh.listen();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fbw-e2e-'));

  const probe = require('node:http').createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));

  const config = readConfig({
    PORT: String(port),
    PUBLIC_URL: `http://localhost:${port}`,
    DATA_DIR: dataDir,
    GITHUB_URL: ghBase,
    GITHUB_API: ghBase,
    DEMO_REPO: 'octo/site',
    DEMO_BRANCH: 'dev',
    DEMO_API: ghBase,
    DEMO_POLL: '1',
  });
  const { server } = createApp(config, { log: () => {} });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://localhost:${port}`;

  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    server.closeAllConnections();
    server.close();
    await gh.close();
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: SHOTS ? 2 : 1 });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await t.test('setup creates the app via the manifest flow', async () => {
    await page.goto(`${base}/setup`);
    await page.fill('#name', 'Feedback test');
    await page.click('button[type=submit]');
    await page.waitForURL(/\/setup\/done/);
    assert.match(await page.textContent('h1'), /GitHub App created/);
    assert.equal(await page.getAttribute('a.btn', 'href'), `${ghBase}/apps/feedback-test/installations/new`);
    const manifest = gh.db.manifests[0];
    assert.deepEqual(manifest.default_permissions, { issues: 'write', metadata: 'read' });
    assert.equal(manifest.public, false);
    assert.deepEqual(manifest.callback_urls, [`${base}/auth/callback`]);
    assert.equal(manifest.redirect_url, `${base}/setup/done`);
    const file = path.join(dataDir, 'app.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).client_secret, 'secret-xyz');
    await page.goto(`${base}/setup`);
    assert.match(await page.textContent('h1'), /configured/);
  });

  await t.test('auth/start rejects origins outside the allowlist', async () => {
    const res = await page.request.get(`${base}/auth/start?origin=${encodeURIComponent('https://evil.example')}`, { maxRedirects: 0 });
    assert.equal(res.status(), 403);
  });

  const w = (sel) => page.locator('feedback-widget').locator(sel);

  await t.test('sign in through the popup', async () => {
    await page.goto(`${base}/demo`);
    await w('[data-action=signin]').waitFor();
    await shot(page, '01-signed-out');
    const [popup] = await Promise.all([page.waitForEvent('popup'), w('[data-action=signin]').click()]);
    await popup.waitForEvent('close');
    await w('[data-action=user] img').waitFor();
    const stored = await page.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('feedback-widget:auth')));
    assert.ok(stored);
    assert.equal(JSON.parse(stored[1]).user.login, 'reviewer');
  });

  await t.test('forged postMessage from another origin is ignored', async () => {
    await page.evaluate((src) => {
      const f = document.createElement('iframe');
      f.src = src;
      f.id = 'evil';
      document.body.append(f);
      return new Promise((r) => (f.onload = r));
    }, `http://127.0.0.1:${port}/health`);
    const frame = page.frames().find((f) => f.url().startsWith('http://127.0.0.1'));
    await frame.evaluate(() => parent.postMessage({ type: 'feedback-auth', token: 'x', user: { login: 'mallory' } }, '*'));
    await page.waitForTimeout(300);
    await page.evaluate(() => document.getElementById('evil').remove());
    const stored = await page.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('feedback-widget:auth')));
    assert.equal(JSON.parse(stored[1]).user.login, 'reviewer');
  });

  await t.test('C key is ignored while typing in a page input', async () => {
    await page.evaluate(() => {
      const i = document.createElement('input');
      i.id = 'probe';
      document.querySelector('main').prepend(i);
    });
    await page.click('#probe');
    await page.keyboard.type('abc');
    assert.equal(await page.inputValue('#probe'), 'abc');
    assert.equal(await w('[data-action=comment]').getAttribute('class'), '');
    await page.evaluate(() => document.getElementById('probe').remove());
  });

  await t.test('comment mode highlights, blocks clicks and creates an issue', async () => {
    await page.click('body', { position: { x: 5, y: 300 } });
    await page.keyboard.press('c');
    assert.equal(await w('[data-action=comment]').getAttribute('class'), 'on');
    const h1 = page.locator('demo-hero h1');
    await h1.hover();
    await page.waitForTimeout(100);
    assert.equal(await w('.hl-label').textContent(), 'h1 in <demo-hero>');
    await shot(page, '02-hover');
    const cta = page.locator('demo-hero button.cta');
    await cta.click({ position: { x: 10, y: 10 } });
    assert.equal(await cta.textContent(), 'Get started');
    await w('.pop textarea').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await w('.pop').isHidden(), true);
    const box = await h1.boundingBox();
    await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.5);
    await w('.pop textarea').fill('The headline should mention privacy | and be shorter than it is now, please fix');
    await shot(page, '03-draft');
    await page.keyboard.press('Control+Enter');
    await w('.pin[data-number="1"]').waitFor();
    const issue = gh.db.issues[0];
    assert.equal(issue.user.login, 'reviewer');
    assert.deepEqual(issue.labels.map((l) => l.name), ['feedback', 'branch:dev']);
    assert.equal(issue.title, 'The headline should mention privacy | and be shorter than it…');
    assert.match(issue.body, /^The headline should mention privacy \| and be shorter/);
    assert.match(issue.body, /\| Element \| `h1 in <demo-hero>` \|/);
    assert.match(issue.body, /\| Text \| `Ship faster with Acme` \|/);
    assert.match(issue.body, /\| Branch \| `dev` \|/);
    assert.match(issue.body, /\| App \| `demo` \|/);
    assert.match(issue.body, /\| Viewport \| 1280x800 \|/);
    const meta = JSON.parse(issue.body.match(/<!-- feedback-meta (\{.*\}) -->/)[1]);
    assert.equal(meta.page, '/demo');
    assert.equal(meta.app, 'demo');
    assert.equal(meta.selector, 'demo-hero > h1');
    assert.ok(Math.abs(meta.fx - 0.25) < 0.02 && Math.abs(meta.fy - 0.5) < 0.05);
    assert.deepEqual(meta.components, ['demo-hero']);
    const pin = await w('.pin[data-number="1"]').boundingBox();
    assert.ok(Math.abs(pin.x - (box.x + box.width * 0.25)) < 3, 'pin x at click');
    assert.ok(Math.abs(pin.y + pin.height - (box.y + box.height * 0.5)) < 3, 'pin y at click');
    await page.keyboard.press('Escape');
    assert.equal(await w('[data-action=comment]').getAttribute('class'), '');
    await cta.click();
    assert.equal(await cta.textContent(), 'Clicked!');
  });

  await t.test('pins follow scroll and survive re-render', async () => {
    await page.click('#rerender');
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(300);
    const box = await page.locator('demo-hero h1').boundingBox();
    const pin = await w('.pin[data-number="1"]').boundingBox();
    assert.ok(Math.abs(pin.y + pin.height - (box.y + box.height * 0.5)) < 3);
    await page.mouse.wheel(0, -120);
  });

  await t.test('replies from GitHub turn the pin orange and show in the thread', async () => {
    gh.addComment(1, { login: 'maintainer', id: 2 }, 'Fixed in abc123, deployed to dev.');
    await page.waitForFunction(() => document.querySelector('feedback-widget').shadowRoot.querySelector('.pin[data-number="1"]').classList.contains('answered'), null, { timeout: 5000 });
    await w('.pin[data-number="1"]').click();
    await w('.msg >> text=Fixed in abc123').waitFor();
    await w('.pop textarea').fill('Thanks, looks good');
    await page.keyboard.press('Control+Enter');
    await w('.msg >> text=Thanks, looks good').waitFor();
    assert.equal(gh.db.comments.get(1).at(-1).user.login, 'reviewer');
    await shot(page, '04-thread');
    await w('[data-action=resolve]').click();
    await w('[data-action=reopen]').waitFor();
    assert.equal(gh.db.issues[0].state, 'closed');
    assert.ok((await w('.pin[data-number="1"]').getAttribute('class')).includes('closed'));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    assert.equal(await w('.pin[data-number="1"]').count(), 0, 'resolved pins hidden by default');
  });

  await t.test('reopen on GitHub shows the pin again', async () => {
    gh.db.issues[0].state = 'open';
    gh.db.issues[0].updated_at = new Date().toISOString();
    await w('.pin[data-number="1"]').waitFor({ timeout: 5000 });
  });

  await t.test('issues without labels are still found via feedback-meta', async () => {
    gh.db.triage = false;
    await page.goto(`${base}/demo/pricing`);
    await w('[data-action=user]').waitFor();
    await page.keyboard.press('c');
    await page.locator('[data-testid=plan-pro] h3').click();
    await w('.pop textarea').fill('Pro plan price looks wrong');
    await w('[data-action=save]').click();
    await w('.pin[data-number="2"]').waitFor();
    assert.deepEqual(gh.db.issues[1].labels, []);
    const meta = JSON.parse(gh.db.issues[1].body.match(/<!-- feedback-meta (\{.*\}) -->/)[1]);
    assert.equal(meta.selector, 'demo-card[data-testid="plan-pro"] > h3');
    await page.keyboard.press('Escape');
    await page.reload();
    await w('.pin[data-number="2"]').waitFor();
    assert.equal(await w('.pin[data-number="1"]').count(), 0, 'other page pin hidden');
  });

  await t.test('list panel navigates across SPA pages and opens the thread', async () => {
    await w('[data-action=list]').click();
    await w('.item[data-number="1"]').waitFor();
    assert.equal(await w('.item').count(), 2);
    await shot(page, '05-panel');
    await w('.item[data-number="1"]').click();
    await page.waitForURL(`${base}/demo`);
    await w('.pop .msg >> text=The headline should mention privacy').waitFor({ timeout: 5000 });
    assert.equal(await page.locator('demo-hero h1').textContent(), 'Ship faster with Acme');
    await shot(page, '06-navigated');
  });

  await t.test('a revoked token signs the user out', async () => {
    gh.db.tokens.clear();
    await w('[data-action=signin]').waitFor({ timeout: 5000 });
    const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('feedback-widget:auth')));
    assert.deepEqual(stored, []);
  });

  assert.deepEqual(errors, []);
});
