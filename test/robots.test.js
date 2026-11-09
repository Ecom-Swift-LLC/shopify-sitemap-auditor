'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parse, blockedBy } = require('../lib/robots');

const file = parse(`User-agent: *
Disallow: /admin
Disallow: /collections/*sort_by*
Disallow: /cart
Allow: /cart/public$

User-agent: Googlebot
Disallow: /private
`);

test('a Googlebot group replaces the * group for Googlebot', () => {
  assert.strictEqual(blockedBy(file, 'Googlebot', '/admin'), null);
  assert.strictEqual(blockedBy(file, 'Googlebot', '/private/x'), '/private');
});

test('wildcards and anchors work', () => {
  assert.strictEqual(blockedBy(file, 'Bingbot', '/collections/all?sort_by=price'), '/collections/*sort_by*');
  assert.strictEqual(blockedBy(file, 'Bingbot', '/collections/all'), null);
});

test('the longest matching rule wins and Allow beats Disallow', () => {
  assert.strictEqual(blockedBy(file, 'Bingbot', '/cart/public'), null);
  assert.strictEqual(blockedBy(file, 'Bingbot', '/cart/public/x'), '/cart');
});

test('an empty Disallow blocks nothing', () => {
  assert.strictEqual(blockedBy(parse('User-agent: *\nDisallow:\n'), 'Googlebot', '/anything'), null);
});

test('a leftover site-wide block is found', () => {
  assert.strictEqual(blockedBy(parse('User-agent: *\nDisallow: /\n'), 'Googlebot', '/products/x'), '/');
});
