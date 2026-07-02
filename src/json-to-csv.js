import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const inputDir = join(projectRoot, "trans-input");
const outputDir = join(projectRoot, "trans-outpt");

/**
 * Extract the locale from a file name of the form Skill_Families-<locale>.json.
 * Examples of <locale>: en-US, de-DE, fr-FR, arb. Throws if the name does not
 * carry a locale, since locale is required for every row.
 */
function localeFromFileName(filePath) {
  const name = basename(filePath, extname(filePath));
  const match = name.match(/^Skill_Families-(.+)$/);
  if (!match) {
    throw new Error(
      `Cannot determine locale from file name "${basename(filePath)}". ` +
        `Expected the pattern Skill_Families-<locale>.json (e.g. Skill_Families-de-DE.json).`
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

function findJsonFile() {
  let files;
  try {
    files = readdirSync(inputDir);
  } catch {
    throw new Error(`Input folder not found: ${inputDir}`);
  }
  const jsonFiles = files.filter((f) => extname(f).toLowerCase() === ".json");
  if (jsonFiles.length === 0) {
    throw new Error(`No JSON file found in ${inputDir}`);
  }
  return join(inputDir, jsonFiles[0]);
}

/**
 * Resolve the JSON path from a CLI argument if given, otherwise auto-detect
 * the first JSON in the input folder. A bare filename is resolved relative to
 * the input folder; an absolute or relative path is used as-is.
 */
function resolveJsonPath(arg) {
  if (!arg) return findJsonFile();
  const candidate = arg === basename(arg) ? join(inputDir, arg) : arg;
  if (!existsSync(candidate)) {
    throw new Error(`JSON file not found: ${candidate}`);
  }
  return candidate;
}

function main() {
  const jsonPath = resolveJsonPath(process.argv[2]);
  const locale = localeFromFileName(jsonPath);
  const records = extractRecords(JSON.parse(readFileSync(jsonPath, "utf8")));

  const lines = ["id,name,locale"];
  for (const record of records) {
    const id = idFromMessageId(record.messageId);
    const name = record.message ?? "";
    lines.push(
      [csvEscape(id), csvEscape(name), csvEscape(locale)].join(",")
    );
  }

  mkdirSync(outputDir, { recursive: true });
  const outName = `${basename(jsonPath, extname(jsonPath))}.csv`;
  const outPath = join(outputDir, outName);
  writeFileSync(outPath, lines.join("\n") + "\n", "utf8");

  console.log(`Read ${records.length} record(s) from ${jsonPath}`);
  console.log(`Locale: ${locale}`);
  console.log(`Wrote ${outPath}`);
}

main();
