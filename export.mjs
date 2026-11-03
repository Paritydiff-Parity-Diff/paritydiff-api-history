import { mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export const API_ORIGIN = 'https://api.paritydiff.com';
export const SITE_ORIGIN = 'https://paritydiff.com';
const slug = /^[a-z0-9][a-z0-9-]{0,63}$/;
const reserved = /^(pd-e2e-|paritydiff-(acceptance|private|test)|fixture-)/;
const hash = /^[a-f0-9]{64}$/;
const identifier = /^[a-zA-Z0-9_-]{1,160}$/;
const classes = ['breaking', 'non_breaking', 'ambiguous', 'deprecation', 'pending'];

function requireValue(condition, message) {
  if (!condition) throw Error(message);
}

export function publicVendor(value) {
  requireValue(
    typeof value === 'string' && slug.test(value) && !reserved.test(value),
    'Invalid public vendor slug',
  );
  return value;
}

export function officialPublicUrl(value) {
  const url = new URL(value);
  requireValue(
    url.origin === API_ORIGIN && !url.username && !url.password && !url.hash,
    'Only the official HTTPS public metadata API is allowed',
  );
  const match = /^\/v1\/public\/apis(?:\/([a-z0-9-]+)\/releases)?$/.exec(url.pathname);
  requireValue(match, 'Only catalog and release metadata endpoints are allowed');
  if (match[1]) publicVendor(match[1]);
  const allowed = match[1] ? ['limit', 'cursor'] : ['limit', 'cursor', 'state', 'sort'];
  for (const [key, value] of url.searchParams) {
    requireValue(
      allowed.includes(key) && url.searchParams.getAll(key).length === 1,
      'Invalid metadata query',
    );
    if (key === 'limit')
      requireValue(/^[1-9][0-9]?$/.test(value) && Number(value) <= 50, 'Invalid page limit');
    if (key === 'cursor')
      requireValue(/^[a-zA-Z0-9_-]{1,2000}$/.test(value), 'Invalid pagination cursor');
    if (key === 'state')
      requireValue(value === 'captured', 'Only captured API metadata is exported');
    if (key === 'sort') requireValue(value === 'recent', 'Invalid metadata sort');
  }
  return url;
}

function count(value) {
  requireValue(Number.isSafeInteger(value) && value >= 0, 'Invalid metadata count');
  return value;
}

function text(value, maximum = 300) {
  requireValue(
    typeof value === 'string' &&
      value.length > 0 &&
      value.length <= maximum &&
      Array.from(value).every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ),
    'Invalid metadata text',
  );
  return value;
}

function nullableText(value) {
  return value === null ? null : text(value);
}

function date(value) {
  requireValue(
    typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T/.test(value) &&
      Number.isFinite(Date.parse(value)),
    'Invalid metadata timestamp',
  );
  return new Date(value).toISOString();
}

function digest(value) {
  requireValue(typeof value === 'string' && hash.test(value), 'Invalid specification digest');
  return value;
}

function release(row, vendor) {
  requireValue(
    row && typeof row === 'object' && identifier.test(row.id),
    'Invalid release metadata',
  );
  requireValue(
    ['pending', 'partial', 'classified', 'no_changes'].includes(row.status),
    'Invalid release status',
  );
  requireValue(row.counts && typeof row.counts === 'object', 'Missing classification counts');
  return {
    id: row.id,
    detectedAt: date(row.detectedAt),
    fromHash: row.fromHash === null ? null : digest(row.fromHash),
    toHash: digest(row.toHash),
    fromVersion: nullableText(row.fromVersion),
    toVersion: nullableText(row.toVersion),
    detectionMethod: text(row.detectionMethod),
    detectorVersion: text(row.detectorVersion),
    expectedChanges: count(row.expectedChanges),
    recordedChanges: count(row.recordedChanges),
    counts: Object.fromEntries(classes.map((key) => [key, count(row.counts[key])])),
    status: row.status,
    link: `${SITE_ORIGIN}/monitoring/${vendor}/releases/${row.id}`,
  };
}

