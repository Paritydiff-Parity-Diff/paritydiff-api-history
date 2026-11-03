import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import {
  exportMetadata,
  officialPublicUrl,
  parseArgs,
  publicVendor,
  writeSnapshot,
} from './export.mjs';

const capturedAt = '2026-11-01T00:00:00.000Z';
const clock = () => new Date(capturedAt);
const api = (id = 'openai') => ({
  id,
  name: 'OpenAI',
  category: 'Language models',
  description: 'Public API changes.',
  releaseCount: 2,
  sourceUrl: 'https://untrusted.example/source-contract',
  privateToken: 'must-not-export',
  latestSpec: {
    specHash: 'a'.repeat(64),
    version: '1.0',
    firstCapturedAt: capturedAt,
    lastCapturedAt: capturedAt,
    captureCount: 1,
    sourceBody: 'must-not-export',
  },
});
const release = (id = 'rel-one') => ({
  id,
  detectedAt: capturedAt,
  fromHash: 'a'.repeat(64),
  toHash: 'b'.repeat(64),
  fromVersion: '1',
  toVersion: '2',
  detectionMethod: 'openapi_diff',
  detectorVersion: 'test',
  expectedChanges: 1,
  recordedChanges: 1,
  counts: { breaking: 1, non_breaking: 0, ambiguous: 0, deprecation: 0, pending: 0 },
  status: 'classified',
  customerSource: 'must-not-export',
});
const page = (data, nextCursor = null) => ({ data, nextCursor });
function queued(bodies) {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    assert.ok(bodies.length, 'Unexpected extra HTTP request');
    const body = bodies.shift();
    return body instanceof Response ? body : Response.json(body);
  };
  return { calls, fetcher };
}

test('exports only selected captured public metadata, with counts, provenance and linkbacks', async () => {
  const { calls, fetcher } = queued([
    page([api('fixture-hidden'), { ...api('stripe'), latestSpec: null }, api('sentry'), api()]),
    page([release()]),
  ]);
  const snapshot = await exportMetadata({ vendors: ['openai'] }, fetcher, clock);
  assert.deepEqual(snapshot.totals, { apis: 1, recordedReleases: 2, exportedReleaseRecords: 1 });
  assert.equal(snapshot.fetchedAt, capturedAt);
  assert.equal(snapshot.apis[0].link, 'https://paritydiff.com/monitoring/openai');
  assert.equal(
    snapshot.apis[0].releaseHistory.releases[0].link,
    'https://paritydiff.com/monitoring/openai/releases/rel-one',
  );
  assert.equal(snapshot.sources.length, 2);
  assert.equal(JSON.stringify(snapshot).includes('must-not-export'), false);
  assert.equal(JSON.stringify(snapshot).includes('untrusted.example'), false);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.credentials, 'omit');
    assert.deepEqual(call.options.headers, { accept: 'application/json' });
    officialPublicUrl(call.url);
  }
});

test('follows bounded catalog and release cursors while preserving request scope', async () => {
  const { calls, fetcher } = queued([
    page([api('sentry')], 'catalog_2'),
    page([api()]),
    page([release('rel-one')], 'release_2'),
    page([release('rel-two')]),
  ]);
  const snapshot = await exportMetadata({ vendors: ['openai'], releasePages: 2 }, fetcher, clock);
  assert.equal(calls.length, 4);
  const catalog = new URL(calls[1].url);
  assert.equal(catalog.searchParams.get('cursor'), 'catalog_2');
  assert.equal(catalog.searchParams.get('state'), 'captured');
  assert.equal(snapshot.apis[0].releaseHistory.complete, true);
  assert.equal(snapshot.apis[0].releaseHistory.pageCount, 2);
});

test('marks intentionally bounded release history incomplete instead of implying all revisions exported', async () => {
  const { fetcher } = queued([page([api()]), page([release()], 'more_releases')]);
  const snapshot = await exportMetadata({}, fetcher, clock);
  assert.equal(snapshot.apis[0].releaseHistory.complete, false);
  assert.equal(snapshot.totals.recordedReleases, 2);
  assert.equal(snapshot.totals.exportedReleaseRecords, 1);
});

test('fails rather than emitting a truncated catalog or cycling pagination', async () => {
  await assert.rejects(
    exportMetadata({ catalogPages: 1 }, queued([page([api()], 'more')]).fetcher, clock),
    /Catalog pagination limit/,
  );
  await assert.rejects(
    exportMetadata(
      {},
      queued([page([api()], 'same'), page([api('sentry')], 'same')]).fetcher,
      clock,
    ),
    /Repeated/,
  );
  await assert.rejects(exportMetadata({}, queued([page([], 'more')]).fetcher, clock), /empty/);
});

test('rejects foreign/insecure origins, credentials, contract endpoints and query injection', () => {
  for (const value of [
    'http://api.paritydiff.com/v1/public/apis',
    'https://api.paritydiff.com.evil.test/v1/public/apis',
    'https://api.paritydiff.com:8443/v1/public/apis',
    'https://user:token@api.paritydiff.com/v1/public/apis',
    'https://api.paritydiff.com/v1/public/apis/openai/specs/' + 'a'.repeat(64),
    'https://api.paritydiff.com/v1/public/apis/openai/releases/rel-one/changes',
    'https://api.paritydiff.com/v1/customer/repos',
    'https://api.paritydiff.com/v1/public/apis?limit=50&limit=1',
    'https://api.paritydiff.com/v1/public/apis?cursor=https://evil.test',
  ])
    assert.throws(() => officialPublicUrl(value));
  for (const value of ['../openai', 'OpenAI', 'pd-e2e-hidden', 'fixture-one', 'openai?secret=yes'])
    assert.throws(() => publicVendor(value));
});

