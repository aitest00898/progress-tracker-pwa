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
    assert.ok(manifest.icons.some((icon) => icon.purpose === 'maskable'));
  }
  assert.equal(zh.lang, 'zh-Hant-TW');
  assert.equal(en.lang, 'en');
});

test('Service Worker caches hashed build assets before atomically replacing the offline document', async () => {
  const source = await readFile('public/sw.js', 'utf8');
  assert.match(source, /progress-tracker-v9/);
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
  assert.match(html, /<html lang="zh-Hant-TW">/);
  assert.match(html, /manifest\.en\.webmanifest/);
  assert.match(html, /apple-mobile-web-app-capable/);
  assert.match(html, /apple-mobile-web-app-title/);
  assert.match(css, /env\(safe-area-inset-top/);
  assert.match(css, /env\(safe-area-inset-bottom/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /animation-duration: \.01ms !important/);
  assert.match(css, /app-body\.recovery-only/);
});
