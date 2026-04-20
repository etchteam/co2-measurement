# co2-measurement

This is the CO₂-measurement tooling we use on [etch.co](https://etch.co), shared here for reference. See the [write-up](https://etch.co/blog/how-to-measure-co2-impact-of-a-web-page/) for background.

It measures CO₂ per visit using [Playwright](https://playwright.dev) + the Chrome DevTools Protocol + the [Sustainable Web Design Model v4](https://sustainablewebdesign.org/estimating-digital-emissions/) via [`@tgwf/co2`](https://github.com/thegreenwebfoundation/co2.js), and writes:

- A JSON file with the full breakdown per URL (transferred bytes by content-type and domain, grams per visit, grade).
- One SVG badge per URL, ready to embed in a site footer or README.

## Example badge

![CO₂ per visit](badges/etch-co.svg)

## Install

```sh
npm install
npx playwright install --with-deps chromium
```

Requires Node 22+.

## Usage

```sh
node measure-co2.js [--out <file>] [--badges-dir <dir>] <target> [<target> ...]
```

Each `<target>` is either a bare URL or `archetype=url` (e.g. `home=https://etch.co/`). Naming a target with an archetype adds it to an `archetypes` map in the JSON output, so consumers can look up the number for a specific page type without scanning the whole `results` array.

Measure one URL, write everything to disk:

```sh
node measure-co2.js --out co2.json --badges-dir badges https://etch.co/
```

Measure a representative page per archetype:

```sh
node measure-co2.js --out co2.json --badges-dir badges \
  home=https://etch.co/ \
  blog-index=https://etch.co/blog/ \
  post=https://etch.co/blog/a-post/ \
  team=https://etch.co/team/
```

Skip `--out` and/or `--badges-dir` to just print the JSON to stdout.

## Output

`co2.json`:

```json
{
  "model": "SWDM v4 (CO2.js)",
  "averagePerVisitGrams": 0.0399,
  "archetypes": {
    "home": {
      "url": "https://etch.co/",
      "perVisitGrams": 0.0399,
      "grade": "A+",
      "green": true,
      "totalKB": 322.1
    }
  },
  "results": [
    {
      "url": "https://etch.co/",
      "host": "etch.co",
      "green": true,
      "totalBytes": 329858,
      "totalKB": 322.1,
      "perVisitGrams": 0.0399,
      "grade": "A+",
      "archetype": "home",
      "byType": { "font/woff2": "203.4 KB", "...": "..." },
      "byDomain": { "etch.co": "319.1 KB", "...": "..." }
    }
  ]
}
```

- `averagePerVisitGrams` is the arithmetic mean of `perVisitGrams` across all successful results — useful when you want a single site-wide number.
- `archetypes` keys every named target (`home=`, `post=`, etc.) by its name, for per-page-type lookups. The [etch.co](https://etch.co) footer uses this to show the number for the archetype matching the current URL.

Badges are written to `<badges-dir>/<host-and-path-slug>.svg`, e.g. `badges/etch-co.svg`, `badges/etch-co-blog.svg`.

## Exit codes

| Code | Meaning                                          |
|------|--------------------------------------------------|
| `0`  | All measurements succeeded                       |
| `1`  | Every measurement failed                         |
| `2`  | At least one (but not all) measurements failed   |

`co2.json` is **not** written on failure, so a broken run can't clobber a prior good baseline.

## Ratings

Per-visit grams are mapped onto the [Digital Carbon Rating](https://sustainablewebdesign.org/digital-carbon-ratings/) scale used by Website Carbon:

| Grade | Max g/visit |
|-------|-------------|
| A+    | 0.095       |
| A     | 0.185       |
| B     | 0.34        |
| C     | 0.49        |
| D     | 0.65        |
| E     | 0.85        |
| F     | ∞           |

## Green hosting

Each hostname is checked against the [Green Web Foundation](https://www.thegreenwebfoundation.org/) registry. The script only looks up each unique host once per run.

If the GWF API is slow or unreachable the lookup falls back to `green: false` after 10s and measurement continues.

## GitHub Action

`.github/workflows/measure.yaml` runs the measurement on the 1st of each month (and on demand via `workflow_dispatch`) and opens a pull request with the refreshed `co2.json` + badges. Branch protection stays intact — nothing is pushed directly.

## Tests

```sh
npm test
```

Unit tests cover the rating thresholds, badge rendering, and filename slugging — the pure pieces where silent wrong output would be undetectable by eye.

## License

MIT — see [LICENSE](LICENSE).
