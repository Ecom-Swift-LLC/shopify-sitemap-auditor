# shopify-sitemap-auditor

A zero-dependency CLI that reads your Shopify store's `sitemap.xml` the way a crawler does, follows every child sitemap, and tells you what is wrong with it: an empty or HTML-instead-of-XML response, URLs on the wrong host, dates that are not valid, the same URL listed twice, product URLs that robots.txt blocks, and (optionally) listed pages that now return a 404 or redirect.

**Not sure your store's SEO and speed basics are covered?** [Run the free audit](https://audit.ecomswiftllc.com/?utm_source=github&utm_medium=repo&utm_campaign=shopify-sitemap-auditor) - it checks SEO, speed, CRO and AI-visibility signals on a live store in about a minute.

## Example output

Run against `samples/sitemap-broken.xml` in this repo, which plants these mistakes on purpose:

```
$ ssma check samples/sitemap-broken.xml --no-robots

[ERROR] sitemap-broken.xml: 1 entry has no <loc> (line 35).
[ERROR] sitemap-broken.xml: 1 <loc> value(s) contain a bare "&" (line 23). It must be written &amp; or the XML is invalid.
[ERROR] sitemap-broken.xml: 1 <loc> value(s) are not absolute http(s) URLs (line 17: /collections/all). Every <loc> must be a full URL including https://.
[ERROR] sitemap-broken.xml: 1 URL(s) contain a #fragment (line 26: https://shop-name.myshopify.com/pages/about#team). Crawlers drop fragments, so these are duplicates of the base URL.
[ERROR] sitemap-broken.xml: 1 <lastmod> value(s) are not valid W3C dates (line 13: "21/10/2026"). Use YYYY-MM-DD or a full ISO 8601 timestamp with a timezone.
[ERROR] sitemap-broken.xml: 2 URL(s) are on a different host than shop.example.com (shop-name.myshopify.com, staging.example.org). A sitemap may only list URLs on the host it is served from.
[WARN ] sitemap-broken.xml: 1 URL(s) use http:// (line 13: http://shop.example.com/products/camp-mug). Use the https:// address.
[WARN ] sitemap-broken.xml: 1 URL(s) point at a *.myshopify.com address (line 26: https://shop-name.myshopify.com/pages/about#team). List the primary custom domain, or crawlers learn the wrong host.
[WARN ] sitemap-broken.xml: 1 URL(s) contain a query string (line 23: https://shop.example.com/collections/all?sort_by=price-ascending&page=2). Sitemaps should list canonical URLs, not filtered or tracking variants.
[WARN ] sitemap-broken.xml: 1 product URL(s) are collection-scoped, /collections/<handle>/products/<handle> (line 20: https://shop.example.com/collections/camping/products/headlamp). The canonical product URL is /products/<handle>; listing both splits signals.
[WARN ] sitemap-broken.xml: 1 URL(s) are listed more than once in this file (first repeat at line 9: https://shop.example.com/products/trail-backpack).
[WARN ] sitemap-broken.xml: 1 <lastmod> value(s) are in the future (line 26: 2031-01-01). Google only uses lastmod when it is consistently accurate, so impossible dates undermine it.
[WARN ] sitemap-broken.xml: 1 <changefreq> value(s) are not one of always, hourly, daily, weekly, monthly, yearly, never (line 30: "sometimes").
[WARN ] sitemap-broken.xml: 1 <priority> value(s) are outside 0.0 to 1.0 (line 30: "2").
[INFO ] 2 entries use <changefreq> or <priority>. Google ignores both fields, so nothing to act on. Shopify generates these in its own sitemaps and they cannot be edited there.
[INFO ] 7 URL(s) across 1 sitemap file(s): 3 products, 2 pages, 1 collection-scoped product, 1 collection.

6 error(s), 8 warning(s), 2 info
```

`samples/sitemap-clean.xml` exits `0`. `samples/sitemap-index-clean.xml` shows the index shape Shopify serves at `/sitemap.xml`; a local file cannot follow its children, so point the tool at the live store to audit those.

Against a live store the report starts with one line per file it read, so you can see at a glance which child sitemap is the problem (numbers here are illustrative):

```
$ ssma check your-store.com --check-urls 20

Source: https://your-store.com/sitemap.xml
  sitemap.xml: sitemap index, 4 entries, 0.5 KiB, HTTP 200
  sitemap_products_1.xml: urlset, 812 entries, 401.2 KiB, HTTP 200
  sitemap_pages_1.xml: urlset, 14 entries, 2.6 KiB, HTTP 200
  ...
```

