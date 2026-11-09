'use strict';

// Just enough of RFC 9309 to answer "would this crawler be blocked from this
// URL?" for the sitemap cross-check. For a full audit of a robots.txt file see
// https://github.com/Ecom-Swift-LLC/shopify-robots-txt-auditor

function parse(text) {
  const groups = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (key === 'allow' || key === 'disallow') {
      lastWasAgent = false;
      if (cur && value) cur.rules.push({ allow: key === 'allow', value });
    } else {
      lastWasAgent = false;
    }
  }
  return { groups };
}

function toRegex(pattern) {
  const end = pattern.endsWith('$');
  const body = end ? pattern.slice(0, -1) : pattern;
  const src = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + src + (end ? '$' : ''));
}

// Returns the deciding Disallow pattern if the crawler is blocked, else null.
function blockedBy(parsed, agent, pathAndQuery) {
  const ua = agent.toLowerCase();
  let groups = parsed.groups.filter((g) => g.agents.includes(ua));
  if (!groups.length) groups = parsed.groups.filter((g) => g.agents.includes('*'));
  let best = null;
  for (const g of groups) {
    for (const r of g.rules) {
      if (!toRegex(r.value).test(pathAndQuery)) continue;
      if (!best || r.value.length > best.value.length || (r.value.length === best.value.length && r.allow && !best.allow)) best = r;
    }
  }
  return best && !best.allow ? best.value : null;
}

module.exports = { parse, blockedBy };
