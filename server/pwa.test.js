const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const optionsPromise = import('../pwa.config.mjs').then(value => value.pwaOptions);

test('PWA has stable identity, same-origin start URL and standalone display', async () => {
  const { manifest } = await optionsPromise;
  assert.equal(manifest.id, '/');
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.short_name, 'ASISTO');
  assert.equal(manifest.lang, 'es-MX');
});

test('install icons and Apple touch icon contain PNG images at their declared sizes', async () => {
  const { manifest } = await optionsPromise;
  assert.ok(manifest.icons.some(icon => icon.sizes === '192x192' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'any'));
  assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable'));
  for (const icon of [...manifest.icons, { src: '/apple-touch-icon.png', sizes: '180x180' }]) {
    const png = fs.readFileSync(path.join(root, 'public', icon.src));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const [width, height] = icon.sizes.split('x').map(Number);
    assert.equal(png.readUInt32BE(16), width);
    assert.equal(png.readUInt32BE(20), height);
  }
});

test('worker caches only static files and never handles API routes as offline navigation', async () => {
  const { workbox, registerType } = await optionsPromise;
  for (const url of ['/api', '/api/events', '/api/auth/login', '/API/employees/1/report-schedule']) {
    assert.ok(workbox.navigateFallbackDenylist.some(rule => rule.test(url)), url);
  }
  assert.equal(workbox.navigateFallbackDenylist.some(rule => rule.test('/')), false);
  assert.deepEqual(workbox.runtimeCaching, []);
  assert.deepEqual(workbox.globPatterns, ['**/*.{js,css,html,svg,png,webp,woff2}']);
  assert.equal(workbox.skipWaiting, false);
  assert.equal(workbox.cleanupOutdatedCaches, true);
  assert.equal(registerType, 'prompt');
});

test('production build contains its manifest, service worker and native install metadata', async () => {
  const html = fs.readFileSync(path.join(root, 'dist/index.html'), 'utf8');
  assert.match(html, /rel="manifest"/);
  assert.match(html, /apple-touch-icon/);
  assert.match(html, /name="theme-color"/);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'dist/manifest.webmanifest'), 'utf8'));
  assert.equal(manifest.short_name, 'ASISTO');
  const worker = fs.readFileSync(path.join(root, 'dist/sw.js'), 'utf8');
  assert.ok(worker.includes('index.html'));
  assert.ok(!worker.includes('.sqlite') && !worker.includes('.zkbio') && !worker.includes('.zkkey'));
});
