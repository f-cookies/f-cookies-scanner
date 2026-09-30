# f-cookies-scanner

The browser check behind [f-cookies.org](https://f-cookies.org/).

The F-Cookies server reads a page the cheap way: HTTP headers, HTML, CSS and
scripts as text. That misses everything JavaScript does once it runs. This
repository fills the gap: a GitHub Actions job loads each page in a real
Chromium, **without clicking anything and without giving consent**, waits a
few seconds, and reports what the browser ends up holding.

## What is collected

For each page:

- the cookies present after load: name, domain, expiry, flags. **Never the value.**
- the hosts the page contacted and how many requests went to each
- how many `localStorage` and `sessionStorage` keys were written
- the final URL and HTTP status

The result is sent to `f-cookies.org/ingest.php`, which merges it into the
public report for that site. Nothing about visitors is involved: the only
"user" is the scanner itself.

## Limits

- The job runs on GitHub's machines, mostly in the United States. Sites that
  show a consent banner only to European visitors may behave differently.
- It sees the page before any consent. What happens after "Accept" is not tested.
- Some sites block data-centre addresses or automated browsers. Those are
  reported as a failed browser check, never as clean.
- `robots.txt` is honoured: a site that disallows `F-Cookies` (or everyone) is skipped.

## Run it yourself

```sh
npm ci
npx playwright install chromium
node scan.mjs --dry-run --out results.json https://example.com/
```

`--dry-run` scans without sending anything. Other options: `--list FILE`,
`--offset N`, `--limit N`, `--concurrency N`. To use an installed browser
instead of downloading one, set `FC_BROWSER_CHANNEL=chrome` or `msedge`.

## Lists

`sites/fr-top.txt` holds the most popular `.fr` domains of the
[Tranco list](https://tranco-list.eu/) (Le Pochat et al., NDSS 2019).

## Licence

MIT.
