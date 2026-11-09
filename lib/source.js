'use strict';

const fs = require('fs');
const zlib = require('zlib');

const UA = 'shopify-sitemap-auditor/1.0 (+https://github.com/Ecom-Swift-LLC/shopify-sitemap-auditor)';

function decodeBody(buf) {
  const b = Buffer.from(buf);
  const data = b.length > 2 && b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b;
  return data.toString('utf8');
}

function fetchUrl(url, opts) {
  const o = opts || {};
  const fetchImpl = o.fetch || globalThis.fetch;
  if (!fetchImpl) throw new Error('This Node version has no fetch(). Use Node 18 or newer.');
  return fetchImpl(url, {
    redirect: o.redirect || 'follow',
    signal: AbortSignal.timeout(o.timeoutMs || 20000),
    headers: { 'user-agent': UA, accept: 'application/xml,text/xml,*/*;q=0.5' },
  });
}

// Resolve the user's input to a sitemap location.
// Returns { kind: 'file' | 'stdin' | 'url', value }.
function resolveInput(input) {
  if (input === '-') return { kind: 'stdin', value: '-' };
  if (fs.existsSync(input) && fs.statSync(input).isFile()) return { kind: 'file', value: input };
  const url = /^https?:\/\//i.test(input) ? input : 'https://' + input;
  const u = new URL(url);
  if (u.pathname === '/' || u.pathname === '') u.pathname = '/sitemap.xml';
  u.hash = '';
  return { kind: 'url', value: u.toString() };
}

// Load one sitemap document. HTTP error statuses are returned, not thrown;
// network failures throw.
async function loadDocument(target, opts) {
  if (target.kind === 'stdin') {
    return { url: null, label: 'stdin', status: 200, contentType: 'application/xml', text: fs.readFileSync(0, 'utf8') };
  }
  if (target.kind === 'file') {
    return { url: null, label: target.value, status: 200, contentType: 'application/xml', text: decodeBody(fs.readFileSync(target.value)) };
  }
  const res = await fetchUrl(target.value, opts);
  const buf = await res.arrayBuffer();
  return {
    url: res.url || target.value,
    label: target.value,
    status: res.status,
    contentType: res.headers.get('content-type') || '',
    text: decodeBody(buf),
  };
}

module.exports = { resolveInput, loadDocument, fetchUrl, UA };
