import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

export type SheetRow = Record<string, string>;

interface ZipEntry {
  readonly name: string;
  readonly method: number;
  readonly compressedSize: number;
  readonly localHeaderOffset: number;
}

export function readXlsxSheetRows(path: string, sheetName: string): ReadonlyArray<SheetRow> {
  const archive = readZip(readFileSync(path));
  const workbook = readZipText(archive, 'xl/workbook.xml');
  const rels = readZipText(archive, 'xl/_rels/workbook.xml.rels');
  const sharedStrings = parseSharedStrings(archive.get('xl/sharedStrings.xml')?.text ?? '');
  const target = resolveSheetTarget(workbook, rels, sheetName);
  const sheetXml = readZipText(archive, target);
  return parseSheetRows(sheetXml, sharedStrings);
}

function readZip(buffer: Buffer): Map<string, { text: string }> {
  const entries = new Map<string, { text: string }>();
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  let offset = centralDirectoryOffset;
  const end = centralDirectoryOffset + centralDirectorySize;
  while (offset < end) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + fileNameLength);
    const entry: ZipEntry = { name, method, compressedSize, localHeaderOffset };
    entries.set(name, { text: inflateEntry(buffer, entry).toString('utf8') });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }
  return entries;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 65557);
  for (let i = buffer.length - 22; i >= min; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new Error('Invalid xlsx: ZIP end-of-central-directory record not found');
}

function inflateEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const local = entry.localHeaderOffset;
  if (buffer.readUInt32LE(local) !== 0x04034b50) {
    throw new Error(`Invalid xlsx: local header missing for ${entry.name}`);
  }
  const fileNameLength = buffer.readUInt16LE(local + 26);
  const extraLength = buffer.readUInt16LE(local + 28);
  const dataStart = local + 30 + fileNameLength + extraLength;
  const data = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`Unsupported xlsx compression method ${entry.method} for ${entry.name}`);
}

function readZipText(entries: Map<string, { text: string }>, name: string): string {
  const entry = entries.get(name);
  if (entry === undefined) throw new Error(`Invalid xlsx: missing ${name}`);
  return entry.text;
}

function resolveSheetTarget(workbookXml: string, relsXml: string, sheetName: string): string {
  const sheetPattern = /<x?:?sheet\b[^>]*>/g;
  for (const match of workbookXml.matchAll(sheetPattern)) {
    const tag = match[0] ?? '';
    if (xmlAttr(tag, 'name') !== sheetName) continue;
    const relationshipId = xmlAttr(tag, 'r:id') ?? xmlAttr(tag, 'id');
    if (relationshipId === null) break;
    const relTarget = findRelationshipTarget(relsXml, relationshipId);
    if (relTarget === null) break;
    const normalized = relTarget.replace(/^\//, '');
    return normalized.startsWith('xl/') ? normalized : `xl/${normalized}`;
  }
  throw new Error(`Invalid xlsx: sheet "${sheetName}" not found`);
}

function findRelationshipTarget(relsXml: string, relationshipId: string): string | null {
  const relPattern = /<Relationship\b[^>]*>/g;
  for (const match of relsXml.matchAll(relPattern)) {
    const tag = match[0] ?? '';
    if (xmlAttr(tag, 'Id') === relationshipId) return xmlAttr(tag, 'Target');
  }
  return null;
}

function parseSharedStrings(sharedStringsXml: string): ReadonlyArray<string> {
  if (sharedStringsXml.length === 0) return [];
  const strings: string[] = [];
  const itemPattern = /<x?:?si\b[^>]*>([\s\S]*?)<\/x?:?si>/g;
  for (const match of sharedStringsXml.matchAll(itemPattern)) {
    strings.push(textFromXmlFragment(match[1] ?? ''));
  }
  return strings;
}

function parseSheetRows(sheetXml: string, sharedStrings: ReadonlyArray<string>): ReadonlyArray<SheetRow> {
  const rowPattern = /<x?:?row\b[^>]*>([\s\S]*?)<\/x?:?row>/g;
  const rows: string[][] = [];
  for (const rowMatch of sheetXml.matchAll(rowPattern)) {
    rows.push(parseCells(rowMatch[1] ?? '', sharedStrings));
  }
  const headerIndex = rows.findIndex((row) => row.some((cell) => normalizeHeader(cell) === 'controlid'));
  if (headerIndex < 0) return [];
  const headers = rows[headerIndex] ?? [];
  return rows
    .slice(headerIndex + 1)
    .map((row) => {
      const out: SheetRow = {};
      for (let i = 0; i < headers.length; i += 1) {
        const header = headers[i]?.trim();
        if (header === undefined || header.length === 0) continue;
        out[header] = row[i]?.trim() ?? '';
      }
      return out;
    })
    .filter((row) => Object.values(row).some((value) => value.length > 0));
}

function parseCells(rowXml: string, sharedStrings: ReadonlyArray<string>): string[] {
  const cells: string[] = [];
  const cellPattern = /<x?:?c\b([^>]*)>([\s\S]*?)<\/x?:?c>|<x?:?c\b([^>]*)\/>/g;
  for (const match of rowXml.matchAll(cellPattern)) {
    const attrs = match[1] ?? match[3] ?? '';
    const body = match[2] ?? '';
    const ref = xmlAttr(attrs, 'r');
    const index = ref === null ? cells.length : columnIndex(ref);
    cells[index] = cellValue(attrs, body, sharedStrings);
  }
  return cells.map((cell) => cell ?? '');
}

function cellValue(attrs: string, body: string, sharedStrings: ReadonlyArray<string>): string {
  const type = xmlAttr(attrs, 't');
  if (type === 'inlineStr') return textFromXmlFragment(body);
  const raw = firstTagText(body, 'v') ?? firstTagText(body, 't') ?? '';
  if (type === 's') return sharedStrings[Number(raw)] ?? '';
  return decodeXml(raw);
}

function columnIndex(ref: string): number {
  const letters = (ref.match(/^[A-Z]+/i)?.[0] ?? '').toUpperCase();
  let index = 0;
  for (const ch of letters) {
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return Math.max(0, index - 1);
}

function firstTagText(xml: string, tag: string): string | null {
  const match = new RegExp(`<x?:?${tag}\\b[^>]*>([\\s\\S]*?)<\\/x?:?${tag}>`).exec(xml);
  return match?.[1] === undefined ? null : decodeXml(match[1]);
}

function textFromXmlFragment(xml: string): string {
  const parts: string[] = [];
  const textPattern = /<x?:?t\b[^>]*>([\s\S]*?)<\/x?:?t>/g;
  for (const match of xml.matchAll(textPattern)) {
    parts.push(decodeXml(match[1] ?? ''));
  }
  if (parts.length > 0) return parts.join('');
  return decodeXml(xml.replace(/<[^>]+>/g, ''));
}

function xmlAttr(tag: string, name: string): string | null {
  const escaped = name.replace(':', '\\:');
  const match = new RegExp(`\\b${escaped}="([^"]*)"`).exec(tag);
  return match?.[1] === undefined ? null : decodeXml(match[1]);
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, n: string) => String.fromCodePoint(Number.parseInt(n, 16)));
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}
