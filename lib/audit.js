'use strict';

const { parseSitemap, validLastmod } = require('./xml');
const robotsLib = require('./robots');
const { resolveInput, loadDocument, fetchUrl } = require('./source');

// Limits from https://www.sitemaps.org/protocol.html and Google's sitemap docs.
const LIMITS = { urls: 50000, bytes: 50 * 1024 * 1024, urlLength: 2048, images: 1000 };
const CHANGEFREQ = new Set(['always', 'hourly', 'daily', 'weekly', 'monthly', 'yearly', 'never']);

function examples(items, fmt, max) {
  const m = max || 3;
  const shown = items.slice(0, m).map(fmt).join('; ');
  return items.length > m ? `${shown} (and ${items.length - m} more)` : shown;
}

function shortName(label) {
  try {
    const u = new URL(label);
    return u.pathname.split('/').pop() || u.hostname;
  } catch (_) {
    return String(label).split(/[\\/]/).pop();
  }
}

function classify(pathname) {
  if (/^\/collections\/[^/]+\/products\//.test(pathname)) return 'collection-scoped product';
  if (/^\/products\//.test(pathname)) return 'product';
  if (/^\/collections\//.test(pathname)) return 'collection';
  if (/^\/blogs\/[^/]+\/[^/]+/.test(pathname)) return 'article';
  if (/^\/blogs\//.test(pathname)) return 'blog';
  if (/^\/pages\//.test(pathname)) return 'page';
  if (pathname === '/' || pathname === '') return 'home';
  return 'other';
}

// Checks one parsed sitemap document. Returns { findings, urls } where urls
// are the usable entries, so the caller can run cross-file checks.
function checkDocument(doc, parsed, ctx) {
  const name = ctx.name;
  const out = [];
  const add = (severity, code, message) => out.push({ severity, code, file: name, message: `${name}: ${message}` });

  if (ctx.status && ctx.status !== 200) {
    add('error', 'http-status', `returned HTTP ${ctx.status}. Crawlers need a 200 response.`);
    if (ctx.status >= 400) return { findings: out, urls: [] };
  }
  if (parsed.type === 'html') {
    add('error', 'html-not-xml', 'is an HTML page, not sitemap XML. Check that the URL is right and the store is not behind a password page.');
    return { findings: out, urls: [] };
  }
  if (parsed.type === 'unknown') {
    add('error', 'not-sitemap', 'has no <urlset> or <sitemapindex> root element, so crawlers will not read it as a sitemap.');
    return { findings: out, urls: [] };
  }
  if (ctx.contentType && !/xml/i.test(ctx.contentType) && !/gzip|octet-stream/i.test(ctx.contentType)) {
    add('warn', 'content-type', `is served as "${ctx.contentType.split(';')[0]}" rather than an XML type.`);
  }

  if (parsed.problems.truncated) add('error', 'truncated', 'is missing its closing root tag. The file was cut off or is malformed, and parsers will reject it.');
  if (parsed.problems.unbalanced) add('error', 'unbalanced', `has unbalanced <${parsed.type === 'index' ? 'sitemap' : 'url'}> tags, so the XML is malformed.`);
  if (parsed.problems.missingLoc.length) {
    add('error', 'missing-loc', `${parsed.problems.missingLoc.length} entr${parsed.problems.missingLoc.length === 1 ? 'y has' : 'ies have'} no <loc> (line ${examples(parsed.problems.missingLoc, (l) => l)}).`);
  }
  if (parsed.problems.rawAmp.length) {
    add('error', 'unescaped-ampersand', `${parsed.problems.rawAmp.length} <loc> value(s) contain a bare "&" (line ${examples(parsed.problems.rawAmp, (l) => l)}). It must be written &amp; or the XML is invalid.`);
  }

  const total = parsed.entries.length;
  const unit = parsed.type === 'index' ? 'sitemap' : 'URL';
  if (total === 0) {
    add('error', 'empty', `lists no ${unit}s. ${parsed.type === 'urlset' ? 'An empty sitemap gives crawlers nothing to find. Check the content is published to the Online Store channel and the storefront is not behind a password.' : ''}`.trim());
  }
  if (total > LIMITS.urls) add('error', 'too-many', `lists ${total} ${unit}s; the limit is ${LIMITS.urls} per file.`);
  if (parsed.bytes > LIMITS.bytes) add('error', 'too-big', `is ${(parsed.bytes / 1048576).toFixed(1)} MiB uncompressed; the limit is 50 MiB.`);

  const bad = { notAbs: [], http: [], myshopify: [], otherHost: [], long: [], frag: [], ws: [], query: [], badMod: [], future: [], dupes: [], collProd: [], badPrio: [], badFreq: [], images: [] };
  let freqPrio = 0;
  const seen = new Map();
  const urls = [];
  const hosts = new Map();
  const now = ctx.now || Date.now();

  for (const e of parsed.entries) {
    if (e.loc === null || !e.loc.trim()) continue;
    const trimmed = e.loc.trim();
    if (trimmed !== e.loc) bad.ws.push(e);
    let u = null;
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        u = new URL(trimmed);
      } catch (_) {
        u = null;
      }
    }
    if (!u) {
      bad.notAbs.push(e);
      continue;
    }
    urls.push({ url: trimmed, host: u.hostname.toLowerCase(), pathname: u.pathname, search: u.search, lastmod: e.lastmod, line: e.line });
    hosts.set(u.hostname.toLowerCase(), (hosts.get(u.hostname.toLowerCase()) || 0) + 1);

    if (u.protocol === 'http:') bad.http.push(e);
    if (/\.myshopify\.com$/i.test(u.hostname) && !ctx.allowMyshopify) bad.myshopify.push(e);
    if (trimmed.length > LIMITS.urlLength) bad.long.push(e);
    if (u.hash) bad.frag.push(e);
    if (parsed.type === 'urlset') {
      if (u.search) bad.query.push(e);
      if (/^\/collections\/[^/]+\/products\//.test(u.pathname)) bad.collProd.push(e);
      if (e.images > LIMITS.images) bad.images.push(e);
    }
    if (seen.has(trimmed)) bad.dupes.push(e);
    else seen.set(trimmed, e.line);

    if (e.lastmod !== null) {
      const d = validLastmod(e.lastmod);
      if (!d) bad.badMod.push(e);
      else if (d.getTime() > now + 86400000) bad.future.push(e);
    }
    if (e.changefreq !== null || e.priority !== null) freqPrio++;
    if (e.changefreq !== null && !CHANGEFREQ.has(e.changefreq.toLowerCase())) bad.badFreq.push(e);
    if (e.priority !== null && !(Number(e.priority) >= 0 && Number(e.priority) <= 1)) bad.badPrio.push(e);
  }

  const L = (e) => `line ${e.line}: ${e.loc.trim().slice(0, 90)}`;
  if (bad.notAbs.length) add('error', 'not-absolute', `${bad.notAbs.length} <loc> value(s) are not absolute http(s) URLs (${examples(bad.notAbs, (e) => `line ${e.line}: ${String(e.loc).trim().slice(0, 60)}`)}). Every <loc> must be a full URL including https://.`);
  if (bad.http.length) add('warn', 'http', `${bad.http.length} ${unit}(s) use http:// (${examples(bad.http, L)}). Use the https:// address.`);
  if (bad.myshopify.length) add('warn', 'myshopify-host', `${bad.myshopify.length} ${unit}(s) point at a *.myshopify.com address (${examples(bad.myshopify, L)}). List the primary custom domain, or crawlers learn the wrong host.`);
  if (bad.long.length) add('error', 'url-too-long', `${bad.long.length} URL(s) are longer than ${LIMITS.urlLength} characters (${examples(bad.long, (e) => 'line ' + e.line)}).`);
  if (bad.frag.length) add('error', 'fragment', `${bad.frag.length} URL(s) contain a #fragment (${examples(bad.frag, L)}). Crawlers drop fragments, so these are duplicates of the base URL.`);
  if (bad.ws.length) add('warn', 'whitespace', `${bad.ws.length} <loc> value(s) have leading or trailing whitespace (${examples(bad.ws, (e) => 'line ' + e.line)}). Some parsers do not trim it.`);
  if (bad.query.length) add('warn', 'query-string', `${bad.query.length} URL(s) contain a query string (${examples(bad.query, L)}). Sitemaps should list canonical URLs, not filtered or tracking variants.`);
  if (bad.collProd.length) add('warn', 'collection-scoped-product', `${bad.collProd.length} product URL(s) are collection-scoped, /collections/<handle>/products/<handle> (${examples(bad.collProd, L)}). The canonical product URL is /products/<handle>; listing both splits signals.`);
  if (bad.dupes.length) add('warn', 'duplicate', `${bad.dupes.length} ${unit}(s) are listed more than once in this file (first repeat at ${examples(bad.dupes, L, 1)}).`);
  if (bad.badMod.length) add('error', 'bad-lastmod', `${bad.badMod.length} <lastmod> value(s) are not valid W3C dates (${examples(bad.badMod, (e) => `line ${e.line}: "${e.lastmod}"`)}). Use YYYY-MM-DD or a full ISO 8601 timestamp with a timezone.`);
  if (bad.future.length) add('warn', 'future-lastmod', `${bad.future.length} <lastmod> value(s) are in the future (${examples(bad.future, (e) => `line ${e.line}: ${e.lastmod}`)}). Google only uses lastmod when it is consistently accurate, so impossible dates undermine it.`);
  if (bad.badFreq.length) add('warn', 'bad-changefreq', `${bad.badFreq.length} <changefreq> value(s) are not one of always, hourly, daily, weekly, monthly, yearly, never (${examples(bad.badFreq, (e) => `line ${e.line}: "${e.changefreq}"`)}).`);
  if (bad.badPrio.length) add('warn', 'bad-priority', `${bad.badPrio.length} <priority> value(s) are outside 0.0 to 1.0 (${examples(bad.badPrio, (e) => `line ${e.line}: "${e.priority}"`)}).`);
  if (bad.images.length) add('warn', 'too-many-images', `${bad.images.length} URL(s) list more than ${LIMITS.images} images (${examples(bad.images, (e) => 'line ' + e.line)}). The extension allows ${LIMITS.images} per URL.`);

  const mods = parsed.entries.map((e) => e.lastmod).filter(Boolean);
  if (mods.length >= 20 && mods.length === parsed.entries.length && new Set(mods).size === 1) {
    add('info', 'uniform-lastmod', `every one of the ${mods.length} entries has the identical <lastmod> (${mods[0]}). Google only uses lastmod when it reflects real changes, so a single stamp on every page earns nothing.`);
  }

  // mixed hosts: a sitemap may only list URLs on the host it is served from
  const refHost = ctx.host || (hosts.size ? [...hosts.entries()].sort((a, b) => b[1] - a[1])[0][0] : null);
  if (refHost) {
    const off = urls.filter((x) => x.host !== refHost);
    if (off.length) {
      const sample = [...new Set(off.map((x) => x.host))].slice(0, 3).join(', ');
      add('error', 'host-mismatch', `${off.length} ${unit}(s) are on a different host than ${refHost} (${sample}). A sitemap may only list URLs on the host it is served from.`);
    }
  }
  return { findings: out, urls, host: refHost, freqPrio };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function tally(findings) {
  return {
    errors: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warn').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
}

// Audit a sitemap and, for a live store, the child sitemaps it points at.
// input: store domain, sitemap URL, local file path, or "-" for stdin.
async function auditStore(input, options) {
  const o = Object.assign({ follow: true, maxSitemaps: 25, checkUrls: 0, robots: true, concurrency: 4, now: Date.now() }, options || {});
  const findings = [];
  const documents = [];
  const allUrls = [];
  const target = resolveInput(input);
  const fetchOpts = { fetch: o.fetch, timeoutMs: o.timeoutMs };

  const root = await loadDocument(target, fetchOpts);
  const rootParsed = parseSitemap(root.text);
  const rootHost = root.url ? new URL(root.url).hostname.toLowerCase() : o.host ? o.host.toLowerCase() : null;
  const allowMyshopify = rootHost ? /\.myshopify\.com$/.test(rootHost) : false;
  if (root.url && target.kind === 'url' && new URL(target.value).hostname.toLowerCase() !== rootHost) {
    findings.push({ severity: 'info', code: 'redirected', file: shortName(root.label), message: `${new URL(target.value).hostname} redirected to ${rootHost}. Audit and submit the host it lands on.` });
  }

  const rootName = shortName(root.label) || 'sitemap.xml';
  const rootCheck = checkDocument(root, rootParsed, { name: rootName, host: rootHost, status: root.status, contentType: root.contentType, allowMyshopify, now: o.now });
  findings.push(...rootCheck.findings);
  documents.push({ name: rootName, location: root.url || root.label, type: rootParsed.type, entries: rootParsed.entries.length, bytes: rootParsed.bytes, status: root.status });

  let freqPrioTotal = rootCheck.freqPrio;
  const fileUrls = new Map(); // url -> first file it appeared in
  if (rootParsed.type === 'urlset') {
    allUrls.push(...rootCheck.urls);
  } else if (rootParsed.type === 'index') {
    const children = rootCheck.urls;
    const dupChildren = children.length - new Set(children.map((c) => c.url)).size;
    if (dupChildren > 0) findings.push({ severity: 'warn', code: 'duplicate-child', file: rootName, message: `${rootName}: ${dupChildren} child sitemap(s) are listed more than once.` });

    if (!o.follow || target.kind !== 'url') {
      findings.push({ severity: 'info', code: 'children-not-read', file: rootName, message: `${rootName}: lists ${children.length} child sitemap(s). ${target.kind === 'url' ? 'Not followed (--no-follow).' : 'Local files cannot follow them; run against the live store to audit the children.'}` });
    } else {
      const uniqueKids = [...new Map(children.map((c) => [c.url, c])).values()];
      const toRead = uniqueKids.slice(0, o.maxSitemaps);
      if (uniqueKids.length > toRead.length) {
        findings.push({ severity: 'info', code: 'children-capped', file: rootName, message: `${rootName}: read the first ${toRead.length} of ${uniqueKids.length} child sitemaps. Raise --max-sitemaps to read the rest.` });
      }
      const loaded = await mapLimit(toRead, o.concurrency, async (kid) => {
        try {
          return { kid, doc: await loadDocument({ kind: 'url', value: kid.url }, fetchOpts) };
        } catch (err) {
          return { kid, error: err };
        }
      });
      for (const r of loaded) {
        const name = shortName(r.kid.url);
        if (r.error) {
          findings.push({ severity: 'error', code: 'fetch-failed', file: name, message: `${name}: could not be fetched (${r.error.message}).` });
          continue;
        }
        const parsed = parseSitemap(r.doc.text);
        if (parsed.type === 'index') {
          findings.push({ severity: 'error', code: 'nested-index', file: name, message: `${name}: is a sitemap index listed inside a sitemap index. Indexes cannot be nested; Google does not follow them.` });
        }
        const childHost = new URL(r.doc.url || r.kid.url).hostname.toLowerCase();
        const check = checkDocument(r.doc, parsed, { name, host: childHost, status: r.doc.status, contentType: r.doc.contentType, allowMyshopify, now: o.now });
        findings.push(...check.findings);
        freqPrioTotal += check.freqPrio;
        documents.push({ name, location: r.doc.url || r.kid.url, type: parsed.type, entries: parsed.entries.length, bytes: parsed.bytes, status: r.doc.status });
        for (const x of check.urls) {
          if (fileUrls.has(x.url) && fileUrls.get(x.url) !== name) x.dupOf = fileUrls.get(x.url);
          else fileUrls.set(x.url, name);
        }
        allUrls.push(...check.urls);
      }
      const crossDupes = allUrls.filter((x) => x.dupOf);
      if (crossDupes.length) {
        findings.push({ severity: 'warn', code: 'cross-file-duplicate', file: rootName, message: `${crossDupes.length} URL(s) appear in more than one child sitemap (${examples(crossDupes, (x) => `${x.url.slice(0, 80)} also in ${x.dupOf}`)}).` });
      }
    }
  }

  if (freqPrioTotal > 0) {
    findings.push({ severity: 'info', code: 'ignored-fields', file: rootName, message: `${freqPrioTotal} entr${freqPrioTotal === 1 ? 'y uses' : 'ies use'} <changefreq> or <priority>. Google ignores both fields, so nothing to act on. Shopify generates these in its own sitemaps and they cannot be edited there.` });
  }

  const readAll = rootParsed.type === 'urlset' || (rootParsed.type === 'index' && o.follow && target.kind === 'url');
  const fullyRead = readAll && !findings.some((f) => f.code === 'children-capped' || f.code === 'fetch-failed');

  // counts by page type
  const counts = {};
  for (const x of allUrls) {
    const k = classify(x.pathname);
    counts[k] = (counts[k] || 0) + 1;
  }
  if (allUrls.length) {
    const parts = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => (k === 'other' ? `${n} other` : `${n} ${k}${n === 1 ? '' : 's'}`));
    findings.push({ severity: 'info', code: 'summary', file: rootName, message: `${allUrls.length} URL(s) across ${documents.length} sitemap file(s): ${parts.join(', ')}.` });
  }
  if (fullyRead && allUrls.length && !counts.product) {
    findings.push({ severity: 'warn', code: 'no-products', file: rootName, message: `${rootName}: no /products/ URLs found. If the store sells products, they are missing from the sitemap: check they are published to the Online Store channel and not hidden from search engines.` });
  }

  // robots.txt cross-check
  let robotsInfo = null;
  if (o.robots && target.kind === 'url' && allUrls.length) {
    try {
      const origin = new URL(root.url || target.value).origin;
      const res = await fetchUrl(origin + '/robots.txt', fetchOpts);
      if (res.status === 200) {
        const parsedRobots = robotsLib.parse(await res.text());
        const blocked = [];
        for (const x of allUrls) {
          const rule = robotsLib.blockedBy(parsedRobots, 'Googlebot', x.pathname + x.search);
          if (rule) blocked.push({ x, rule });
        }
        robotsInfo = { checked: allUrls.length, blocked: blocked.length };
        if (blocked.length) {
          findings.push({ severity: 'warn', code: 'blocked-by-robots', file: rootName, message: `${blocked.length} sitemap URL(s) are blocked for Googlebot by robots.txt (${examples(blocked, (b) => `${b.x.pathname} <- Disallow: ${b.rule}`)}). Google cannot crawl what you ask it to index. Run shopify-robots-txt-auditor to find the rule.` });
        }
      } else {
        findings.push({ severity: 'info', code: 'robots-skipped', file: rootName, message: `${rootName}: robots.txt returned HTTP ${res.status}, so the robots cross-check was skipped.` });
      }
    } catch (err) {
      findings.push({ severity: 'info', code: 'robots-skipped', file: rootName, message: `${rootName}: could not fetch robots.txt (${err.message}), so the robots cross-check was skipped.` });
    }
  }

  // sampled live URL check
  let sampled = null;
  if (o.checkUrls > 0 && allUrls.length) {
    const step = Math.max(1, Math.floor(allUrls.length / o.checkUrls));
    const sample = [];
    for (let i = 0; i < allUrls.length && sample.length < o.checkUrls; i += step) sample.push(allUrls[i]);
    const results = await mapLimit(sample, o.concurrency, async (x) => {
      try {
        const res = await fetchUrl(x.url, { fetch: o.fetch, timeoutMs: o.timeoutMs, redirect: 'manual' });
        if (res.body && res.body.cancel) res.body.cancel().catch(() => {});
        return { x, status: res.status, location: res.headers.get('location') };
      } catch (err) {
        return { x, error: err.message };
      }
    });
    sampled = { checked: results.length };
    const redirects = results.filter((r) => r.status >= 300 && r.status < 400);
    const gone = results.filter((r) => r.status === 404 || r.status === 410);
    const serverErr = results.filter((r) => r.status >= 500);
    const limited = results.filter((r) => r.status === 429);
    const failed = results.filter((r) => r.error);
    if (gone.length) findings.push({ severity: 'error', code: 'url-404', file: rootName, message: `${gone.length} of ${results.length} sampled URL(s) return 404/410 (${examples(gone, (r) => r.x.url.slice(0, 90))}). Remove dead URLs from the sitemap.` });
    if (serverErr.length) findings.push({ severity: 'error', code: 'url-5xx', file: rootName, message: `${serverErr.length} of ${results.length} sampled URL(s) return a server error (${examples(serverErr, (r) => `${r.status} ${r.x.url.slice(0, 80)}`)}).` });
    if (redirects.length) findings.push({ severity: 'warn', code: 'url-redirect', file: rootName, message: `${redirects.length} of ${results.length} sampled URL(s) redirect (${examples(redirects, (r) => `${r.status} ${r.x.url.slice(0, 70)} -> ${(r.location || '').slice(0, 70)}`)}). A sitemap should list the final URL, not one that redirects.` });
    if (limited.length) findings.push({ severity: 'warn', code: 'url-rate-limited', file: rootName, message: `${limited.length} sampled URL(s) returned 429 (rate limited), so they were not verified. Try a smaller --check-urls.` });
    if (failed.length) findings.push({ severity: 'warn', code: 'url-unreachable', file: rootName, message: `${failed.length} sampled URL(s) could not be fetched (${examples(failed, (r) => `${r.x.url.slice(0, 70)}: ${r.error}`)}).` });
  }

  const order = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { source: root.url || root.label, documents, totalUrls: allUrls.length, counts, robots: robotsInfo, sampled, urls: allUrls, findings, ...tally(findings) };
}

module.exports = { auditStore, checkDocument, classify, LIMITS };
