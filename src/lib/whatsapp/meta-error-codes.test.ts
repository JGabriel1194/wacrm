import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  META_ERROR_KEYS,
  isMetaErrorKey,
  metaErrorKey,
  type MetaErrorKey,
} from './meta-error-codes';

describe('metaErrorKey', () => {
  it('maps the billing block that stops every business-initiated send', () => {
    expect(metaErrorKey(131042)).toBe('paymentRequired');
  });

  it('maps template rejections to their specific keys', () => {
    expect(metaErrorKey(132000)).toBe('templateParamCount');
    expect(metaErrorKey(132001)).toBe('templateNotFound');
    expect(metaErrorKey(132012)).toBe('templateParamFormat');
    expect(metaErrorKey(132015)).toBe('templatePaused');
    expect(metaErrorKey(132016)).toBe('templateDisabled');
  });

  it('reads subcode 33 on the generic 100 as a phone-number problem', () => {
    // Meta returns (#100) "Object does not exist" when the token cannot
    // see the phone_number_id — a configuration fault, not a bad param.
    expect(metaErrorKey(100, 33)).toBe('phoneNotRegistered');
    expect(metaErrorKey(100)).toBe('invalidParameter');
  });

  it('falls back to unknown for unmapped or absent codes', () => {
    expect(metaErrorKey(131000)).toBe('unknown'); // "something went wrong"
    expect(metaErrorKey(999999)).toBe('unknown');
    expect(metaErrorKey(undefined)).toBe('unknown');
  });
});

describe('isMetaErrorKey', () => {
  it('accepts every declared key and nothing else', () => {
    for (const key of META_ERROR_KEYS) expect(isMetaErrorKey(key)).toBe(true);
    expect(isMetaErrorKey('paymentrequired')).toBe(false);
    expect(isMetaErrorKey(131042)).toBe(false);
    expect(isMetaErrorKey(undefined)).toBe(false);
  });
});

describe('i18n coverage', () => {
  // The UI calls t(key) with a key produced at runtime. A key missing
  // from a locale throws inside next-intl at render time — on the exact
  // screen you're already debugging. Catch it here instead.
  const LOCALES = ['en', 'es', 'ko'] as const;

  function messages(locale: string): Record<string, string> {
    const file = path.join(process.cwd(), 'messages', `${locale}.json`);
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      WhatsAppErrors?: Record<string, string>;
    };
    return parsed.WhatsAppErrors ?? {};
  }

  it.each(LOCALES)('%s defines every Meta error key', (locale) => {
    const dict = messages(locale);
    const missing = META_ERROR_KEYS.filter((k) => !dict[k]);
    expect(missing).toEqual([]);
  });

  it.each(LOCALES)('%s declares no key we cannot produce', (locale) => {
    const extra = Object.keys(messages(locale)).filter(
      (k) => !(META_ERROR_KEYS as readonly string[]).includes(k)
    );
    expect(extra).toEqual([]);
  });

  it('keeps {detail} only where the raw Meta text is still useful', () => {
    const withDetail: MetaErrorKey[] = ['invalidParameter', 'unknown'];
    for (const locale of LOCALES) {
      const dict = messages(locale);
      for (const key of META_ERROR_KEYS) {
        expect(dict[key].includes('{detail}')).toBe(withDetail.includes(key));
      }
    }
  });
});
