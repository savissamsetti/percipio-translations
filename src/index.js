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
const inputDir = join(projectRoot, "input-csv");
const outputDir = join(projectRoot, "output-json");

/**
 * Parse CSV text into an array of row objects keyed by the header columns.
 * Handles quoted fields, escaped quotes (""), and commas/newlines inside quotes.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++; // skip the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      // Handle CRLF: skip the \n following a \r
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }

  // Flush the final field/row if the file doesn't end with a newline
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  if (rows.length === 0) return [];

  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((cols) => {
    const obj = {};
    headers.forEach((header, idx) => {
      obj[header] = cols[idx] !== undefined ? cols[idx] : "";
    });
    return obj;
  });
}

/** Case-insensitive lookup of a column value from a parsed row. */
function getColumn(row, name) {
  const key = Object.keys(row).find(
    (k) => k.toLowerCase() === name.toLowerCase()
  );
  return key !== undefined ? row[key] : undefined;
}

function findCsvFile() {
  let files;
  try {
    files = readdirSync(inputDir);
  } catch {
    throw new Error(`Input folder not found: ${inputDir}`);
  }
  const csvFiles = files.filter((f) => extname(f).toLowerCase() === ".csv");
  if (csvFiles.length === 0) {
    throw new Error(`No CSV file found in ${inputDir}`);
  }
  return join(inputDir, csvFiles[0]);
}

/**
 * Resolve the CSV path from a CLI argument if given, otherwise auto-detect
 * the first CSV in the input folder. A bare filename is resolved relative to
 * the input folder; an absolute or relative path is used as-is.
 */
function resolveCsvPath(arg) {
  if (!arg) return findCsvFile();
  const candidate = arg === basename(arg) ? join(inputDir, arg) : arg;
  if (!existsSync(candidate)) {
    throw new Error(`CSV file not found: ${candidate}`);
  }
  return candidate;
}

function main() {
  const csvPath = resolveCsvPath(process.argv[2]);
  const csvText = readFileSync(csvPath, "utf8");
  const records = parseCsv(csvText);

  const translate = records
    .filter((row) => {
      // Skip fully empty rows
      return Object.values(row).some((v) => v && v.trim() !== "");
    })
    .map((row) => {
      const id = (getColumn(row, "Id") ?? "").trim();
      const key = (getColumn(row, "Key") ?? "").trim();
      const message = getColumn(row, "message") ?? "";
      return {
        message,
        messageId: `${id}:${key}`,
      };
    });

  const result = { translate };

  mkdirSync(outputDir, { recursive: true });
  const outName = `${basename(csvPath, extname(csvPath))}.json`;
  const outPath = join(outputDir, outName);
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n", "utf8");

  console.log(`Read ${translate.length} record(s) from ${csvPath}`);
  console.log(`Wrote ${outPath}`);
}

main();
