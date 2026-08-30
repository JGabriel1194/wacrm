/**
 * CSV parsing for the contacts import modal. Shared + unit-tested so
 * tag-column handling stays aligned with phone/name/email/company.
 */

export interface ParsedContactRow {
  phone: string;
  name?: string;
  email?: string;
  company?: string;
  /** Tag names from the optional `tags` column (comma/semicolon separated). */
  tagNames: string[];
  /**
   * Custom field values from `cf:<name>` columns, keyed by the lowercased
   * field name. Only non-empty cells are present, so a blank cell leaves
   * the contact's existing value alone rather than clearing it.
   */
  customValues: Record<string, string>;
}

/** Header prefix that marks a column as a custom contact field. */
export const CUSTOM_FIELD_PREFIX = 'cf:';

/**
 * Custom field column declared by the CSV header.
 *
 * `key` is the lowercased name used to match `custom_fields.field_name`;
 * `label` keeps the author's original casing for the preview table and
 * for creating the field definition when it doesn't exist yet.
 */
export interface CustomFieldColumn {
  key: string;
  label: string;
  index: number;
}

/**
 * Parse a `cf:<name>` header into a custom field column, or null when the
 * header isn't a custom field (or is `cf:` with nothing after it).
 */
export function parseCustomFieldHeader(
  header: string,
  index: number
): CustomFieldColumn | null {
  const trimmed = header.trim();
  if (!trimmed.toLowerCase().startsWith(CUSTOM_FIELD_PREFIX)) return null;
  const label = trimmed.slice(CUSTOM_FIELD_PREFIX.length).trim();
  if (!label) return null;
  return { key: label.toLowerCase(), label, index };
}

/** Split a CSV cell into unique tag names (case-insensitive de-dupe). */
export function parseTagCell(value: string | undefined): string[] {
  if (!value?.trim()) return [];

  const seen = new Set<string>();
  const names: string[] = [];

  for (const part of value.split(/[,;]/)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return names;
}

export interface ParseContactCsvResult {
  rows: ParsedContactRow[];
  /** True when the CSV header includes a `tags` column. */
  hasTagsColumn: boolean;
  /** True when the CSV header includes a `company` column. */
  hasCompanyColumn: boolean;
  /**
   * `cf:<name>` columns declared by the header, in header order and
   * de-duped by lowercased name (first occurrence wins).
   */
  customFieldColumns: CustomFieldColumn[];
}

export function parseContactCsv(text: string): ParseContactCsvResult {
  const empty: ParseContactCsvResult = {
    rows: [],
    hasTagsColumn: false,
    hasCompanyColumn: false,
    customFieldColumns: [],
  };

  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return empty;

  // Two views of the header row: `headers` is lowercased for matching the
  // fixed column names, `rawHeaders` keeps the author's casing so a
  // `cf:Parroquia` column creates a field named "Parroquia", not "parroquia".
  const rawHeaders = lines[0]
    .split(',')
    .map((h) => h.trim().replace(/["']/g, ''));
  const headers = rawHeaders.map((h) => h.toLowerCase());

  const phoneIdx = headers.indexOf('phone');
  if (phoneIdx === -1) return empty;

  const nameIdx = headers.indexOf('name');
  const emailIdx = headers.indexOf('email');
  const companyIdx = headers.indexOf('company');
  const tagsIdx = headers.indexOf('tags');

  // `cf:` columns, de-duped by lowercased name so a CSV that repeats a
  // field doesn't fight itself over which cell wins.
  const customFieldColumns: CustomFieldColumn[] = [];
  const seenCustomKeys = new Set<string>();
  for (let i = 0; i < headers.length; i++) {
    const column = parseCustomFieldHeader(rawHeaders[i], i);
    if (!column || seenCustomKeys.has(column.key)) continue;
    seenCustomKeys.add(column.key);
    customFieldColumns.push(column);
  }

  const rows: ParsedContactRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = parseCsvLine(line);
    const phone = values[phoneIdx]?.replace(/["']/g, '').trim();
    if (!phone) continue;

    rows.push({
      phone,
      name:
        nameIdx >= 0
          ? values[nameIdx]?.replace(/["']/g, '').trim() || undefined
          : undefined,
      email:
        emailIdx >= 0
          ? values[emailIdx]?.replace(/["']/g, '').trim() || undefined
          : undefined,
      company:
        companyIdx >= 0
          ? values[companyIdx]?.replace(/["']/g, '').trim() || undefined
          : undefined,
      tagNames:
        tagsIdx >= 0 ? parseTagCell(values[tagsIdx]?.replace(/["']/g, '')) : [],
      customValues: readCustomValues(values, customFieldColumns),
    });
  }

  return {
    rows,
    hasTagsColumn: tagsIdx >= 0,
    hasCompanyColumn: companyIdx >= 0,
    customFieldColumns,
  };
}

/**
 * Collect the non-empty `cf:` cells of one row, keyed by field name.
 *
 * Blank cells are omitted on purpose: import should not overwrite a
 * value that already exists on the contact with an empty string.
 */
function readCustomValues(
  values: string[],
  columns: CustomFieldColumn[]
): Record<string, string> {
  const customValues: Record<string, string> = {};

  for (const column of columns) {
    const value = values[column.index]?.replace(/["']/g, '').trim();
    if (!value) continue;
    customValues[column.key] = value;
  }

  return customValues;
}

/** Simple CSV line parse (handles quoted fields). */
function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (const char of line) {
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim());
  return values;
}