test('fails closed on HTTP errors, unexpected MIME, missing page keys, invalid fields and duplicate records', async () => {
  for (const body of [
    new Response('failure', { status: 503 }),
    new Response('<html>bad</html>'),
    { data: [] },
    page([{ ...api(), releaseCount: -1 }]),
    page([api(), api()]),
  ]) {
    const responses = [body, page([release()])];
    await assert.rejects(exportMetadata({}, queued(responses).fetcher, clock));
  }
  await assert.rejects(
    exportMetadata(
      {},
      queued([page([api()]), page([{ ...release(), toHash: 'invalid' }])]).fetcher,
      clock,
    ),
    /digest/,
  );
  await assert.rejects(
    exportMetadata({}, queued([page([api()]), page([release(), release()])]).fetcher, clock),
    /Duplicate release/,
  );
});

test('does not silently drop an explicitly requested missing or uncaptured API', async () => {
  await assert.rejects(
    exportMetadata({ vendors: ['stripe'] }, queued([page([api()])]).fetcher, clock),
    /No captured public API/,
  );
  await assert.rejects(exportMetadata({ releasePages: 5 }, queued([]).fetcher, clock), /between/);
  await assert.rejects(
    exportMetadata({ vendors: ['openai', 'openai'] }, queued([]).fetcher, clock),
    /unique/,
  );
});

test('refuses oversized bodies, malformed JSON and unexpected response URLs', async () => {
  for (const response of [
    new Response('x'.repeat(2 * 1024 * 1024 + 1), {
      headers: { 'content-type': 'application/json' },
    }),
    new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    new Response('', { status: 302, headers: { location: 'https://example.test' } }),
  ])
    await assert.rejects(exportMetadata({}, queued([response]).fetcher, clock));
  const foreign = Response.json(page([api()]));
  Object.defineProperty(foreign, 'url', { value: 'https://example.test/v1/public/apis' });
  await assert.rejects(exportMetadata({}, queued([foreign]).fetcher, clock), /official HTTPS/);
});

test('caps total HTTP requests even when many public vendors have release pages', async () => {
  let calls = 0;
  await assert.rejects(
    exportMetadata(
      {},
      async (url) => {
        calls++;
        return Response.json(
          new URL(url).pathname === '/v1/public/apis'
            ? page(Array.from({ length: 50 }, (_, i) => api('api-' + i)))
            : page([release()]),
        );
      },
      clock,
    ),
    /50-request budget/,
  );
  assert.equal(calls, 50);
});

test('CLI arguments reject unknown or repeated flags and unsafe vendor input', () => {
  assert.deepEqual(parseArgs(['--vendors', 'openai,sentry', '--release-pages', '2']), {
    vendors: ['openai', 'sentry'],
    releasePages: 2,
  });
  for (const args of [
    ['--origin', 'https://evil.test'],
    ['--vendors', 'openai', '--vendors', 'sentry'],
    ['--vendors', '../openai'],
    ['--release-pages', '99'],
    ['--output'],
  ])
    assert.throws(() => parseArgs(args));
});

test('writes one complete JSON file atomically inside the workspace and rejects escape paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'public-metadata-export-'));
  try {
    const file = await writeSnapshot('data/snapshot.json', { fetchedAt: capturedAt }, root);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { fetchedAt: capturedAt });
    for (const path of [
      '../outside.json',
      '/outside.json',
      'bad\nname.json',
      'snapshot.txt',
      'C:\\outside.json',
    ])
      await assert.rejects(writeSnapshot(path, {}, root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('standalone action uses hyphenated inputs, paginates, and emits actual output values without dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'public-metadata-action-'));
  try {
    for (const file of ['export.mjs', 'action.mjs'])
      await copyFile(new URL(file, import.meta.url), join(root, file));
    const output = join(root, 'outputs.txt');
    const mock = `globalThis.fetch = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/v1/public/apis') return Response.json(${JSON.stringify(page([api()]))});
      if (parsed.searchParams.has('cursor')) return Response.json(${JSON.stringify(page([release('rel-two')]))});
      return Response.json(${JSON.stringify(page([release()], 'second_page'))});
    }; await import(${JSON.stringify(pathToFileURL(join(root, 'action.mjs')).href)});`;
    execFileSync(process.execPath, ['--input-type=module', '-e', mock], {
      cwd: root,
      env: {
        ...process.env,
        GITHUB_WORKSPACE: root,
        GITHUB_OUTPUT: output,
        INPUT_VENDORS: 'openai',
        INPUT_OUTPUT: 'snapshot.json',
        'INPUT_RELEASE-PAGES': '2',
      },
      stdio: 'pipe',
      windowsHide: true,
      timeout: 10000,
    });
    const snapshot = JSON.parse(await readFile(join(root, 'snapshot.json'), 'utf8'));
    assert.equal(snapshot.apis[0].releaseHistory.releases.length, 2);
    assert.equal(snapshot.apis[0].releaseHistory.complete, true);
    const outputs = await readFile(output, 'utf8');
    assert.ok(outputs.includes('api-count=1\n'));
    assert.ok(outputs.includes('recorded-release-count=2\n'));
    assert.ok(outputs.includes('json-path=' + join(root, 'snapshot.json')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
