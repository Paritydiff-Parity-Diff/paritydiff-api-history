# Security and data boundaries

This tool reads only public ParityDiff catalog and release metadata. It does not
request a GitHub token, repository contents, private contracts, or credentials.
Inputs are bounded vendor slugs, page counts, and a relative JSON output path.
The exporter rejects redirects and foreign origins. It does not follow upstream
URLs returned by the API or execute response content.

Run with `contents: read` and without secrets. A manual invocation is sufficient;
no scheduled trigger is included. Require a successful action step before using
its output and inspect the `fetched-at` output before relying on the snapshot.
Older output can remain on disk after failure and must not be treated as fresh.

Report security concerns privately to soumik@paritydiff.com. Avoid including real
customer code or credentials. No response-time commitment or bounty is offered.
