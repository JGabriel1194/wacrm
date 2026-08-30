import { describe, expect, it } from 'vitest';
import {
  parseContactCsv,
  parseCustomFieldHeader,
  parseTagCell,
} from './parse-contact-csv';

describe('parseTagCell', () => {
  it('splits comma-separated tags and trims whitespace', () => {
    expect(parseTagCell(' VIP , Lead ,  ')).toEqual(['VIP', 'Lead']);
  });

  it('splits semicolon-separated tags', () => {
    expect(parseTagCell('VIP; Lead; Customer')).toEqual([
      'VIP',
      'Lead',
      'Customer',
    ]);
  });

  it('de-dupes case-insensitively', () => {
    expect(parseTagCell('vip, VIP, Lead')).toEqual(['vip', 'Lead']);
  });

  it('returns empty for blank values', () => {
    expect(parseTagCell('')).toEqual([]);
    expect(parseTagCell(undefined)).toEqual([]);
  });
});

describe('parseCustomFieldHeader', () => {
  it('keeps the author casing as the label and lowercases the key', () => {
    expect(parseCustomFieldHeader('cf:Parroquia', 3)).toEqual({
      key: 'parroquia',
      label: 'Parroquia',
      index: 3,
    });
  });

  it('accepts an uppercased prefix and trims around the name', () => {
    expect(parseCustomFieldHeader('CF: Cantón ', 0)).toEqual({
      key: 'cantón',
      label: 'Cantón',
      index: 0,
    });
  });

  it('returns null for non-custom and empty-name headers', () => {
    expect(parseCustomFieldHeader('company', 1)).toBeNull();
    expect(parseCustomFieldHeader('cf:', 1)).toBeNull();
    expect(parseCustomFieldHeader('cf:   ', 1)).toBeNull();
  });
});

describe('parseContactCsv', () => {
  it('parses optional tags column', () => {
    const csv = `phone,name,tags
+15551234567,Alice,"VIP, Lead"
+15559876543,Bob,Customer`;

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: true,
      hasCompanyColumn: false,
      customFieldColumns: [],
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: ['VIP', 'Lead'],
          customValues: {},
        },
        {
          phone: '+15559876543',
          name: 'Bob',
          email: undefined,
          company: undefined,
          tagNames: ['Customer'],
          customValues: {},
        },
      ],
    });
  });

  it('returns empty tagNames when tags column is absent', () => {
    const csv = `phone,name
+15551234567,Alice`;

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: false,
      hasCompanyColumn: false,
      customFieldColumns: [],
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: [],
          customValues: {},
        },
      ],
    });
  });

  it('parses cf: columns into customValues keyed by lowercased name', () => {
    const csv = `phone,name,cf:Parroquia,cf:Cantón
593987654321,Ana,Calderón,Quito`;

    const result = parseContactCsv(csv);

    expect(result.customFieldColumns).toEqual([
      { key: 'parroquia', label: 'Parroquia', index: 2 },
      { key: 'cantón', label: 'Cantón', index: 3 },
    ]);
    expect(result.rows[0].customValues).toEqual({
      parroquia: 'Calderón',
      cantón: 'Quito',
    });
  });

  it('omits blank cf: cells so import never clears an existing value', () => {
    const csv = `phone,cf:Parroquia,cf:Cantón
593987654321,,Quito
593991112233, ,`;

    const rows = parseContactCsv(csv).rows;

    expect(rows[0].customValues).toEqual({ cantón: 'Quito' });
    expect(rows[1].customValues).toEqual({});
  });

  it('de-dupes repeated cf: columns, keeping the first', () => {
    const csv = `phone,cf:Parroquia,cf:parroquia
593987654321,Calderón,Cumbayá`;

    const result = parseContactCsv(csv);

    expect(result.customFieldColumns).toEqual([
      { key: 'parroquia', label: 'Parroquia', index: 1 },
    ]);
    expect(result.rows[0].customValues).toEqual({ parroquia: 'Calderón' });
  });

  it('ignores a bare cf: header and unknown plain columns', () => {
    const csv = `phone,cf:,notafield
593987654321,x,y`;

    const result = parseContactCsv(csv);

    expect(result.customFieldColumns).toEqual([]);
    expect(result.rows[0].customValues).toEqual({});
  });

  it('reports no custom columns when the phone header is missing', () => {
    const csv = `name,cf:Parroquia
Ana,Calderón`;

    expect(parseContactCsv(csv)).toEqual({
      rows: [],
      hasTagsColumn: false,
      hasCompanyColumn: false,
      customFieldColumns: [],
    });
  });
});
