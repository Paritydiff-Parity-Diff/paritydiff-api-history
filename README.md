# ParityDiff API history

ParityDiff (Parity Diff) tracks public API specification changes. This dependency-free
Node.js 24 CLI and GitHub Action export captured revision metadata with dated
provenance and links to the evidence on [paritydiff.com](https://paritydiff.com/monitoring).

This tool exports public history. It does not scan repository code, compare uploaded
OpenAPI documents, generate patches, or establish application compatibility.

## Run locally

```sh
node --test export.test.mjs
node export.mjs --output monitoring.json
node export.mjs --vendors openai,sentry --release-pages 2 --output data/monitoring.json
```

Omit `--vendors` to include all captured public feeds. `--release-pages` accepts 1 to 4
and defaults to 1, with up to 50 records per page. A baseline can have zero releases.
Output paths must be relative JSON paths inside the current working directory.
An existing output is replaced only after complete validation. After failure, an
older file may still exist; do not treat it as a fresh snapshot.

## Use in GitHub Actions

Pin the action to a reviewed immutable commit. The example below uses the initial
reviewed code commit of this repository. The caller does not need to check out its
own repository for this export.

```yaml
permissions:
  contents: read
steps:
  - name: Export captured public API history
    id: monitoring
    uses: Paritydiff-Parity-Diff/paritydiff-api-history@b620fc734741dcf39939f851e3bef8ced636443f
    with:
      vendors: openai,sentry
      release-pages: '1'
      output: data/monitoring.json
```

Inputs: `vendors` (optional comma-separated public slugs), `release-pages` (1 to 4),
and `output` (relative JSON path). Outputs: `json-path`, `api-count`,
`recorded-release-count`, and `fetched-at`. The managed runtime is Node.js 24.
No token, dependency installation, repository scan, or private input is required.
For a checked-out local copy, `uses: ./` invokes its root `action.yml`.

Require a successful step before consuming output. The action does not write to
GitHub, upload artifacts, open pull requests, or merge code. The included test
workflow is manual only and runs the offline tests; no workflow runs on push.

## Data boundary and failure behavior

The exporter requests only these endpoints on `https://api.paritydiff.com`:

- `/v1/public/apis?state=captured&sort=recent&limit=50`, including cursor pages.
- `/v1/public/apis/<public-vendor>/releases?limit=50`, including cursor pages.

It never fetches raw specifications, change fragments, customer data, upstream
vendor URLs, or authenticated endpoints. Only explicitly selected metadata
fields are written. URLs found inside API responses are not followed. Redirects
are refused, HTTPS and the exact official origin are required, and requests omit
credentials. No scheduling or vendor polling is configured.

Collection is bounded to four catalog pages, at most 50 HTTP requests, a 15-second
deadline per request, and a 2 MiB decoded response limit per page. A truncated
catalog, repeated cursor, bad response, unsafe URL, or exceeded request budget
fails the run. Select fewer APIs or release pages if the budget is insufficient.
The tool does not retry or bypass public API rate limits.

`fetchedAt`, `collectionStartedAt`, and `sources[].fetchedAt` preserve collection
time and public API provenance. Snapshots combine individual HTTP observations;
they are not transactional or a claim of current upstream compatibility. API
revision counts describe recorded spec transitions, not vendor release frequency,
customer adoption, repository impact, or successful migration coverage.

## Public evidence feeds

These are captured specification feeds, not customer endorsements. Their linked
pages show dated evidence. The exporter includes all captured feeds by default;
this discovery list does not claim that every feed has a recent finding.

| API          | Captured history                                                                    |
| ------------ | ----------------------------------------------------------------------------------- |
| Asana        | [Asana API breaking changes](https://paritydiff.com/monitoring/asana)               |
| Box          | [Box API breaking changes](https://paritydiff.com/monitoring/box)                   |
| Cal.com      | [Cal.com API breaking changes](https://paritydiff.com/monitoring/cal-com)           |
| Cohere       | [Cohere API breaking changes](https://paritydiff.com/monitoring/cohere)             |
| DigitalOcean | [DigitalOcean API breaking changes](https://paritydiff.com/monitoring/digitalocean) |
| Mistral      | [Mistral API breaking changes](https://paritydiff.com/monitoring/mistral)           |
| Netlify      | [Netlify API breaking changes](https://paritydiff.com/monitoring/netlify)           |
| OpenAI       | [OpenAI API breaking changes](https://paritydiff.com/monitoring/openai)             |
| PagerDuty    | [PagerDuty API breaking changes](https://paritydiff.com/monitoring/pagerduty)       |
| Sentry       | [Sentry API breaking changes](https://paritydiff.com/monitoring/sentry)             |
| Square       | [Square API breaking changes](https://paritydiff.com/monitoring/square)             |

## License and security

The exporter source is licensed under Apache License 2.0; see [LICENSE.txt](LICENSE.txt).
The code license does not relicense upstream specifications or API data. This tool
exports metadata, not raw contracts. Preserve source links and collection timestamps
when sharing an export. See [SECURITY.md](SECURITY.md) for the data boundary and
private security reporting contact.
