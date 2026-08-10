import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('localized PWA manifests use relative Pages-safe identity and complete icons', async () => {
  const zh = JSON.parse(await readFile('public/manifest.webmanifest', 'utf8'));
  const en = JSON.parse(await readFile('public/manifest.en.webmanifest', 'utf8'));
  for (const manifest of [zh, en]) {
    assert.equal(manifest.id, './');
    assert.equal(manifest.start_url, '.');
    assert.equal(manifest.scope, './');
    assert.equal(manifest.display, 'standalone');
    assert.ok(manifest.icons.some((icon) => icon.sizes === '192x192'));
    assert.ok(manifest.icons.some((icon) => icon.sizes === '512x512'));
    assert.ok(manifest.icons.some((icon) => icon.src === './icon-maskable.png' && icon.purpose === 'maskable'));
    assert.ok(manifest.icons.every((icon) => icon.type === 'image/png'));
  }
  assert.equal(zh.lang, 'zh-Hant-TW');
  assert.equal(en.lang, 'en');
});

test('supplied artwork powers favicon, PWA, Apple and in-app brand icon surfaces', async () => {
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const dimensions = async (path) => {
    const bytes = await readFile(path);
    assert.ok(bytes.subarray(0, 8).equals(pngSignature), `${path} is not a PNG`);
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  };
  assert.deepEqual(await dimensions('public/favicon.png'), [64, 64]);
  assert.deepEqual(await dimensions('public/icon-192.png'), [192, 192]);
  assert.deepEqual(await dimensions('public/icon-512.png'), [512, 512]);
  assert.deepEqual(await dimensions('public/icon-maskable.png'), [512, 512]);
  assert.deepEqual(await dimensions('public/apple-touch-icon.png'), [180, 180]);
  const html = await readFile('index.html', 'utf8');
  const app = await readFile('src/app.js', 'utf8');
  assert.match(html, /rel="icon" href="\.\/favicon\.png"/);
  assert.match(html, /apple-touch-icon\.png/);
  assert.match(app, /src: '\.\/icon-192\.png'/);
});

test('Service Worker caches hashed build assets before atomically replacing the offline document', async () => {
  const source = await readFile('public/sw.js', 'utf8');
  assert.match(source, /progress-tracker-v12/);
  assert.match(source, /favicon\.png/);
  assert.match(source, /icon-maskable\.png/);
  assert.match(source, /documentAssets\(html\)/);
  assert.match(source, /await Promise\.all\(assets\.map/);
  assert.match(source, /Content-Type', 'text\/javascript/);
  assert.match(source, /Content-Type', 'text\/css/);
  assert.ok(source.indexOf('await Promise.all(assets.map') < source.indexOf('await cache.put(scoped(INDEX_URL)'));
  assert.match(source, /event\.request\.mode === 'navigate'/);
  assert.match(source, /cache\.match\(scoped\(INDEX_URL\)\)/);
});

test('document shell and responsive CSS preserve safe areas and reduced motion', async () => {
  const html = await readFile('index.html', 'utf8');
  const css = await readFile('src/styles.css', 'utf8');
  const app = await readFile('src/app.js', 'utf8');
  assert.match(html, /<html lang="zh-Hant-TW">/);
  assert.match(html, /manifest\.en\.webmanifest/);
  assert.match(html, /initial-scale=1\.0, minimum-scale=1\.0, maximum-scale=1\.0, user-scalable=no/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /apple-mobile-web-app-title/);
  assert.match(css, /-webkit-text-size-adjust: 100%/);
  assert.match(css, /#app \{ width: 100%; min-width: 0; max-width: 100%/);
  assert.match(css, /input, textarea, select \{ font-size: 16px; \}/);
  assert.match(css, /\.detail-chevron \{ width: 100%; min-width: 0/);
  assert.match(app, /const className = \['icon-button', options\.className\]/);
  assert.match(css, /env\(safe-area-inset-top/);
  assert.match(css, /env\(safe-area-inset-bottom/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /animation-duration: \.01ms !important/);
  assert.match(css, /app-body\.recovery-only/);
});
