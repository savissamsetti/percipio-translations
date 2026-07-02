/**
 * Read each JSON file in ./trans-files, extract every `signedUrl` (from the
 * job's inputDataDetails and each outputDataDetails entry), and download the
 * referenced S3 objects into ./s3-downloads.
 *
 * Files are organized per source JSON:
 *   s3-downloads/<jsonName>/input/<filename>
 *   s3-downloads/<jsonName>/output/<filename>
 *
 * Usage: node src/download-from-s3.js
 */

import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TRANS_DIR = join(ROOT, 'trans-files');
const OUT_DIR = join(ROOT, 's3-downloads');

const CONCURRENCY = 8;

/** Derive a filename from the S3 key or the signed URL path. */
function fileNameFrom(entry) {
  if (entry.key) return basename(entry.key);
  const url = new URL(entry.signedUrl);
  return basename(decodeURIComponent(url.pathname));
}

/** Collect { signedUrl, fileName, kind } items from one parsed JSON doc. */
function collectDownloads(doc) {
  const job = doc.job ?? {};
  const items = [];

  if (job.inputDataDetails?.signedUrl) {
    const input = job.inputDataDetails;
    items.push({
      signedUrl: input.signedUrl,
      fileName: input.key ? basename(input.key) : basename(new URL(input.signedUrl).pathname),
      kind: 'input',
    });
  }

  for (const out of job.outputDataDetails ?? []) {
    if (!out.signedUrl) continue;
    items.push({ signedUrl: out.signedUrl, fileName: fileNameFrom(out), kind: 'output' });
  }

  return items;
}

async function downloadOne(item, destDir) {
  const dest = join(destDir, item.kind, item.fileName);
  const res = await fetch(item.signedUrl);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(join(destDir, item.kind), { recursive: true });
  await writeFile(dest, buf);
  return dest;
}

/** Run async tasks with a bounded pool. */
async function runPool(tasks, limit) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]().catch((err) => ({ error: err }));
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const entries = await readdir(TRANS_DIR);
  const jsonFiles = entries.filter((f) => f.toLowerCase().endsWith('.json'));

  if (jsonFiles.length === 0) {
    console.log(`No JSON files found in ${TRANS_DIR}`);
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });

  let ok = 0;
  let failed = 0;

  for (const jsonFile of jsonFiles) {
    const doc = JSON.parse(await readFile(join(TRANS_DIR, jsonFile), 'utf8'));
    const items = collectDownloads(doc);
    const destDir = join(OUT_DIR, basename(jsonFile, '.json'));

    console.log(`\n${jsonFile}: ${items.length} file(s) to download`);

    const tasks = items.map((item) => async () => {
      const dest = await downloadOne(item, destDir);
      return { item, dest };
    });

    const results = await runPool(tasks, CONCURRENCY);

    for (const [idx, r] of results.entries()) {
      const item = items[idx];
      if (r?.error) {
        failed++;
        console.error(`  ✗ ${item.kind}/${item.fileName} — ${r.error.message}`);
      } else {
        ok++;
        console.log(`  ✓ ${item.kind}/${item.fileName}`);
      }
    }
  }

  console.log(`\nDone. ${ok} downloaded, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