async function readJson(response) {
  requireValue(response.ok && response.status === 200, 'Public metadata request failed');
  requireValue(
    /^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''),
    'Expected public JSON metadata',
  );
  requireValue(response.body, 'Missing metadata response body');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      requireValue(size <= 2 * 1024 * 1024, 'Metadata response exceeded 2 MiB');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Error('Invalid metadata JSON');
  }
}

export async function exportMetadata(
  { vendors = [], releasePages = 1, catalogPages = 4 } = {},
  fetcher = fetch,
  now = () => new Date(),
) {
  requireValue(
    Number.isSafeInteger(releasePages) && releasePages >= 1 && releasePages <= 4,
    'Release pages must be between 1 and 4',
  );
  requireValue(
    Number.isSafeInteger(catalogPages) && catalogPages >= 1 && catalogPages <= 4,
    'Catalog pages must be between 1 and 4',
  );
  const selected = new Set(vendors.map(publicVendor));
  requireValue(
    selected.size === vendors.length && selected.size <= 25,
    'Select at most 25 unique vendors',
  );
  const sources = [];
  const started = now().toISOString();
  let requests = 0;
  async function pages(path, maximum, completeRequired) {
    const rows = [];
    const seen = new Set();
    let cursor = null;
    let pageCount = 0;
    do {
      const url = officialPublicUrl(new URL(path, API_ORIGIN));
      if (cursor) url.searchParams.set('cursor', cursor);
      requireValue(
        ++requests <= 50,
        'Export exceeded the 50-request budget; select fewer vendors or release pages',
      );
      const response = await fetcher(url.href, {
        headers: { accept: 'application/json' },
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(15000),
      });
      if (response.url)
        requireValue(
          officialPublicUrl(response.url).href === url.href,
          'Unexpected metadata response URL',
        );
      const body = await readJson(response);
      requireValue(
        body &&
          Array.isArray(body.data) &&
          body.data.length <= 50 &&
          Object.hasOwn(body, 'nextCursor'),
        'Invalid metadata page',
      );
      cursor = body.nextCursor;
      requireValue(
        cursor === null || (typeof cursor === 'string' && /^[a-zA-Z0-9_-]{1,2000}$/.test(cursor)),
        'Invalid pagination cursor',
      );
      if (cursor) {
        requireValue(
          body.data.length > 0 && !seen.has(cursor),
          'Repeated or empty pagination page',
        );
        seen.add(cursor);
      }
      sources.push({ url: url.href, fetchedAt: now().toISOString() });
      rows.push(...body.data);
      pageCount++;
    } while (cursor && pageCount < maximum);
    requireValue(
      !completeRequired || !cursor,
      'Catalog pagination limit reached; no complete catalog was exported',
    );
    return { rows, pageCount, complete: cursor === null };
  }

  const catalog = await pages(
    '/v1/public/apis?state=captured&sort=recent&limit=50',
    catalogPages,
    true,
  );
  const apis = [];
  const seen = new Set();
  for (const row of catalog.rows) {
    requireValue(
      row && typeof row === 'object' && typeof row.id === 'string' && slug.test(row.id),
      'Invalid catalog vendor',
    );
    requireValue(!seen.has(row.id), 'Duplicate catalog vendor');
    seen.add(row.id);
    if (reserved.test(row.id) || row.latestSpec === null) continue;
    if (selected.size && !selected.has(row.id)) continue;
    publicVendor(row.id);
    const latest = row.latestSpec;
    requireValue(latest && typeof latest === 'object', 'Invalid captured specification metadata');
    const api = {
      id: row.id,
      name: text(row.name, 120),
      category: text(row.category, 120),
      description: text(row.description, 1000),
      releaseCount: count(row.releaseCount),
      link: `${SITE_ORIGIN}/monitoring/${row.id}`,
      latestCapture: {
        specHash: digest(latest.specHash),
        version: nullableText(latest.version),
        firstCapturedAt: date(latest.firstCapturedAt),
        lastCapturedAt: date(latest.lastCapturedAt),
        captureCount: count(latest.captureCount),
      },
    };
    const history = await pages(`/v1/public/apis/${row.id}/releases?limit=50`, releasePages, false);
    const releases = history.rows.map((value) => release(value, row.id));
    requireValue(
      new Set(releases.map((value) => value.id)).size === releases.length,
      'Duplicate release metadata',
    );
    apis.push({
      ...api,
      releaseHistory: { complete: history.complete, pageCount: history.pageCount, releases },
    });
  }
  for (const vendor of selected)
    requireValue(
      apis.some((api) => api.id === vendor),
      `No captured public API found for ${vendor}`,
    );
  requireValue(apis.length > 0, 'No captured public APIs available');
  return {
    schemaVersion: 1,
    fetchedAt: now().toISOString(),
    collectionStartedAt: started,
    publisher: { name: 'ParityDiff', link: `${SITE_ORIGIN}/monitoring` },
    scope:
      'Public captured API and release metadata only. No contracts, changes, source snippets, or customer data.',
    consistency:
      'Point-in-time HTTP observations, not a transactional snapshot. Recorded release counts can change while collecting pages.',
    totals: {
      apis: apis.length,
      recordedReleases: count(apis.reduce((sum, api) => sum + api.releaseCount, 0)),
      exportedReleaseRecords: apis.reduce(
        (sum, api) => sum + api.releaseHistory.releases.length,
        0,
      ),
    },
    sources,
    apis,
  };
}

