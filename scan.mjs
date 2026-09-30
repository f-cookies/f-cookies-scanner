#!/usr/bin/env node
// Loads pages in a real Chromium, without any click or consent, and reports
// what the browser ends up holding: cookies, contacted hosts, storage keys.
// Cookie values are never read or sent.

import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';

const ENDPOINT = process.env.FC_INGEST_URL || 'https://f-cookies.org/ingest.php';
const KEY = process.env.FC_INGEST_KEY || '';
const ROBOTS_AGENT = 'F-Cookies/0.3 (+https://f-cookies.org/)';
const SETTLE_MS = 6000;

function parseArgs(argv) {
  const opts = { urls: [], list: '', queue: 0, offset: 0, limit: 1000, concurrency: 4, out: '', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') opts.list = argv[++i];
    else if (a === '--queue') opts.queue = Number(argv[++i]);
    else if (a === '--offset') opts.offset = Number(argv[++i]);
    else if (a === '--limit') opts.limit = Number(argv[++i]);
    else if (a === '--concurrency') opts.concurrency = Number(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--') { opts.urls.push(...argv.slice(i + 1)); break; }
    else opts.urls.push(a);
  }
  return opts;
}

async function loadTargets(opts) {
  let urls = opts.urls;
  if (opts.list) {
    const text = await readFile(opts.list, 'utf8');
    urls = text.split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  } else if (opts.queue > 0) {
    const res = await fetch(`${ENDPOINT}?limit=${opts.queue}`, { headers: { 'x-fc-key': KEY }, signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`queue request failed: HTTP ${res.status}`);
    urls = (await res.json()).urls || [];
  }
  return urls.slice(opts.offset, opts.offset + opts.limit).map((u) => (/^https?:\/\//i.test(u) ? u : `https://${u}/`));
}

// Same rule as the F-Cookies server: the most specific matching Allow/Disallow
// of the "f-cookies" group, else of the "*" group, decides.
async function robotsAllowed(url) {
  const { origin, pathname } = new URL(url);
  let body = '';
  try {
    const res = await fetch(`${origin}/robots.txt`, { headers: { 'user-agent': ROBOTS_AGENT }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return true;
    body = await res.text();
  } catch {
    return true;
  }
  const groups = {};
  let agents = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const sep = line.indexOf(':');
    if (sep < 0) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (field === 'user-agent') {
      agents = [value.toLowerCase()];
      for (const agent of agents) groups[agent] ??= [];
    } else if ((field === 'allow' || field === 'disallow') && value) {
      for (const agent of agents) groups[agent].push([field, value]);
    }
  }
  const rules = groups['f-cookies'] || groups['*'];
  if (!rules) return true;
  let best = ['allow', -1];
  for (const [type, rule] of rules) if (pathname.startsWith(rule) && rule.length > best[1]) best = [type, rule.length];
  return best[0] === 'allow';
}

async function visit(browser, url) {
  const context = await browser.newContext({ locale: process.env.FC_LOCALE || 'en-US', viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const hosts = {};
  let requests = 0;
  page.on('request', (request) => {
    try {
      const parsed = new URL(request.url());
      if (!/^https?:$/.test(parsed.protocol)) return;
      hosts[parsed.hostname] = (hosts[parsed.hostname] || 0) + 1;
      requests++;
    } catch {}
  });
  const result = { url, finalUrl: url, status: null, cookies: [], hosts, requests: 0, storage: { local: 0, session: 0 } };
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    result.status = response ? response.status() : null;
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
    result.finalUrl = page.url();
    if (result.status !== null && result.status >= 400) throw new Error(`HTTP ${result.status}`);
    result.cookies = (await context.cookies()).map((c) => ({ name: c.name, domain: c.domain, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite }));
    result.storage = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })).catch(() => ({ local: 0, session: 0 }));
  } catch (error) {
    result.error = String(error.message || error).split('\n')[0].slice(0, 200);
  }
  result.requests = requests;
  await context.close().catch(() => {});
  return result;
}

// Where the check runs from, shown in each report (FC_ORIGIN names a run from a PC).
const origin = process.env.FC_ORIGIN || (process.env.GITHUB_ACTIONS ? 'GitHub Actions' : 'local run');
async function region() {
  try {
    const text = await (await fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(8000) })).text();
    const loc = /^loc=(\w+)/m.exec(text);
    return `${origin}, ${loc ? loc[1] : '??'}`;
  } catch {
    return origin;
  }
}

async function send(result) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fc-key': KEY },
    body: JSON.stringify(result),
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { ok: false, error: `HTTP ${res.status}` }; }
}

const opts = parseArgs(process.argv.slice(2));
const targets = await loadTargets(opts);
if (!opts.dryRun && !KEY) throw new Error('FC_INGEST_KEY is not set (use --dry-run to scan without sending).');
const where = await region();
const launch = process.env.FC_BROWSER_CHANNEL ? { channel: process.env.FC_BROWSER_CHANNEL } : {};
const browser = await chromium.launch(launch);
const results = [];
const tally = { sent: 0, robots: 0, browserErrors: 0, rejected: 0 };
let next = 0;

async function worker() {
  while (next < targets.length) {
    const index = next++;
    const url = targets[index];
    const label = `[${index + 1}/${targets.length}] ${url}`;
    try {
      if (!(await robotsAllowed(url))) { tally.robots++; console.log(`${label} skipped: robots.txt`); continue; }
      let result = await visit(browser, url);
      const host = new URL(url).hostname;
      if (result.error && !host.startsWith('www.') && /ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_SSL|ERR_CERT/.test(result.error)) {
        const retry = await visit(browser, url.replace('://', '://www.'));
        if (!retry.error) result = retry;
      }
      result.region = where;
      if (result.error) tally.browserErrors++;
      results.push(result);
      if (opts.dryRun) { console.log(`${label} ${result.error || `${result.cookies.length} cookies, ${Object.keys(result.hosts).length} hosts`}`); continue; }
      const answer = await send(result);
      if (answer.ok) { tally.sent++; console.log(`${label} score ${answer.score ?? answer.privacy}/5${answer.browser ? '' : ' (browser check failed: ' + (result.error || 'ended on another site') + ')'}`); }
      else { tally.rejected++; console.log(`${label} not stored: ${answer.error}`); }
    } catch (error) {
      tally.rejected++;
      console.log(`${label} failed: ${String(error.message || error).split('\n')[0]}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
await browser.close();
if (opts.out) await writeFile(opts.out, JSON.stringify(results, null, 1));
console.log(`done: ${targets.length} targets, ${tally.sent} stored, ${tally.robots} skipped by robots.txt, ${tally.browserErrors} browser errors, ${tally.rejected} not stored`);
