// ============================================================
// Meta error code → i18n key.
//
// Graph answers a refused send with a numeric `error.code` and a
// developer-facing English string. Neither belongs in front of an
// operator: "(#131042) Business eligibility payment issue" tells them
// nothing about what to do, and it is not translatable.
//
// This module maps the codes we can act on to a stable key. The send
// path attaches the key to its error, the route puts it on the wire as
// `meta_error`, and the UI renders `WhatsAppErrors.<key>` through
// next-intl. Anything unmapped falls through to `unknown`, where the
// UI still shows Meta's raw message — an unrecognised code should
// degrade to "less friendly", never to "no information".
//
// Pure module: no I/O, no server-only imports, safe to import from a
// client component.
//
// Codes per Meta's Cloud API error reference.
// ============================================================

export const META_ERROR_KEYS = [
  'paymentRequired',
  'tokenExpired',
  'accountRestricted',
  'rateLimited',
  'pairRateLimited',
  'outsideWindow',
  'undeliverable',
  'templateNotFound',
  'templateParamCount',
  'templateParamFormat',
  'templateTextTooLong',
  'templatePaused',
  'templateDisabled',
  'templatePolicy',
  'phoneNotRegistered',
  'invalidParameter',
  'networkUnreachable',
  'unknown',
] as const;

export type MetaErrorKey = (typeof META_ERROR_KEYS)[number];

const BY_CODE: Record<number, MetaErrorKey> = {
  // Account-level blocks — nothing about the message is wrong.
  131042: 'paymentRequired', // Business eligibility payment issue
  190: 'tokenExpired', // Access token expired / invalid
  131031: 'accountRestricted', // WABA locked for a policy violation
  368: 'accountRestricted', // Temporarily blocked for policy violations

  // Throughput.
  4: 'rateLimited', // Application request limit reached
  130429: 'rateLimited', // Cloud API throughput reached
  131056: 'pairRateLimited', // Too many messages to the same recipient

  // Delivery.
  131047: 'outsideWindow', // >24h since the customer last replied
  131026: 'undeliverable', // Recipient can't receive it
  133010: 'phoneNotRegistered', // Sender number not registered on the platform

  // Template-specific.
  132000: 'templateParamCount', // Variable count ≠ template definition
  132001: 'templateNotFound', // No such template in that language / not approved
  132005: 'templateTextTooLong', // Hydrated text over the limit
  132007: 'templatePolicy', // Content violates a WhatsApp policy
  132012: 'templateParamFormat', // Variable values wrongly formatted
  132015: 'templatePaused', // Paused for low quality
  132016: 'templateDisabled', // Permanently disabled for low quality

  // Malformed request.
  100: 'invalidParameter', // Unsupported / misspelled parameter
  131008: 'invalidParameter', // Required parameter missing
  131009: 'invalidParameter', // Parameter value not valid
};

/**
 * Resolve Meta's numeric code to a key the UI can translate.
 * Returns `unknown` for anything unmapped — including `131000`
 * ("something went wrong"), which carries no actionable meaning.
 */
export function metaErrorKey(code?: number, subcode?: number): MetaErrorKey {
  if (code == null) return 'unknown';
  // Subcode 33 on the generic 100 means "object does not exist" — for
  // us that is always a phone_number_id the token can't see, which is
  // a configuration problem rather than a bad parameter.
  if (code === 100 && subcode === 33) return 'phoneNotRegistered';
  return BY_CODE[code] ?? 'unknown';
}

/** Type guard for a value arriving from the wire. */
export function isMetaErrorKey(value: unknown): value is MetaErrorKey {
  return (
    typeof value === 'string' &&
    (META_ERROR_KEYS as readonly string[]).includes(value)
  );
}
