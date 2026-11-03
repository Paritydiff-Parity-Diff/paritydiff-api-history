import { appendFile } from 'node:fs/promises';
import { exportMetadata, parseArgs, writeSnapshot } from './export.mjs';

try {
  const args = [
    '--output',
    process.env.INPUT_OUTPUT || 'paritydiff-monitoring.json',
    '--release-pages',
    process.env['INPUT_RELEASE-PAGES'] || '1',
  ];
  if (process.env.INPUT_VENDORS) args.push('--vendors', process.env.INPUT_VENDORS);
  const { output, ...options } = parseArgs(args);
  const snapshot = await exportMetadata(options);
  const path = await writeSnapshot(output, snapshot, process.env.GITHUB_WORKSPACE || process.cwd());
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `json-path=${path}\napi-count=${snapshot.totals.apis}\nrecorded-release-count=${snapshot.totals.recordedReleases}\nfetched-at=${snapshot.fetchedAt}\n`,
    );
  }
  console.log(`Exported public metadata for ${snapshot.totals.apis} captured APIs to ${output}`);
} catch {
  console.error('Public metadata action failed. Consume output only after a successful step.');
  process.exitCode = 1;
}
