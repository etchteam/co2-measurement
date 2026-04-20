/**
 * @file Measures the CO₂ emissions of one or more web pages using the
 * Sustainable Web Design Model v4. Drives a real Chromium via Playwright,
 * counts encoded response bytes over CDP, looks up whether each host is on a
 * green-powered network, and writes (1) a JSON summary and (2) one SVG grade
 * badge per URL.
 *
 * Usage:
 *   node measure-co2.js [--out <file>] [--badges-dir <dir>] <url> [<url> ...]
 */

import { chromium } from 'playwright';
import { co2 as Co2, hosting } from '@tgwf/co2';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE =
  'usage: node measure-co2.js [--out <file>] [--badges-dir <dir>] <url> [<url> ...]';

/** Max wait for the Green Web Foundation host lookup before falling back to `green: false`. */
const HOSTING_TIMEOUT_MS = 10000;
/** Navigation timeout — SWDM is a per-visit estimate, so we need a full page load. */
const PAGE_TIMEOUT_MS = 60000;
/** Extra wait after `networkidle` to catch late requests (analytics, deferred fetches). */
const SETTLE_MS = 1500;

/**
 * Colour swatch per Digital Carbon Rating grade. Grade letters come from the
 * `@tgwf/co2` library's v4 rating scale; this map just picks a display colour
 * for each band.
 * @type {Record<string, string>}
 */
export const GRADE_COLORS = {
  'A+': '#4c9a2a',
  A: '#7ab317',
  B: '#b4d33b',
  C: '#f3c922',
  D: '#f18b27',
  E: '#dd4b1a',
  F: '#b32d0c',
};

/**
 * Arithmetic mean of `perVisitGrams` across successful results.
 * Returns `null` if none succeeded.
 * @param {Array<{ perVisitGrams?: number, error?: string }>} results
 * @returns {number | null}
 */
export function averagePerVisitGrams(results) {
  const ok = results.filter(
    (r) => !r.error && typeof r.perVisitGrams === 'number',
  );
  if (!ok.length) {
    return null;
  }
  const total = ok.reduce((sum, r) => sum + r.perVisitGrams, 0);
  return +(total / ok.length).toFixed(4);
}

/**
 * Splits a positional target arg into `{ name, url }`.
 * Supports `archetype=url` (e.g. `home=https://etch.co/`) so consumers can
 * key the JSON by page type. Bare URLs get `name: null`.
 *
 * Name must be a lowercase slug (`[a-z][a-z0-9-]*`) and URL must start with
 * `http://` or `https://`, otherwise the arg is treated as an anonymous URL.
 *
 * @param {string} arg
 * @returns {{ name: string | null, url: string }}
 */
export function parseTarget(arg) {
  const eq = arg.indexOf('=');
  if (eq > 0) {
    const name = arg.slice(0, eq);
    const url = arg.slice(eq + 1);
    if (/^[a-z][a-z0-9-]*$/.test(name) && /^https?:\/\//.test(url)) {
      return { name, url };
    }
  }
  return { name: null, url: arg };
}

/**
 * Renders a self-contained SVG badge — no external fonts or stylesheets, so
 * the badge itself has near-zero carbon cost and can be inlined anywhere.
 *
 * Width is computed from the value string length so longer grade/gram
 * combinations don't clip.
 *
 * @param {{ grams: number, rating: string, totalKB: number, green: boolean }} params
 * @returns {string}
 */
