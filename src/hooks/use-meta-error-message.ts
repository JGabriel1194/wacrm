'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';

import { isMetaErrorKey } from '@/lib/whatsapp/meta-error-codes';

/**
 * Turn a failed send response into something an operator can act on.
 *
 * The send routes answer a Meta rejection with `{ error, meta_error }`:
 * `error` is Meta's English developer string ("(#131042) Business
 * eligibility payment issue"), `meta_error` is a stable key for the
 * cases we recognise. This hook prefers the translated key and falls
 * back to the raw string, so an unmapped code still shows *something*.
 *
 * `isKnown` lets the call site drop its own "Failed to send: " prefix
 * when the translated message already reads as a complete sentence.
 */
export function useMetaErrorMessage() {
  const t = useTranslations('WhatsAppErrors');

  return useCallback(
    (
      payload: unknown,
      fallback: string
    ): { message: string; isKnown: boolean } => {
      const body = (payload ?? {}) as { error?: string; meta_error?: string };
      const raw = body.error || fallback;
      if (isMetaErrorKey(body.meta_error) && body.meta_error !== 'unknown') {
        // `detail` is only interpolated by the messages that keep the
        // raw text (invalidParameter); the rest ignore it.
        return { message: t(body.meta_error, { detail: raw }), isKnown: true };
      }
      return { message: raw, isKnown: false };
    },
    [t]
  );
}
