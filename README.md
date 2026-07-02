# percipio-translations

Converts translation data between CSV and JSON in both directions.

- **CSV → JSON** (`src/index.js`): builds a translation JSON from a CSV. Uses `input/` → `output/`.
- **JSON → CSV** (`src/json-to-csv.js`): flattens a single translation JSON into a CSV. Uses `trans-input/` → `trans-outpt/`.
- **Download from S3** (`src/download-from-s3.js`): reads job JSON files in `trans-files/` and downloads every `signedUrl` into `s3-downloads/`.
- **JSON → CSV (multi)** (`src/json-to-csv-multi.js`): flattens the downloaded output JSONs into one CSV per folder. Uses `s3-downloads/*/output/` → `trans-outpt/`.
- **Combined Workflow** (`src/combined.js`): orchestrates download + conversion in one step. Uses `input-json/` → `s3-downloads/` → `output-csv/`.

## CSV → JSON

1. Put a CSV file in the `input/` folder with columns: `Id`, `Key`, `message`.
2. Run:

   ```bash
   # Auto-detect the first CSV in input/
   npm start

   # Or pass a specific file (bare name resolves to input/, or use a path)
   node src/index.js translations.csv
   node src/index.js ./some/other/file.csv
   ```

3. The JSON is written to `output/<csvname>.json`.

### CSV format

```csv
Id,Key,message
remarks,header,REMARKS
archivedRegistration,banner,"Updates are disabled because the learner is registered in another class that has already started"
```

### Output format

- `messageId` is built as `Id:Key`.
- `message` comes from the `message` column.

```json
{
  "translate": [
    {
      "message": "REMARKS",
      "messageId": "remarks:header"
    }
  ]
}
```

Notes:
- The first `.csv` file found in `input/` is used.
- Quoted fields, escaped quotes (`""`), and commas/newlines inside quotes are handled.
- No external dependencies.

## JSON → CSV

1. Put a JSON file in the `trans-input/` folder. The file name must carry the
   locale as `Skill_Families-<locale>.json` (e.g. `Skill_Families-de-DE.json`,
   `Skill_Families-fr-FR.json`, `Skill_Families-arb.json`). The locale is read
   from the file name and applied to every row.
2. Run:

   ```bash
   # Auto-detect the first JSON in trans-input/
   npm run to-csv

   # Or pass a specific file (bare name resolves to trans-input/, or use a path)
   npm run to-csv Skill_Families-de-DE.json
   node src/json-to-csv.js ./some/other/Skill_Families-fr-FR.json
   ```

3. The CSV is written to `trans-outpt/<jsonname>.csv` with columns `id,name,locale`.

### Input JSON shapes

Either of these is accepted:

```json
[
  { "messageId": "30031be3-a045-4be5-a578-710556d316c0:name", "message": "@RISK" }
]
```

```json
{
  "translate": [
    { "message": "@RISK", "messageId": "30031be3-a045-4be5-a578-710556d316c0:name" }
  ]
}
```

### Output CSV

- `id` is the UUID portion of `messageId` (the part before `:name`).
- `name` comes from the `message` field.
- `locale` is taken from the file name and is the same for every row.

```csv
id,name,locale
30031be3-a045-4be5-a578-710556d316c0,@RISK,de-DE
```

Notes:
- The first `.json` file found in `trans-input/` is used when no argument is given.
- Fields containing commas, quotes, or newlines are quoted; embedded quotes are escaped as `""`.
- The file name must include a locale, otherwise the script errors.
- No external dependencies.

## Download from S3

Downloads the translated files referenced by the localization job JSONs.

1. Put the job result JSON files in the `trans-files/` folder. Each file has a
   `job` object with an `inputDataDetails` object and an `outputDataDetails`
   array; every entry carries a pre-signed S3 `signedUrl`.
2. Run:

   ```bash
   npm run download
   # or
   node src/download-from-s3.js
   ```

3. Files are downloaded into `s3-downloads/<jsonName>/`, split by kind:

   ```
   s3-downloads/
     file1/
       input/<filename>
       output/<filename>   # one JSON per target locale
   ```

Notes:
- Filenames come from each entry's S3 `key` (falling back to the URL path).
- Downloads run 8 at a time; a non-2xx response is logged and counted as failed
  without aborting the rest of the run.
- Pre-signed URLs expire (typically 1 hour after they are generated), so refresh
  the `trans-files/` JSONs if downloads start returning `403`.
- Uses Node's built-in `fetch`; no external dependencies.

## JSON → CSV (multi)

Turns the downloaded translations into one CSV per source folder, reading only
the `output/` subfolder of each.

1. Download the files first (see [Download from S3](#download-from-s3)) so that
   `s3-downloads/*/output/` is populated.
2. Run:

   ```bash
   npm run to-csv-multi
   # or
   node src/json-to-csv-multi.js
   ```

3. One CSV per folder is written to `trans-outpt/<folderName>.csv` with columns
   `id,name,locale`. All locale files in a folder are concatenated into that
   single CSV, each row tagged with the locale parsed from its file name.

Notes:
- Only the `output/` subfolder of each `s3-downloads/*` folder is read; the
  `input/` files are ignored.
- Locale is parsed from the downloaded file name pattern
  `<prefix>-Skill_Families_<n>-<locale>.json` (e.g. `ar-LB`, `arb`, `zh-TW`).
- Same `id`/`name` extraction and CSV escaping as the single-file JSON → CSV.
- No external dependencies.

## Combined Workflow (Download + Convert)

Orchestrates the entire process in a single command: downloads output files from
S3 and immediately converts them to CSVs.

1. Put job result JSON files in the `input-json/` folder (the same files used for
   [Download from S3](#download-from-s3)).
2. Run:

   ```bash
   npm run combined
   # or
   node src/combined.js
   ```

3. The workflow executes in two steps:
   - **Step 1:** Downloads files from S3 into `s3-downloads/<jsonName>/input/` and
     `s3-downloads/<jsonName>/output/`
   - **Step 2:** Converts all `output/` JSONs into a single CSV per folder, written
     to `output-csv/<folderName>.csv`

### Output Structure

```
input-json/           # Job JSON files with signed URLs
s3-downloads/         # Downloaded files (intermediate)
  job1/
    output/
      <locale-files>
output-csv/           # Final CSV files (one per source job)
  job1.csv
```

Notes:
- This is the recommended approach for a complete download-and-convert pipeline.
- Only output files are converted to CSV; input files are downloaded but not used.
- Same locale parsing and CSV formatting as [JSON → CSV (multi)](#json--csv-multi).
- Non-2xx S3 downloads are logged and counted as failed, but the conversion step
  continues.
- No external dependencies.
