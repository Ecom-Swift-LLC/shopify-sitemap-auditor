'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { auditStore } = require('../lib/audit');

const SAMPLES = path.join(__dirname, '..', 'samples');
const codes = (r) => r.findings.map((f) => f.code);
const has = (r, code, severity) => r.findings.some((f) => f.code === code && (!severity || f.severity === severity));

function tmpFile(name, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssma-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

function urlset(urls) {
  return `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
}

test('the clean sample has no errors or warnings', async () => {
  const r = await auditStore(path.join(SAMPLES, 'sitemap-clean.xml'), { robots: false });
  assert.strictEqual(r.errors, 0);
  assert.strictEqual(r.warnings, 0);
  assert.strictEqual(r.totalUrls, 4);
  assert.strictEqual(r.counts.product, 4);
});

test('the broken sample reports every planted problem', async () => {
  const r = await auditStore(path.join(SAMPLES, 'sitemap-broken.xml'), { robots: false });
  for (const code of ['missing-loc', 'unescaped-ampersand', 'not-absolute', 'fragment', 'bad-lastmod', 'host-mismatch']) assert.ok(has(r, code, 'error'), code);
  for (const code of ['http', 'myshopify-host', 'query-string', 'collection-scoped-product', 'duplicate', 'future-lastmod', 'bad-changefreq', 'bad-priority']) assert.ok(has(r, code, 'warn'), code);
  assert.ok(has(r, 'ignored-fields', 'info'));
});

test('the broken sample uses a fixed clock for the future-date check', async () => {
  const r = await auditStore(path.join(SAMPLES, 'sitemap-broken.xml'), { robots: false, now: Date.parse('2032-01-01') });
  assert.ok(!has(r, 'future-lastmod'));
});

test('a local sitemap index is read but its children are not followed', async () => {
  const r = await auditStore(path.join(SAMPLES, 'sitemap-index-clean.xml'), { robots: false });
  assert.strictEqual(r.errors, 0);
  assert.ok(has(r, 'children-not-read', 'info'));
});

test('an empty urlset is an error', async () => {
  const r = await auditStore(tmpFile('empty.xml', urlset([])), { robots: false });
  assert.ok(has(r, 'empty', 'error'));
});

test('an HTML page is reported as not XML', async () => {
  const r = await auditStore(tmpFile('page.xml', '<!doctype html><html><body>Opening soon</body></html>'), { robots: false });
  assert.deepStrictEqual(codes(r), ['html-not-xml']);
});

test('more than 50,000 URLs is an error', async () => {
  const urls = Array.from({ length: 50001 }, (_, i) => `https://shop.example.com/products/p${i}`);
  const r = await auditStore(tmpFile('big.xml', urlset(urls)), { robots: false });
  assert.ok(has(r, 'too-many', 'error'));
});

test('a URL over 2048 characters is an error', async () => {
  const r = await auditStore(tmpFile('long.xml', urlset(['https://shop.example.com/products/' + 'a'.repeat(2100)])), { robots: false });
  assert.ok(has(r, 'url-too-long', 'error'));
});

test('uniform lastmod on 20 or more entries is flagged as info', async () => {
  const body = `<urlset>${Array.from({ length: 25 }, (_, i) => `<url><loc>https://s.example.com/products/p${i}</loc><lastmod>2026-11-01</lastmod></url>`).join('')}</urlset>`;
  const r = await auditStore(tmpFile('uniform.xml', body), { robots: false });
  assert.ok(has(r, 'uniform-lastmod', 'info'));
});

test('a local file given --host flags URLs on another host', async () => {
  const r = await auditStore(tmpFile('h.xml', urlset(['https://a.example.com/products/x', 'https://b.example.com/products/y'])), { robots: false, host: 'a.example.com' });
  assert.ok(has(r, 'host-mismatch', 'error'));
});

// ---- live-store behaviour against a local HTTP server -----------------------

function startStore(routes) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const route = routes[req.url.split('#')[0]];
      if (!route) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
      }
      const r = typeof route === 'function' ? route(server.base) : route;
      res.writeHead(r.status || 200, Object.assign({ 'content-type': 'application/xml' }, r.headers));
      res.end(r.body === undefined ? '' : r.body);
    });
    server.listen(0, '127.0.0.1', () => {
      server.base = `http://127.0.0.1:${server.address().port}`;
      resolve(server);
    });
  });
}

const idx = (base, names) => `<sitemapindex>${names.map((n) => `<sitemap><loc>${base}/${n}</loc></sitemap>`).join('')}</sitemapindex>`;

test('follows every child sitemap of a live store and totals the URLs', async () => {
  const server = await startStore({
    '/sitemap.xml': (b) => ({ body: idx(b, ['sitemap_products_1.xml', 'sitemap_pages_1.xml']) }),
    '/sitemap_products_1.xml': (b) => ({ body: urlset([`${b}/products/a`, `${b}/products/b`]) }),
    '/sitemap_pages_1.xml': (b) => ({ body: urlset([`${b}/pages/about`]) }),
    '/robots.txt': { body: 'User-agent: *\nDisallow: /admin\n', headers: { 'content-type': 'text/plain' } },
  });
  try {
    const r = await auditStore(server.base, {});
    assert.strictEqual(r.documents.length, 3);
    assert.strictEqual(r.totalUrls, 3);
    assert.strictEqual(r.counts.product, 2);
    assert.strictEqual(r.counts.page, 1);
    assert.strictEqual(r.errors, 0);
    assert.ok(!has(r, 'blocked-by-robots'));
    assert.deepStrictEqual(r.robots, { checked: 3, blocked: 0 });
  } finally {
    server.close();
  }
});

