import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readXlsxSheetRows } from '../../../src/lib/xlsx-lite.js';

/**
 * COOD-93 — first tests for the hand-rolled xlsx reader.
 *
 * This module had no coverage at all, which mattered the moment its six
 * regex loops were rewritten from `while ((m = re.exec(s)) !== null)` to
 * `for (const m of s.matchAll(re))` to clear `noAssignInExpressions`.
 * Both forms are correct, but the old one shares `lastIndex` across the
 * loop while `matchAll` clones the regex — so the rewrite is only
 * obviously safe if something actually parses a workbook.
 *
 * The fixtures are built here rather than committed as binary .xlsx so
 * the malformed cases can be constructed precisely. Entries are STORED
 * (method 0): the reader supports it, and it keeps the builder short.
 * CRCs are left zero because the reader never checks them — if it ever
 * starts to, these tests fail loudly, which is the correct outcome.
 */

function localHeader(name: string, data: Buffer): Buffer {
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4); // version needed
  head.writeUInt16LE(0, 6); // flags
  head.writeUInt16LE(0, 8); // method 0 = stored
  head.writeUInt32LE(0, 14); // crc32 — unchecked by the reader
  head.writeUInt32LE(data.length, 18); // compressed size
  head.writeUInt32LE(data.length, 22); // uncompressed size
  head.writeUInt16LE(Buffer.byteLength(name), 26);
  head.writeUInt16LE(0, 28); // extra length
  return Buffer.concat([head, Buffer.from(name, 'utf8'), data]);
}

function centralEntry(name: string, data: Buffer, localOffset: number): Buffer {
  const rec = Buffer.alloc(46);
  rec.writeUInt32LE(0x02014b50, 0);
  rec.writeUInt16LE(20, 4);
  rec.writeUInt16LE(20, 6);
  rec.writeUInt16LE(0, 8);
  rec.writeUInt16LE(0, 10); // stored
  rec.writeUInt32LE(0, 16); // crc32
  rec.writeUInt32LE(data.length, 20);
  rec.writeUInt32LE(data.length, 24);
  rec.writeUInt16LE(Buffer.byteLength(name), 28);
  rec.writeUInt16LE(0, 30); // extra
  rec.writeUInt16LE(0, 32); // comment
  rec.writeUInt32LE(localOffset, 42);
  return Buffer.concat([rec, Buffer.from(name, 'utf8')]);
}

/** Minimal ZIP with stored entries — enough for `readXlsxSheetRows`. */
function buildZip(files: ReadonlyArray<{ readonly name: string; readonly content: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const data = Buffer.from(file.content, 'utf8');
    const local = localHeader(file.name, data);
    locals.push(local);
    centrals.push(centralEntry(file.name, data, offset));
    offset += local.length;
  }
  const centralDirectory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralDirectory, eocd]);
}

const WORKBOOK = `<?xml version="1.0"?><workbook><sheets>
  <sheet name="Other" sheetId="1" r:id="rId9"/>
  <sheet name="Controls" sheetId="2" r:id="rId1"/>
</sheets></workbook>`;

const RELS = `<?xml version="1.0"?><Relationships>
  <Relationship Id="rId9" Target="worksheets/other.xml"/>
  <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
</Relationships>`;

// Index 0 is referenced by a shared-string cell below.
const SHARED = `<?xml version="1.0"?><sst><si><t>COODRA-ACC-001</t></si><si><t>shared value</t></si></sst>`;

const SHEET = `<?xml version="1.0"?><worksheet><sheetData>
  <row r="1"><c r="A1" t="inlineStr"><is><t>Control ID</t></is></c><c r="B1" t="inlineStr"><is><t>Domain</t></is></c></row>
  <row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="inlineStr"><is><t>Access</t></is></c></row>
  <row r="3"><c r="A3" t="inlineStr"><is><t>COODRA-ENC-002</t></is></c><c r="B3" t="inlineStr"><is><t>Crypto &amp; Keys</t></is></c></row>
</sheetData></worksheet>`;

function writeWorkbook(dir: string, overrides: Partial<Record<string, string>> = {}): string {
  const path = join(dir, 'book.xlsx');
  writeFileSync(
    path,
    buildZip([
      { name: 'xl/workbook.xml', content: overrides['xl/workbook.xml'] ?? WORKBOOK },
      { name: 'xl/_rels/workbook.xml.rels', content: overrides['xl/_rels/workbook.xml.rels'] ?? RELS },
      { name: 'xl/sharedStrings.xml', content: overrides['xl/sharedStrings.xml'] ?? SHARED },
      { name: 'xl/worksheets/sheet1.xml', content: overrides['xl/worksheets/sheet1.xml'] ?? SHEET },
      { name: 'xl/worksheets/other.xml', content: '<worksheet><sheetData/></worksheet>' },
    ]),
  );
  return path;
}