Pipe the URL list into a diff to see what changed between two days:

```bash
node bin/ssma.js list your-store.com --filter /products/ > products-today.txt
```

## Features

- **Follows the whole sitemap tree.** Give it a domain and it reads `/sitemap.xml`, then each child sitemap (products, collections, pages, blogs), reports per-file status, size and entry count, and totals the URLs by page type. Gzipped sitemaps are handled.
- **Structure problems that make a sitemap unreadable.** HTML served instead of XML (the usual symptom of a password page or a wrong URL), no `<urlset>` or `<sitemapindex>` root, a truncated file, unbalanced tags, a bare `&` in a URL, entries with no `<loc>`, an empty sitemap, an index nested inside an index.
- **The protocol limits.** More than 50,000 URLs in a file, more than 50 MiB uncompressed, URLs over 2,048 characters, more than 1,000 images on one URL.
- **URL problems.** Relative URLs, `http://` URLs, `*.myshopify.com` URLs, URLs on a different host from the sitemap, `#fragments`, query strings, whitespace around a `<loc>`, duplicates inside a file and across child sitemaps, and collection-scoped product URLs (`/collections/x/products/y`) listed next to the canonical `/products/y`.
- **Date problems.** `<lastmod>` values that are not valid W3C dates (`21/10/2026`, `2026-02-30`), dates in the future, and one identical `<lastmod>` stamped on every entry.
- **robots.txt cross-check.** Fetches the store's `robots.txt` and lists sitemap URLs that Googlebot is blocked from, with the rule that blocks them. Asking Google to index what it is told not to crawl is one of the most common sitemap mistakes after a theme change.
- **Optional live URL check.** `--check-urls 20` requests an evenly spread sample of 20 listed URLs (without following redirects) and reports 404/410, 5xx and redirecting URLs.
- **CI-friendly.** Exit `0` clean, `1` on errors (or warnings with `--strict`), `2` if the tool could not run. `--json` for machine-readable output.

## Installation

Needs Node 18 or newer. No `npm install` step: there are no dependencies.

```bash
git clone https://github.com/Ecom-Swift-LLC/shopify-sitemap-auditor.git
cd shopify-sitemap-auditor
node bin/ssma.js --help
```

Optionally `npm link` to get an `ssma` command on your path.

## Usage

```bash
# audit a live store (use the primary domain)
node bin/ssma.js check your-store.com

# also request 25 of the listed URLs and report dead or redirecting ones
node bin/ssma.js check your-store.com --check-urls 25

# a saved file, or stdin
node bin/ssma.js check ./sitemap_products_1.xml
curl -s https://your-store.com/sitemap_products_1.xml | node bin/ssma.js check - --host your-store.com

# read only the index, or raise the cap on child sitemaps (default 25)
node bin/ssma.js check your-store.com --no-follow
node bin/ssma.js check your-store.com --max-sitemaps 60

# CI: fail the build on warnings too
node bin/ssma.js check your-store.com --strict --json

# every URL, one per line
node bin/ssma.js list your-store.com --filter /collections/
```

`--check-urls` sends one request per sampled URL, four at a time. Keep the sample small on a large store; Shopify may answer a burst with `429`, which the report calls out instead of treating as a failure.

## What it does NOT do

