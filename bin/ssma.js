#!/usr/bin/env node
'use strict';

const { auditStore } = require('../lib/audit');

const HELP = `ssma - Shopify sitemap auditor

Usage:
  ssma check <store-domain | sitemap-url | file.xml | ->   audit a sitemap (a live store follows every child sitemap)
  ssma list  <store-domain | sitemap-url | file.xml | ->   print every URL, one per line (for diffing or piping)

Options:
  --json               machine-readable output
  --strict             exit 1 on warnings as well as errors
  --no-follow          read only the first file; do not fetch child sitemaps
  --max-sitemaps <n>   most child sitemaps to read (default 25)
  --check-urls <n>     also request a spread sample of n URLs and report 404s, 5xx and redirects (default 0)
  --no-robots          skip the robots.txt cross-check
  --filter <text>      list: only URLs containing this text
  --host <h>           host the URLs should be on (for local files)
  -h, --help           show this help

Exit codes: 0 clean, 1 errors (or warnings with --strict), 2 the tool could not run.
`;

function parseArgs(argv) {
  const args = { _: [], json: false, strict: false, follow: true, robots: true, maxSitemaps: 25, checkUrls: 0, filter: null, host: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--strict') args.strict = true;
    else if (a === '--no-follow') args.follow = false;
    else if (a === '--no-robots') args.robots = false;
    else if (a === '--max-sitemaps') args.maxSitemaps = Number(argv[++i]);
    else if (a === '--check-urls') args.checkUrls = Number(argv[++i]);
    else if (a === '--filter') args.filter = argv[++i];
    else if (a === '--host') args.host = argv[++i];
    else if (a === '-h' || a === '--help') args.help = true;
    else args._.push(a);
  }
  if (!Number.isInteger(args.maxSitemaps) || args.maxSitemaps < 1) throw new Error('--max-sitemaps needs a whole number of 1 or more');
  if (!Number.isInteger(args.checkUrls) || args.checkUrls < 0) throw new Error('--check-urls needs a whole number of 0 or more');
  return args;
}

function exitCode(result, strict) {
  if (result.errors > 0) return 1;
  if (strict && result.warnings > 0) return 1;
  return 0;
}

async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  if (args.help || !cmd) {
    console.log(HELP);
    return args.help ? 0 : 2;
  }
  if (cmd !== 'check' && cmd !== 'list') throw new Error(`unknown command "${cmd}"`);
  const input = args._[1];
  if (!input) throw new Error(`${cmd} needs a store domain, a sitemap URL, a file, or - for stdin`);

  const result = await auditStore(input, {
    follow: args.follow,
    maxSitemaps: args.maxSitemaps,
    checkUrls: args.checkUrls,
    robots: args.robots && cmd === 'check',
    host: args.host,
  });

  if (cmd === 'list') {
    const urls = result.urls.map((x) => x.url).filter((u) => !args.filter || u.includes(args.filter));
    if (args.json) console.log(JSON.stringify(urls, null, 2));
    else for (const u of urls) console.log(u);
    return 0;
  }

  if (args.json) {
    const { urls, ...rest } = result;
    console.log(JSON.stringify(rest, null, 2));
  } else {
    console.log(`Source: ${result.source}`);
    for (const d of result.documents) {
      const kind = d.type === 'index' ? 'sitemap index' : d.type === 'urlset' ? 'urlset' : d.type;
      console.log(`  ${d.name}: ${kind}, ${d.entries} entr${d.entries === 1 ? 'y' : 'ies'}, ${(d.bytes / 1024).toFixed(1)} KiB, HTTP ${d.status}`);
    }
    console.log('\nSitemap check\n');
    const shown = result.findings;
    if (!shown.length) console.log('No findings.');
    for (const f of shown) {
      const tag = f.severity === 'error' ? '[ERROR]' : f.severity === 'warn' ? '[WARN ]' : '[INFO ]';
      console.log(`${tag} ${f.message}`);
    }
    console.log(`\n${result.errors} error(s), ${result.warnings} warning(s), ${result.info} info`);
  }
  return exitCode(result, args.strict);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error('ssma: ' + err.message);
    process.exit(2);
  }
);