test('reports a child sitemap that 404s and one that is nested', async () => {
  const server = await startStore({
    '/sitemap.xml': (b) => ({ body: idx(b, ['missing.xml', 'nested.xml']) }),
    '/nested.xml': (b) => ({ body: idx(b, ['x.xml']) }),
  });
  try {
    const r = await auditStore(server.base, { robots: false });
    assert.ok(has(r, 'http-status', 'error'));
    assert.ok(has(r, 'nested-index', 'error'));
  } finally {
    server.close();
  }
});

test('--max-sitemaps caps how many children are read', async () => {
  const server = await startStore({
    '/sitemap.xml': (b) => ({ body: idx(b, ['a.xml', 'b.xml', 'c.xml']) }),
    '/a.xml': (b) => ({ body: urlset([`${b}/products/a`]) }),
    '/b.xml': (b) => ({ body: urlset([`${b}/products/b`]) }),
    '/c.xml': (b) => ({ body: urlset([`${b}/products/c`]) }),
  });
  try {
    const r = await auditStore(server.base, { robots: false, maxSitemaps: 2 });
    assert.strictEqual(r.documents.length, 3);
    assert.ok(has(r, 'children-capped', 'info'));
    assert.ok(!has(r, 'no-products'));
  } finally {
    server.close();
  }
});

test('flags a URL listed in two child sitemaps', async () => {
  const server = await startStore({
    '/sitemap.xml': (b) => ({ body: idx(b, ['a.xml', 'b.xml']) }),
    '/a.xml': (b) => ({ body: urlset([`${b}/products/same`]) }),
    '/b.xml': (b) => ({ body: urlset([`${b}/products/same`]) }),
  });
  try {
    const r = await auditStore(server.base, { robots: false });
    assert.ok(has(r, 'cross-file-duplicate', 'warn'));
  } finally {
    server.close();
  }
});

test('warns when sitemap URLs are blocked for Googlebot by robots.txt', async () => {
  const server = await startStore({
    '/sitemap.xml': (b) => ({ body: urlset([`${b}/products/a`, `${b}/collections/all`]) }),
    '/robots.txt': { body: 'User-agent: *\nDisallow: /collections/\n', headers: { 'content-type': 'text/plain' } },
  });
  try {
    const r = await auditStore(server.base, {});
    const f = r.findings.find((x) => x.code === 'blocked-by-robots');
    assert.ok(f);
    assert.match(f.message, /\/collections\/all/);
    assert.deepStrictEqual(r.robots, { checked: 2, blocked: 1 });
  } finally {
    server.close();
  }
});

test('warns when a store with a complete sitemap has no product URLs', async () => {
  const server = await startStore({ '/sitemap.xml': (b) => ({ body: urlset([`${b}/pages/about`]) }) });
  try {
    const r = await auditStore(server.base, { robots: false });
    assert.ok(has(r, 'no-products', 'warn'));
  } finally {
    server.close();
  }
});

test('--check-urls reports 404s and redirects among a sample', async () => {
  const server = await startStore({
    '/sitemap.xml': (b) => ({ body: urlset([`${b}/products/ok`, `${b}/products/moved`, `${b}/products/gone`]) }),
    '/products/ok': { body: 'ok', headers: { 'content-type': 'text/html' } },
    '/products/moved': { status: 301, headers: { location: '/products/ok' } },
  });
  try {
    const r = await auditStore(server.base, { robots: false, checkUrls: 3 });
    assert.strictEqual(r.sampled.checked, 3);
    assert.ok(has(r, 'url-404', 'error'));
    assert.ok(has(r, 'url-redirect', 'warn'));
  } finally {
    server.close();
  }
});

test('a gzipped sitemap is read', async () => {
  const zlib = require('node:zlib');
  const server = await startStore({
    '/sitemap.xml': (b) => ({ body: zlib.gzipSync(urlset([`${b}/products/a`])), headers: { 'content-type': 'application/gzip' } }),
  });
  try {
    const r = await auditStore(server.base, { robots: false });
    assert.strictEqual(r.totalUrls, 1);
    assert.ok(!has(r, 'content-type'));
  } finally {
    server.close();
  }
});

test('a bare domain resolves to /sitemap.xml and an XML page served as HTML is warned about', async () => {
  const server = await startStore({
    '/sitemap.xml': (b) => ({ body: urlset([`${b}/products/a`]), headers: { 'content-type': 'text/html' } }),
  });
  try {
    const r = await auditStore(server.base, { robots: false });
    assert.ok(has(r, 'content-type', 'warn'));
  } finally {
    server.close();
  }
});
