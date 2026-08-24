import { getRequestConfig } from 'next-intl/server';

export default getRequestConfig(async () => {
  // Locale comes from the environment — one language per deployment.
  //
  // APP_LOCALE is preferred over NEXT_PUBLIC_APP_LOCALE because this
  // module only ever runs on the server, so the value has no reason to
  // reach the browser. Next.js inlines every `NEXT_PUBLIC_*` reference
  // at build time ("your app will no longer respond to changes to these
  // environment variables"), which means a NEXT_PUBLIC_ locale is frozen
  // into the image and changing it requires a full rebuild — a sharp
  // edge on platforms like Coolify, where a runtime-only variable is
  // simply absent during `next build` and the app silently falls back
  // to English.
  //
  // Without the prefix the lookup happens at request time, so switching
  // languages is an env change plus a restart. NEXT_PUBLIC_APP_LOCALE is
  // still honoured for existing deployments that set it.
  const locale =
    process.env.APP_LOCALE || process.env.NEXT_PUBLIC_APP_LOCALE || 'en';

  let messages;
  try {
    messages = (await import(`../../messages/${locale}.json`)).default;
  } catch {
    // Fallback to English if the dictionary for the requested locale doesn't exist yet
    messages = (await import(`../../messages/en.json`)).default;
  }

  return {
    locale,
    messages
  };
});