export function badgeSvg({ grams, rating, totalKB, green }) {
  const color = GRADE_COLORS[rating] ?? GRADE_COLORS.F;
  const label = 'CO₂/visit';
  const value = `${grams.toFixed(3)}g · ${rating}${green ? ' · green host' : ''}`;
  const labelW = 80;
  const valueW = Math.max(110, value.length * 6.2 + 16);
  const total = labelW + valueW;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="20" role="img" aria-label="${label}: ${value}">
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#fff" stop-opacity=".2"/>
    <stop offset="1" stop-opacity=".2"/>
  </linearGradient>
  <mask id="m"><rect width="${total}" height="20" rx="3" fill="#fff"/></mask>
  <g mask="url(#m)">
    <rect width="${labelW}" height="20" fill="#555"/>
    <rect x="${labelW}" width="${valueW}" height="20" fill="${color}"/>
    <rect width="${total}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="14">${label}</text>
    <text x="${labelW + valueW / 2}" y="14">${value}</text>
  </g>
  <title>Total transfer: ${totalKB} KB. Model: SWDM v4 (CO2.js).</title>
</svg>`;
}

/**
 * Derives a filesystem-safe badge filename from a result URL.
 * @param {{ url: string }} result
 * @returns {string}
 */
export function badgeFilename({ url }) {
  const u = new URL(url);
  const slug = (u.hostname + u.pathname)
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return `${slug || 'index'}.svg`;
}

/**
 * Minimal flag parser — intentionally no `commander`/`yargs` dependency.
 * @param {string[]} argv
 * @returns {{ outPath: string | null, badgesDir: string | null, targets: Array<{ name: string | null, url: string }> }}
 */
function parseArgs(argv) {
  let outPath = null;
  let badgesDir = null;
  const targets = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === '--out') {
      outPath = argv[++i];
    } else if (a === '--badges-dir') {
      badgesDir = argv[++i];
    } else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else {
      targets.push(parseTarget(a));
    }
  }

  return { outPath, badgesDir, targets };
}

/**
 * Checks whether a host is on a green-powered network via
 * `@tgwf/co2`'s `hosting()` (Green Web Foundation API).
 *
 * Wrapped in a timeout so a GWF outage can't hang the script. A failed lookup
 * degrades to `false` rather than throwing.
 *
 * @param {string} hostname
 * @returns {Promise<boolean>}
 */
async function isGreen(hostname) {
  let timer;
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('green-host lookup timed out')),
        HOSTING_TIMEOUT_MS,
      );
    });
    return !!(await Promise.race([hosting(hostname), timeout]));
  } catch (e) {
    process.stderr.write(
      `warn: green-host lookup failed for ${hostname}: ${e.message}\n`,
    );
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Loads a URL and reports the bytes transferred, grouped by content-type and
 * domain, with an SWDM v4 per-visit grams estimate and rating grade.
 *
 * Byte accounting uses CDP's `encodedDataLength` from `Network.loadingFinished`,
 * which is the real wire size after compression — the input SWDM expects.
 *
 * @param {import('playwright').Browser} browser
 * @param {string} url
 * @param {boolean} green - Pre-resolved green-hosting flag for the host.
 */
async function measure(browser, url, green) {
  const ctx = await browser.newContext();

  try {
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');

    let totalBytes = 0;
    const byType = {};
    const byDomain = {};
    const byRequest = new Map();

    cdp.on('Network.responseReceived', ({ requestId, response }) => {
      const ct = (response.mimeType || 'other').split(';')[0];
      let host = 'unknown';
      try {
        host = new URL(response.url).hostname;
      } catch (e) {
        process.stderr.write(
          `warn: could not parse response URL ${response.url}: ${e.message}\n`,
        );
      }
      byRequest.set(requestId, { ct, host });
    });

    cdp.on('Network.loadingFinished', (evt) => {
      const meta = byRequest.get(evt.requestId);
      if (!meta) return;
      const wire = evt.encodedDataLength || 0;
      if (!wire) return;
      totalBytes += wire;
      byType[meta.ct] = (byType[meta.ct] || 0) + wire;
      byDomain[meta.host] = (byDomain[meta.host] || 0) + wire;
    });

    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: PAGE_TIMEOUT_MS,
    });
    await page.waitForTimeout(SETTLE_MS);

    const host = new URL(url).hostname;
    const swd = new Co2({ model: 'swd', version: 4, rating: true });
    const { total: gramsOfCO2, rating } = swd.perVisit(totalBytes, green);

    return {
      url,
      host,
      green,
      totalBytes,
      totalKB: +(totalBytes / 1024).toFixed(1),
      perVisitGrams: +gramsOfCO2.toFixed(4),
      grade: rating,
      byType: Object.fromEntries(
        Object.entries(byType)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => [k, +(v / 1024).toFixed(1) + ' KB']),
      ),
      byDomain: Object.fromEntries(
        Object.entries(byDomain)
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => [k, +(v / 1024).toFixed(1) + ' KB']),
      ),
    };
  } finally {
    await ctx
      .close()
      .catch((e) =>
        process.stderr.write(`warn: context close failed: ${e.message}\n`),
      );
  }
}

/**
 * CLI entrypoint. Writes badges per URL (if `--badges-dir` given), writes a
 * combined JSON baseline (if `--out` given and nothing errored), and exits
 * with `0` (all ok), `1` (all failed), or `2` (partial).
 *
 * The JSON write is skipped on any failure so a broken run can't clobber the
 * last-known-good file.
 */
async function main() {
  const { outPath, badgesDir, targets } = parseArgs(process.argv.slice(2));
  if (targets.length === 0) {
    console.error(USAGE);
    process.exit(1);
  }

  // Resolve green-hosting once per unique hostname — it's a property of the
  // host, not the page.
  const hosts = [...new Set(targets.map((t) => new URL(t.url).hostname))];
  const greenByHost = Object.fromEntries(
    await Promise.all(hosts.map(async (h) => [h, await isGreen(h)])),
  );

  const browser = await chromium.launch();
  const results = [];

  try {
    for (const target of targets) {
      process.stderr.write(`measuring ${target.url}...\n`);
      try {
        const host = new URL(target.url).hostname;
        const result = await measure(browser, target.url, greenByHost[host]);
        if (target.name) {
          result.archetype = target.name;
        }
        results.push(result);

        if (badgesDir) {
          const svg = badgeSvg({
            grams: result.perVisitGrams,
            rating: result.grade,
            totalKB: result.totalKB,
            green: result.green,
          });
          const out = join(badgesDir, badgeFilename(result));
          await mkdir(dirname(out), { recursive: true });
          await writeFile(out, svg, 'utf8');
          process.stderr.write(`  badge → ${out}\n`);
        }
      } catch (e) {
        process.stderr.write(
          `measurement failed for ${target.url}: ${e.stack || e}\n`,
        );
        results.push({
          url: target.url,
          archetype: target.name ?? undefined,
          error: e.message,
          errorType: e.name,
        });
      }
    }
  } finally {
    await browser.close();
  }

  const failed = results.filter((r) => r.error);
  const allFailed = failed.length === results.length;

  if (outPath && !failed.length) {
    const archetypes = {};
    for (const r of results) {
      if (r.archetype) {
        archetypes[r.archetype] = {
          url: r.url,
          perVisitGrams: r.perVisitGrams,
          grade: r.grade,
          green: r.green,
          totalKB: r.totalKB,
        };
      }
    }
    const payload = {
      model: 'SWDM v4 (CO2.js)',
      averagePerVisitGrams: averagePerVisitGrams(results),
      archetypes,
      results,
    };
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    process.stderr.write(`wrote → ${outPath}\n`);
  } else if (outPath && failed.length) {
    process.stderr.write(
      `skipping output write: ${failed.length}/${results.length} URL(s) failed\n`,
    );
  }

  console.log(JSON.stringify(results, null, 2));

  if (allFailed) {
    process.exit(1);
  }
  if (failed.length) {
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