describe('readXlsxSheetRows', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'coodra-xlsx-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads rows keyed by the header line', () => {
    const rows = readXlsxSheetRows(writeWorkbook(dir), 'Controls');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ 'Control ID': 'COODRA-ACC-001', Domain: 'Access' });
    expect(rows[1]).toEqual({ 'Control ID': 'COODRA-ENC-002', Domain: 'Crypto & Keys' });
  });

  it('resolves shared strings by index', () => {
    // Row 2 column A is `t="s"` with `<v>0</v>` — it must come back as
    // the sharedStrings entry, not the literal "0".
    const rows = readXlsxSheetRows(writeWorkbook(dir), 'Controls');
    expect(rows[0]?.['Control ID']).toBe('COODRA-ACC-001');
  });

  it('decodes XML entities in cell text', () => {
    expect(readXlsxSheetRows(writeWorkbook(dir), 'Controls')[1]?.Domain).toBe('Crypto & Keys');
  });

  it('picks the sheet by name, not by position', () => {
    // "Other" is first in the workbook and maps to an empty sheet. A
    // reader that ignored the name would return [] here.
    expect(readXlsxSheetRows(writeWorkbook(dir), 'Controls').length).toBeGreaterThan(0);
    expect(readXlsxSheetRows(writeWorkbook(dir), 'Other')).toEqual([]);
  });

  it('scans every sheet rather than stopping at the first non-match', () => {
    // The loop over <sheet> tags `continue`s past names that do not
    // match. The target here is deliberately last.
    const rows = readXlsxSheetRows(writeWorkbook(dir), 'Controls');
    expect(rows).toHaveLength(2);
  });

  it('throws a named error when the sheet does not exist', () => {
    expect(() => readXlsxSheetRows(writeWorkbook(dir), 'Missing')).toThrow(/sheet "Missing" not found/);
  });

  it('tolerates a workbook with no sharedStrings part', () => {
    const path = join(dir, 'nostrings.xlsx');
    writeFileSync(
      path,
      buildZip([
        { name: 'xl/workbook.xml', content: WORKBOOK },
        { name: 'xl/_rels/workbook.xml.rels', content: RELS },
        {
          name: 'xl/worksheets/sheet1.xml',
          content: `<worksheet><sheetData>
            <row><c r="A1" t="inlineStr"><is><t>Control ID</t></is></c></row>
            <row><c r="A2" t="inlineStr"><is><t>COODRA-ACC-009</t></is></c></row>
          </sheetData></worksheet>`,
        },
        { name: 'xl/worksheets/other.xml', content: '<worksheet><sheetData/></worksheet>' },
      ]),
    );
    expect(readXlsxSheetRows(path, 'Controls')).toEqual([{ 'Control ID': 'COODRA-ACC-009' }]);
  });

  it('returns nothing when no header row carries a Control ID column', () => {
    const rows = readXlsxSheetRows(
      writeWorkbook(dir, {
        'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
          <row><c r="A1" t="inlineStr"><is><t>Unrelated</t></is></c></row>
          <row><c r="A2" t="inlineStr"><is><t>value</t></is></c></row>
        </sheetData></worksheet>`,
      }),
      'Controls',
    );
    expect(rows).toEqual([]);
  });

  it('places cells by their column reference, not their order', () => {
    // A row that skips B must not shift C leftwards into B's header.
    const rows = readXlsxSheetRows(
      writeWorkbook(dir, {
        'xl/worksheets/sheet1.xml': `<worksheet><sheetData>
          <row><c r="A1" t="inlineStr"><is><t>Control ID</t></is></c><c r="B1" t="inlineStr"><is><t>Domain</t></is></c><c r="C1" t="inlineStr"><is><t>Owner</t></is></c></row>
          <row><c r="A2" t="inlineStr"><is><t>COODRA-ACC-003</t></is></c><c r="C2" t="inlineStr"><is><t>platform</t></is></c></row>
        </sheetData></worksheet>`,
      }),
      'Controls',
    );
    // The skipped column is filled with '' rather than dropped, and —
    // the point of the case — "platform" stays under Owner instead of
    // sliding left into Domain.
    expect(rows[0]).toEqual({ 'Control ID': 'COODRA-ACC-003', Domain: '', Owner: 'platform' });
  });

  it('rejects a file that is not a zip', () => {
    const path = join(dir, 'bad.xlsx');
    writeFileSync(path, Buffer.from('this is not a zip archive'));
    expect(() => readXlsxSheetRows(path, 'Controls')).toThrow(/end-of-central-directory/);
  });

  it('names the missing part when the workbook entry is absent', () => {
    const path = join(dir, 'empty.xlsx');
    writeFileSync(path, buildZip([{ name: 'docProps/app.xml', content: '<Properties/>' }]));
    expect(() => readXlsxSheetRows(path, 'Controls')).toThrow(/missing xl\/workbook\.xml/);
  });
});
