'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseSitemap, validLastmod, decode } = require('../lib/xml');

test('reads a urlset with lastmod and images', () => {
  const p = parseSitemap(`<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
<url><loc>https://a.test/products/x</loc><lastmod>2026-01-02</lastmod>
<image:image><image:loc>https://cdn.test/x.jpg</image:loc></image:image></url>
</urlset>`);
  assert.strictEqual(p.type, 'urlset');
  assert.strictEqual(p.entries.length, 1);
  assert.strictEqual(p.entries[0].loc, 'https://a.test/products/x');
  assert.strictEqual(p.entries[0].images, 1);
  assert.strictEqual(p.problems.truncated, false);
});

test('image:loc is not mistaken for the page loc', () => {
  const p = parseSitemap('<urlset><url><image:image><image:loc>https://cdn.test/a.jpg</image:loc></image:image></url></urlset>');
  assert.strictEqual(p.entries[0].loc, null);
  assert.strictEqual(p.problems.missingLoc.length, 1);
});

test('reads a sitemap index', () => {
  const p = parseSitemap('<sitemapindex><sitemap><loc>https://a.test/s1.xml</loc></sitemap><sitemap><loc>https://a.test/s2.xml</loc></sitemap></sitemapindex>');
  assert.strictEqual(p.type, 'index');
  assert.deepStrictEqual(p.entries.map((e) => e.loc), ['https://a.test/s1.xml', 'https://a.test/s2.xml']);
});

test('detects an HTML page served in place of a sitemap', () => {
  assert.strictEqual(parseSitemap('<!DOCTYPE html><html><body>Opening soon</body></html>').type, 'html');
});

test('detects a document with no sitemap root', () => {
  assert.strictEqual(parseSitemap('<rss><channel></channel></rss>').type, 'unknown');
});

test('flags a truncated file and unbalanced tags', () => {
  const p = parseSitemap('<urlset><url><loc>https://a.test/</loc></url><url><loc>https://a.test/b</loc>');
  assert.strictEqual(p.problems.truncated, true);
  assert.strictEqual(p.problems.unbalanced, true);
});

test('flags a bare ampersand but accepts &amp; and CDATA', () => {
  const p = parseSitemap(`<urlset>
<url><loc>https://a.test/?a=1&b=2</loc></url>
<url><loc>https://a.test/?a=1&amp;b=2</loc></url>
<url><loc><![CDATA[https://a.test/?a=1&b=3]]></loc></url>
</urlset>`);
  assert.deepStrictEqual(p.problems.rawAmp, [2]);
  assert.strictEqual(p.entries[1].loc, 'https://a.test/?a=1&b=2');
  assert.strictEqual(p.entries[2].loc, 'https://a.test/?a=1&b=3');
});

test('reports line numbers of entries', () => {
  const p = parseSitemap('<urlset>\n<url><loc>https://a.test/1</loc></url>\n\n<url><loc>https://a.test/2</loc></url>\n</urlset>');
  assert.deepStrictEqual(p.entries.map((e) => e.line), [2, 4]);
});

test('ignores commented-out entries', () => {
  const p = parseSitemap('<urlset><!-- <url><loc>https://a.test/old</loc></url> --><url><loc>https://a.test/new</loc></url></urlset>');
  assert.deepStrictEqual(p.entries.map((e) => e.loc), ['https://a.test/new']);
});

test('strips a byte order mark', () => {
  assert.strictEqual(parseSitemap('﻿<urlset><url><loc>https://a.test/</loc></url></urlset>').type, 'urlset');
});

test('validLastmod accepts W3C datetimes and rejects others', () => {
  for (const ok of ['2026', '2026-10', '2026-10-21', '2026-10-21T09:14:02Z', '2026-10-21T09:14:02.123-04:00', '2026-10-21T09:14+01:00']) {
    assert.ok(validLastmod(ok), ok);
  }
  for (const bad of ['21/10/2026', '2026-13-01', '2026-02-30', '2026-10-21 09:14:02', '2026-10-21T25:00:00Z', '2026-10-21T09:14:02', 'yesterday', '']) {
    assert.strictEqual(validLastmod(bad), null, bad);
  }
});

test('decode handles named and numeric entities', () => {
  assert.strictEqual(decode('a&amp;b &lt;c&gt; &quot;d&quot; &#65;&#x42;'), 'a&b <c> "d" AB');
});