export function parseArgs(args) {
  const result = {};
  const used = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help' && args.length === 1) return { help: true };
    requireValue(
      ['--vendors', '--release-pages', '--output'].includes(flag) && !used.has(flag),
      'Unknown or repeated CLI option',
    );
    used.add(flag);
    const value = args[++index];
    requireValue(typeof value === 'string' && value.length > 0, 'Missing CLI option value');
    if (flag === '--vendors') result.vendors = value.split(',').map(publicVendor);
    if (flag === '--release-pages') {
      requireValue(/^[1-4]$/.test(value), 'Release pages must be between 1 and 4');
      result.releasePages = Number(value);
    }
    if (flag === '--output') result.output = value;
  }
  return result;
}

export async function writeSnapshot(output, snapshot, root = process.cwd()) {
  requireValue(
    typeof output === 'string' &&
      !isAbsolute(output) &&
      !output.includes('\\') &&
      Array.from(output).every((character) => character.charCodeAt(0) >= 32) &&
      output.endsWith('.json'),
    'Output must be a relative JSON path',
  );
  requireValue(
    output
      .split('/')
      .every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && part !== '.' && part !== '..'),
    'Invalid output path',
  );
  const base = await realpath(root);
  const target = resolve(base, output);
  let ancestor = dirname(target);
  while (true) {
    try {
      const existing = await realpath(ancestor);
      const path = relative(base, existing);
      requireValue(
        path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path),
        'Output directory must remain inside the workspace',
      );
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = dirname(ancestor);
    }
  }
  await mkdir(dirname(target), { recursive: true });
  const parent = await realpath(dirname(target));
  const inside = relative(base, parent);
  requireValue(
    inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside),
    'Output directory must remain inside the workspace',
  );
  const temporary = `${target}.${randomUUID()}.tmp`;
  let created = false;
  try {
    await writeFile(temporary, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
    created = true;
    await rename(temporary, target);
  } finally {
    if (created) await rm(temporary, { force: true });
  }
  return target;
}

export async function main(args = process.argv.slice(2)) {
  const { help, output, ...options } = parseArgs(args);
  if (help) {
    console.log(
      'node export.mjs [--vendors openai,sentry] [--release-pages 1..4] [--output snapshot.json]',
    );
    return;
  }
  const snapshot = await exportMetadata(options);
  if (output) await writeSnapshot(output, snapshot);
  else process.stdout.write(JSON.stringify(snapshot, null, 2) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error(
      'Public metadata export failed. Check inputs, public API availability, and pagination limits. No complete output was written.',
    );
    process.exitCode = 1;
  });
}