- **It does not edit your sitemap.** Shopify generates `sitemap.xml` automatically and it cannot be edited. This tool finds the causes you can fix: what is published to the Online Store channel, what is hidden from search engines, the primary domain setting, a password page, a robots rule. Shopify's own `changefreq` and `priority` fields, for example, are reported as information because there is nothing to change.
- **It does not tell you what Google has indexed.** A clean sitemap is not a guarantee of indexing, and a listed URL is a suggestion, not an instruction. Use Search Console's Sitemaps and Page Indexing reports for what Google actually did.
- **It does not submit your sitemap.** Add `https://your-store.com/sitemap.xml` in Search Console yourself.
- **It does not crawl your site.** It checks the URLs the sitemap lists, plus the sample you ask for. It does not discover pages that are missing from the sitemap.
- **Its robots check is a simplified Googlebot match.** It covers user-agent groups, `*` and `$` patterns, longest-match and Allow-wins-ties. For a full robots.txt audit, use [shopify-robots-txt-auditor](https://github.com/Ecom-Swift-LLC/shopify-robots-txt-auditor).
- **It is not a full XML validator.** It reads the elements that matter for crawlers and flags the malformations that break them. It does not validate against the XSD, and it does not read video or news sitemap extensions beyond skipping them.
- **It does not judge `lastmod` accuracy.** It can tell a date is invalid or impossible. It cannot tell whether a valid date matches when the page really changed.

## FAQ

**Why is my sitemap fine but a product is missing from it?** The sitemap lists what is published to the Online Store sales channel. A draft or archived product, one not published to that channel, or one hidden from search engines will not appear. Check those first.

**Why does the report say my URLs are on the wrong host?** Usually a domain change. If the primary domain was switched, or the sitemap was fetched through a redirect, the URLs inside may still use the old host. Audit the domain shoppers and crawlers actually land on, and confirm the primary domain in Shopify's domain settings.

**Why are collection-scoped product URLs a problem?** Shopify serves a product at both `/products/handle` and `/collections/x/products/handle`, with the canonical tag pointing at the first. Listing the second in a sitemap sends crawlers a URL your own page says is not the preferred one.

**What does a 429 in `--check-urls` mean?** The store asked the tool to slow down. Those URLs were not verified; rerun with a smaller sample.

## Run it against your own store

A sitemap is one of several things that decide whether a store gets found. If this turned up errors, the [free store audit](https://audit.ecomswiftllc.com/?utm_source=github&utm_medium=repo&utm_campaign=shopify-sitemap-auditor) looks at the rest in the same pass: SEO, page speed, conversion and how AI shopping assistants read your catalogue.

## Related Shopify tools

Also from Ecom Swift LLC:

- [shopify-robots-txt-auditor](https://github.com/Ecom-Swift-LLC/shopify-robots-txt-auditor) audits the robots.txt this tool cross-checks against.
- [shopify-redirect-manager](https://github.com/Ecom-Swift-LLC/shopify-redirect-manager) manages URL redirects in bulk, for the redirecting URLs `--check-urls` finds.
- [shopify-structured-data-validator](https://github.com/Ecom-Swift-LLC/shopify-structured-data-validator) checks product-page JSON-LD, which decides whether you get price and star ratings in results.
- [shopify-ai-shopping-readiness](https://github.com/Ecom-Swift-LLC/shopify-ai-shopping-readiness) checks how AI shopping surfaces read your store.
- [shopify-theme-performance-auditor](https://github.com/Ecom-Swift-LLC/shopify-theme-performance-auditor) audits theme assets and page weight.
- [shopify-seo-checklist](https://github.com/EcomswiftLLC/shopify-seo-checklist) is the written SEO checklist for what a validator cannot see.
- [shopify-product-feed-validator](https://github.com/EcomswiftLLC/shopify-product-feed-validator) validates product feeds for Google Merchant Center.

## Contributing

Issues and PRs welcome, especially a real sitemap this tool got wrong (a false positive or a miss), with the file attached after removing anything private. Run the suite with `npm test` (plain `node --test`, no test framework dependency; the live-store tests run against a local HTTP server) and add a case for any new rule.

## Roadmap

- `--baseline` to snapshot the URL list and report only what was added or removed since the last run
- A GitHub Action wrapper, matching the one in `shopify-theme-deploy-action`
- Per-market subfolder and domain checks for stores using Shopify Markets
- Image sitemap checks against the image URLs themselves

## License

MIT, Ecom Swift LLC. See [LICENSE](LICENSE).

## Need help?

We build Shopify themes, storefronts and automation for a living. If a check here turned up something you would rather have fixed than DIY, or you want a second pair of eyes on your store generally:

- **Free store audit** (SEO + speed + CRO + AI visibility, one report): [audit.ecomswiftllc.com](https://audit.ecomswiftllc.com/?utm_source=github&utm_medium=repo&utm_campaign=shopify-sitemap-auditor)
- **More free tools**: [ecomswiftllc.com/free-tools](https://www.ecomswiftllc.com/free-tools)
- **Shopify Partner Directory**: [shopify.com/partners/directory/partner/waowy](https://www.shopify.com/partners/directory/partner/waowy)
- **Website**: [ecomswiftllc.com](https://www.ecomswiftllc.com)

---

Built because the same few sitemap problems keep turning up on store audits: a domain change that left the old host in the URLs, products that quietly dropped out after a channel change, and a robots rule that blocks the pages the sitemap is begging Google to index. Free and complete, no catch.
