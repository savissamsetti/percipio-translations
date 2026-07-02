/**
 * Combined workflow: Download from S3 and convert JSON to CSV in a single operation.
 *
 * Step 1: Download files from S3 (from ./input-json) → ./s3-downloads
 * Step 2: Convert downloaded JSONs to CSV → ./output-csv
 *
 * Usage: node src/combined.js
 */

import {
  readdir,
  readFile,
  mkdir,
  writeFile,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { basename, join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const INPUT_DIR = join(ROOT, 'input-json');
const DOWNLOADS_DIR = join(ROOT, 's3-downloads');
const OUTPUT_DIR = join(ROOT, 'output-csv');

const CONCURRENCY = 8;

// ============================================================================
// STEP 1: Download from S3
// ============================================================================

function fileNameFrom(entry) {
  if (entry.key) return basename(entry.key);
  const url = new URL(entry.signedUrl);
  return basename(decodeURIComponent(url.pathname));
}

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

async function stepDownloadFromS3() {
  console.log('\n=== STEP 1: Download Files from S3 ===\n');

  const entries = await readdir(INPUT_DIR);
  const jsonFiles = entries.filter((f) => f.toLowerCase().endsWith('.json'));

  if (jsonFiles.length === 0) {
    console.log(`No JSON files found in ${INPUT_DIR}`);
    return { ok: 0, failed: 0 };
  }

  await mkdir(DOWNLOADS_DIR, { recursive: true });

  let ok = 0;
  let failed = 0;

  for (const jsonFile of jsonFiles) {
    const doc = JSON.parse(await readFile(join(INPUT_DIR, jsonFile), 'utf8'));
    const items = collectDownloads(doc);
    const destDir = join(DOWNLOADS_DIR, basename(jsonFile, '.json'));

    console.log(`${jsonFile}: ${items.length} file(s) to download`);

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

  console.log(`\nDownload complete. ${ok} downloaded, ${failed} failed.`);
  return { ok, failed };
}

// ============================================================================
// STEP 2: Convert JSON to CSV
// ============================================================================

function localeFromFileName(filePath) {
  const name = basename(filePath, extname(filePath));
  const match = name.match(/Skill_Families_(?:\d+-)?([a-zA-Z]{2,}(?:-[a-zA-Z]{2,})?)$/);
  if (!match) {
    throw new Error(
      `Cannot determine locale from file name "${basename(filePath)}". ` +
        `Expected the pattern <prefix>-Skill_Families_[<n>-]<locale>.json.`
    );
  }
  return match[1];
}

function extractRecords(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.translate)) return data.translate;
  throw new Error(
    'Unsupported JSON shape: expected a top-level array or an object with a `translate` array.'
  );
}

function idFromMessageId(messageId) {
  return String(messageId ?? '').split(':')[0];
}

function csvEscape(value) {
  const str = String(value ?? '');
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function findDownloadFolders() {
  let entries;
  try {
    entries = readdirSync(DOWNLOADS_DIR);
  } catch {
    throw new Error(`Downloads folder not found: ${DOWNLOADS_DIR}`);
  }
  const folders = entries.filter((name) =>
    statSync(join(DOWNLOADS_DIR, name)).isDirectory()
  );
  if (folders.length === 0) {
    throw new Error(`No folders found in ${DOWNLOADS_DIR}`);
  }
  return folders;
}

function buildCsvForFolder(folderName) {
  const outputSubdir = join(DOWNLOADS_DIR, folderName, 'output');
  let files;
  try {
    files = readdirSync(outputSubdir);
  } catch {
    console.warn(`  Skipping ${folderName}: no output/ folder`);
    return 0;
  }

  const jsonFiles = files.filter((f) => extname(f).toLowerCase() === '.json').sort();
  if (jsonFiles.length === 0) {
    console.warn(`  Skipping ${folderName}: no JSON files in output/`);
    return 0;
  }

  const lines = ['id,name,locale'];
  let rowCount = 0;

  for (const file of jsonFiles) {
    const jsonPath = join(outputSubdir, file);
    const locale = localeFromFileName(jsonPath);
    const records = extractRecords(JSON.parse(readFileSync(jsonPath, 'utf8')));
    for (const record of records) {
      const id = idFromMessageId(record.messageId);
      const name = record.message ?? '';
      lines.push([csvEscape(id), csvEscape(name), csvEscape(locale)].join(','));
      rowCount++;
    }
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outPath = join(OUTPUT_DIR, `${folderName}.csv`);
  writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');

  console.log(
    `  ${folderName}: ${jsonFiles.length} file(s), ${rowCount} row(s) -> ${outPath}`
  );
  return rowCount;
}

function stepConvertJsonToCsv() {
  console.log('\n=== STEP 2: Convert Downloaded JSONs to CSV ===\n');

  const folders = findDownloadFolders();
  console.log(`Found ${folders.length} folder(s) in ${DOWNLOADS_DIR}`);

  let totalRows = 0;
  for (const folder of folders.sort()) {
    totalRows += buildCsvForFolder(folder);
  }

  console.log(`\nConversion complete. Wrote ${totalRows} row(s) across ${folders.length} folder(s).`);
  return totalRows;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  try {
    console.log('Starting combined workflow: Download from S3 + Convert JSON to CSV');

    const downloadResult = await stepDownloadFromS3();

    if (downloadResult.failed > 0) {
      console.warn('\nWarning: Some downloads failed. Continuing to conversion step...');
    }

    const totalRows = stepConvertJsonToCsv();

    console.log(`\n✓ Workflow complete.`);
    if (downloadResult.failed > 0) {
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('\n✗ Workflow failed:', err.message);
    process.exit(1);
  }
}

main();
