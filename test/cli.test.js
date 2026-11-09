'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'ssma.js');
const SAMPLES = path.join(__dirname, '..', 'samples');
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

test('check exits 0 on the clean sample', () => {
  const r = run('check', path.join(SAMPLES, 'sitemap-clean.xml'), '--no-robots');
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /0 error\(s\), 0 warning\(s\)/);
});

test('check exits 1 on the broken sample and prints findings', () => {
  const r = run('check', path.join(SAMPLES, 'sitemap-broken.xml'), '--no-robots');
  assert.strictEqual(r.status, 1);
  assert.match(r.stdout, /\[ERROR\]/);
  assert.match(r.stdout, /bare "&"/);
});

test('--strict turns warnings into a failing exit code', () => {
  const warnOnly = path.join(__dirname, 'fixtures-warn.xml');
  require('node:fs').writeFileSync(warnOnly, '<urlset><url><loc>http://shop.example.com/products/a</loc></url></urlset>');
  try {
    assert.strictEqual(run('check', warnOnly, '--no-robots').status, 0);
    assert.strictEqual(run('check', warnOnly, '--no-robots', '--strict').status, 1);
  } finally {
    require('node:fs').unlinkSync(warnOnly);
  }
});

test('--json prints parseable output', () => {
  const r = run('check', path.join(SAMPLES, 'sitemap-broken.xml'), '--no-robots', '--json');
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.errors, 6);
  assert.ok(Array.isArray(j.findings));
  assert.ok(!('urls' in j));
});

test('list prints one URL per line and honours --filter', () => {
  const all = run('list', path.join(SAMPLES, 'sitemap-clean.xml')).stdout.trim().split('\n');
  assert.strictEqual(all.length, 4);
  const some = run('list', path.join(SAMPLES, 'sitemap-clean.xml'), '--filter', 'headlamp').stdout.trim().split('\n');
  assert.deepStrictEqual(some, ['https://shop.example.com/products/headlamp']);
});

test('reads from stdin with -', () => {
  const r = spawnSync(process.execPath, [BIN, 'check', '-', '--no-robots'], { input: '<urlset><url><loc>https://s.example.com/products/a</loc></url></urlset>', encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Source: stdin/);
});

test('exit code 2 for usage errors', () => {
  assert.strictEqual(run().status, 2);
  assert.strictEqual(run('check').status, 2);
  assert.strictEqual(run('nope', 'x').status, 2);
  assert.strictEqual(run('check', 'x.xml', '--max-sitemaps', '0').status, 2);
});

test('--help exits 0', () => {
  const r = run('--help');
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /ssma - Shopify sitemap auditor/);
});
