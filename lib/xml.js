'use strict';

// A small, purpose-built reader for sitemap XML (sitemaps.org). It is not a
// general XML parser: it finds the root element, pulls out <url> / <sitemap>
// entries, and records the structural problems a crawler would trip over.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(cp);
      } catch (_) {
        return m;
      }
    }
    return ENTITIES[e.toLowerCase()];
  });
}

function tagText(block, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i');
  const m = re.exec(block);
  if (!m) return null;
  const raw = m[1];
  const hasCdata = /<!\[CDATA\[/.test(raw);
  const text = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  return { raw, text: hasCdata ? text : decode(text), hasCdata };
}

function lineAt(src, offset, state) {
  // offsets arrive in increasing order, so count newlines incrementally
  for (let i = state.pos; i < offset; i++) if (src.charCodeAt(i) === 10) state.line++;
  state.pos = offset;
  return state.line;
}

// Returns { type: 'index' | 'urlset' | 'html' | 'unknown', entries, problems, bytes }
function parseSitemap(text) {
  const src = String(text).replace(/^﻿/, '');
  const bytes = Buffer.byteLength(src, 'utf8');
  const problems = { missingLoc: [], rawAmp: [], truncated: false, unbalanced: false };

  const head = src.slice(0, 600).trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
    return { type: 'html', entries: [], problems, bytes };
  }

  // blank out the prolog and comments but keep newlines so line numbers stay right
  const stripped = src
    .replace(/<\?xml[\s\S]*?\?>/i, (c) => c.replace(/[^\n]/g, ' '))
    .replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
  const root = /<(?:[\w.-]+:)?(sitemapindex|urlset)\b/i.exec(stripped);
  if (!root) return { type: 'unknown', entries: [], problems, bytes };
  const type = root[1].toLowerCase() === 'sitemapindex' ? 'index' : 'urlset';
  const itemTag = type === 'index' ? 'sitemap' : 'url';

  if (!new RegExp('</(?:[\\w.-]+:)?' + root[1] + '\\s*>', 'i').test(stripped)) problems.truncated = true;

  const opens = (stripped.match(new RegExp('<' + itemTag + '(?:\\s[^>]*)?>', 'gi')) || []).length;
  const closes = (stripped.match(new RegExp('</' + itemTag + '>', 'gi')) || []).length;
  if (opens !== closes) problems.unbalanced = true;

  const entries = [];
  const re = new RegExp('<' + itemTag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + itemTag + '>', 'gi');
  const lines = { pos: 0, line: 1 };
  let m;
  while ((m = re.exec(stripped))) {
    const line = lineAt(stripped, m.index, lines);
    const body = m[1];
    const images = (body.match(/<image:image\b/gi) || []).length;
    const rest = body.replace(/<image:image\b[\s\S]*?<\/image:image>/gi, '').replace(/<video:video\b[\s\S]*?<\/video:video>/gi, '');
    const loc = tagText(rest, 'loc');
    const lastmod = tagText(rest, 'lastmod');
    const changefreq = tagText(rest, 'changefreq');
    const priority = tagText(rest, 'priority');
    if (loc && !loc.hasCdata && /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/i.test(loc.raw)) problems.rawAmp.push(line);
    if (!loc || !loc.text.trim()) problems.missingLoc.push(line);
    entries.push({
      line,
      loc: loc ? loc.text : null,
      lastmod: lastmod ? lastmod.text.trim() : null,
      changefreq: changefreq ? changefreq.text.trim() : null,
      priority: priority ? priority.text.trim() : null,
      images,
    });
  }
  return { type, entries, problems, bytes };
}

// W3C Datetime as the sitemap protocol uses it: YYYY, YYYY-MM, YYYY-MM-DD,
// or a full timestamp with a timezone designator. Returns a Date or null.
function validLastmod(v) {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?)?)?$/.exec(v);
  if (!m) return null;
  const [, y, mo, d, hh, mm, ss] = m;
  const month = mo ? Number(mo) : 1;
  const day = d ? Number(d) : 1;
  if (month < 1 || month > 12 || day < 1) return null;
  const date = new Date(Date.UTC(Number(y), month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  if (hh !== undefined && (Number(hh) > 23 || Number(mm) > 59 || (ss !== undefined && Number(ss) > 60))) return null;
  return date;
}

module.exports = { parseSitemap, validLastmod, decode };
