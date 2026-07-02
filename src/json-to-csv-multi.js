import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const downloadsDir = join(projectRoot, "s3-downloads");
const outputDir = join(projectRoot, "trans-outpt");

/**
 * Extract the locale from a downloaded file name of the form
 * <prefix>-Skill_Families_<n>-<locale>.json or <prefix>-Skill_Families_<locale>.json.
 * The locale is the trailing segment after Skill_Families,
 * e.g. "ar-LB", "arb", "zh-TW", "es". Throws if it cannot be determined.
 */
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

/**
 * Normalize either supported JSON shape into an array of records:
 *   - a top-level array of records, or
 *   - an object with a `translate` array of records.
 * Each record is expected to have `messageId` and `message`.
 */
function extractRecords(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.translate)) return data.translate;
  throw new Error(
    "Unsupported JSON shape: expected a top-level array or an object with a `translate` array."
  );
}

/** The id is the UUID portion of `messageId` before the `:name` suffix. */
function idFromMessageId(messageId) {
  return String(messageId ?? "").split(":")[0];
}

/** Quote a CSV field only when needed (commas, quotes, or newlines). */
function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** List the immediate subdirectories of s3-downloads (one per source JSON). */
function findDownloadFolders() {
  let entries;
  try {
    entries = readdirSync(downloadsDir);
  } catch {
    throw new Error(`Downloads folder not found: ${downloadsDir}`);
  }
  const folders = entries.filter((name) =>
    statSync(join(downloadsDir, name)).isDirectory()
  );
  if (folders.length === 0) {
    throw new Error(`No folders found in ${downloadsDir}`);
  }
  return folders;
}

/**
 * Build one CSV for a single download folder by reading every JSON in its
 * `output/` subfolder. Each locale file contributes its rows, tagged with the
 * locale parsed from the file name. Returns the number of rows written.
 */
function buildCsvForFolder(folderName) {
  const outputSubdir = join(downloadsDir, folderName, "output");
  let files;
  try {
    files = readdirSync(outputSubdir);
  } catch {
    console.warn(`  Skipping ${folderName}: no output/ folder`);
    return 0;
  }

  const jsonFiles = files
    .filter((f) => extname(f).toLowerCase() === ".json")
    .sort();
  if (jsonFiles.length === 0) {
    console.warn(`  Skipping ${folderName}: no JSON files in output/`);
    return 0;
  }

  const lines = ["id,name,locale"];
  let rowCount = 0;

  for (const file of jsonFiles) {
    const jsonPath = join(outputSubdir, file);
    const locale = localeFromFileName(jsonPath);
    const records = extractRecords(JSON.parse(readFileSync(jsonPath, "utf8")));
    for (const record of records) {
      const id = idFromMessageId(record.messageId);
      const name = record.message ?? "";
      lines.push(
        [csvEscape(id), csvEscape(name), csvEscape(locale)].join(",")
      );
      rowCount++;
    }
  }

  mkdirSync(outputDir, { recursive: true });
  const outPath = join(outputDir, `${folderName}.csv`);
  writeFileSync(outPath, lines.join("\n") + "\n", "utf8");

  console.log(
    `  ${folderName}: ${jsonFiles.length} file(s), ${rowCount} row(s) -> ${outPath}`
  );
  return rowCount;
}

function main() {
  const folders = findDownloadFolders();
  console.log(`Found ${folders.length} folder(s) in ${downloadsDir}`);

  let totalRows = 0;
  for (const folder of folders.sort()) {
    totalRows += buildCsvForFolder(folder);
  }

  console.log(`\nDone. Wrote ${totalRows} row(s) across ${folders.length} folder(s).`);
}

main();
