#!/usr/bin/env node
// ============================================================
// Template-send diagnostics — runs from your terminal, against the
// same database and the same Meta account production uses.
//
// It answers the three questions the dashboard's `{ error }` string
// can't: is the access token in the database usable, does the local
// template row match the template Meta actually approved, and does
// the payload we build get accepted.
//
//   node scripts/diagnose-template-send.mjs \
//     --template carreras_istah_2026 --language es \
//     --to +593998463093 --body "Gabriel"
//
// Add --send to actually deliver the message. Without it nothing
// leaves your machine except read-only GETs.
//
// Reads .env.local (SUPABASE_SERVICE_ROLE_KEY + ENCRYPTION_KEY), so
// run it from the repo root. No secrets are printed — tokens and keys
// appear only as fingerprints.
// ============================================================

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const META_API_VERSION = 'v21.0';
const GRAPH = `https://graph.facebook.com/${META_API_VERSION}`;

// ---------- args ----------
const args = process.argv.slice(2);
function arg(name, fallback = undefined) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--')
    ? args[i + 1]
    : fallback;
}
const flag = (name) => args.includes(`--${name}`);

const templateName = arg('template');
const language = arg('language', 'es');
const to = arg('to');
const bodyValues = args
  .map((a, i) => (a === '--body' ? args[i + 1] : null))
  .filter((v) => v != null);
const headerText = arg('header');
const doSend = flag('send');

if (!templateName) {
  console.error(
    'Usage: node scripts/diagnose-template-send.mjs --template <name> [--language es] [--to +593…] [--body v1 --body v2] [--header v] [--send] [--insecure]'
  );
  process.exit(1);
}

// ---------- env ----------
function loadEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

const env = { ...loadEnv(path.resolve('.env.local')), ...process.env };
const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const ENCRYPTION_KEY = env.ENCRYPTION_KEY;

function fp(secret) {
  if (!secret) return '(missing)';
  const hash = crypto.createHash('sha256').update(secret).digest('hex');
  return `len ${secret.length}, sha256 ${hash.slice(0, 12)}`;
}

const H = (s) =>
  `\n\x1b[1m── ${s} ${'─'.repeat(Math.max(0, 60 - s.length))}\x1b[0m`;
const ok = (s) => `\x1b[32m✔\x1b[0m ${s}`;
const bad = (s) => `\x1b[31m\u2718\x1b[0m ${s}`;
const warn = (s) => `\x1b[33m▲\x1b[0m ${s}`;

console.log(H('environment'));
console.log(`  supabase url      ${SUPABASE_URL ?? '(missing)'}`);
console.log(`  service role key  ${fp(SERVICE_KEY)}`);
console.log(`  encryption key    ${fp(ENCRYPTION_KEY)}`);
console.log(
  '  → compare these fingerprints with the values set in Coolify.\n' +
    '    A different ENCRYPTION_KEY is the single most common reason a\n' +
    '    send works in one environment and not the other: the token in\n' +
    '    the database only decrypts with the key that encrypted it.'
);

if (!SUPABASE_URL || !SERVICE_KEY || !ENCRYPTION_KEY) {
  console.error(bad('Missing env vars — run this from the repo root.'));
  process.exit(1);
}

// ---------- decrypt (mirrors src/lib/whatsapp/encryption.ts) ----------
function decrypt(encryptedText) {
  const parts = encryptedText.split(':');
  const key = Buffer.from(ENCRYPTION_KEY, 'hex');
  if (parts.length === 3) {
    const [ivHex, ctHex, tagHex] = parts;
    const d = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(ivHex, 'hex')
    );
    d.setAuthTag(Buffer.from(tagHex, 'hex'));
    return d.update(ctHex, 'hex', 'utf8') + d.final('utf8');
  }
  if (parts.length === 2) {
    const [ivHex, ctHex] = parts;
    const d = crypto.createDecipheriv(
      'aes-256-cbc',
      key,
      Buffer.from(ivHex, 'hex')
    );
    return d.update(ctHex, 'hex', 'utf8') + d.final('utf8');
  }
  throw new Error(
    `unrecognised ciphertext format (${parts.length - 1} colons)`
  );
}

// ---------- network ----------
// Meta is reached over the public internet; a TLS-inspecting proxy (common
// on institutional networks) makes Node reject the connection outright with
// UNABLE_TO_VERIFY_LEAF_SIGNATURE, long before any Meta error exists. Report
// that as the network problem it is instead of a bare "fetch failed".
if (flag('insecure')) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  console.log(
    '\n\x1b[33m▲ --insecure: TLS verification disabled for this run. Diagnostics only.\x1b[0m'
  );
}

async function graphFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    const cause = err?.cause;
    const code = cause?.code ?? '';
    console.log(
      `\x1b[31m\u2718\x1b[0m Could not reach ${new URL(url).host}: ${cause?.message ?? err.message}`
    );
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) {
      console.log(
        '\n  Node refused the certificate chain. Something between you and Meta is\n' +
          '  terminating TLS — a corporate/campus firewall, a VPN, or an antivirus\n' +
          '  with HTTPS scanning. macOS trusts its CA, Node does not (it ships its\n' +
          '  own root store). Three ways forward:\n\n' +
          '    1. Point Node at that CA (the correct fix):\n' +
          '         NODE_EXTRA_CA_CERTS=/path/to/proxy-ca.pem node scripts/…\n' +
          '       Export it from Keychain Access → System → the CA your proxy uses.\n' +
          '    2. Re-run with --insecure to skip verification (diagnostics only,\n' +
          '       never in the app).\n' +
          '    3. Run from a network that does not intercept, e.g. a phone hotspot.\n\n' +
          '  Inspect who signed it with:\n' +
          '    openssl s_client -connect graph.facebook.com:443 \\\n' +
          '      -servername graph.facebook.com </dev/null 2>/dev/null \\\n' +
          '      | openssl x509 -noout -issuer -subject\n'
      );
    } else if (code) {
      console.log(`  (${code})`);
    }
    process.exit(1);
  }
}

// ---------- postgrest ----------
async function db(pathname) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Accept: 'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`PostgREST ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

const VAR_RE = /\{\{\s*(\d+)\s*\}\}/g;
const varCount = (s) =>
  new Set([...String(s ?? '').matchAll(VAR_RE)].map((m) => m[1])).size;

// ---------- 1. whatsapp_config ----------
console.log(H('whatsapp_config'));
const configs = await db('whatsapp_config?select=*');
if (configs.length === 0) {
  console.log(bad('No rows — WhatsApp is not configured.'));
  process.exit(1);
}
console.log(`  ${configs.length} row(s)`);

let active = null;
for (const c of configs) {
  const shape =
    c.access_token.split(':').length === 3
      ? 'GCM'
      : c.access_token.split(':').length === 2
        ? 'CBC (legacy)'
        : 'unknown';
  let token = null;
  let decErr = null;
  try {
    token = decrypt(c.access_token);
  } catch (e) {
    decErr = e.message;
  }
  console.log(
    `\n  account_id       ${c.account_id ?? '(null)'}\n` +
      `  phone_number_id  ${c.phone_number_id}\n` +
      `  waba_id          ${c.waba_id ?? '(null)'}\n` +
      `  status           ${c.status}\n` +
      `  token ciphertext ${shape}\n` +
      `  decrypt          ${decErr ? bad(decErr) : ok(fp(token))}`
  );
  if (!decErr && !active) active = { ...c, token };
}

if (!active) {
  console.log(
    bad(
      '\nNo config row decrypts with this ENCRYPTION_KEY. That alone breaks every send.\n' +
        '  Fix: use the key that encrypted the token, or re-connect WhatsApp in Settings\n' +
        '  so the token is re-encrypted with the current key.'
    )
  );
  process.exit(1);
}

// ---------- 2. token against Graph ----------
console.log(H('token → Graph'));
{
  const res = await graphFetch(
    `${GRAPH}/${active.phone_number_id}?fields=id,display_phone_number,verified_name,quality_rating`,
    { headers: { Authorization: `Bearer ${active.token}` } }
  );
  const bodyJson = await res.json().catch(() => ({}));
  if (res.ok) {
    console.log(
      ok(
        `${bodyJson.display_phone_number} — ${bodyJson.verified_name ?? '?'} (quality ${bodyJson.quality_rating ?? '?'})`
      )
    );
  } else {
    console.log(bad(`HTTP ${res.status} — ${JSON.stringify(bodyJson)}`));
    console.log(
      '  code 190 → token expired or invalid. code 100/subcode 33 → the token\n' +
        '  has no access to this phone_number_id.'
    );
  }
}

// ---------- 3. local rows ----------
console.log(H(`local message_templates "${templateName}"`));
const rows = await db(
  `message_templates?select=*&name=eq.${encodeURIComponent(templateName)}`
);
if (rows.length === 0) {
  console.log(bad('No local row with that name at all.'));
} else {
  for (const r of rows) {
    const match = r.language === language;
    console.log(
      `  ${match ? '→' : ' '} language ${String(r.language).padEnd(8)} status ${String(r.status).padEnd(10)} header ${String(r.header_type ?? 'none').padEnd(9)} body_vars ${varCount(r.body_text)} buttons ${(r.buttons ?? []).length}`
    );
    if (
      match &&
      r.header_type &&
      r.header_type !== 'text' &&
      !r.header_media_url
    ) {
      console.log(
        warn(
          `    ${r.header_type} header with no header_media_url — every send of this template fails at Meta.`
        )
      );
    }
  }
  if (!rows.some((r) => r.language === language)) {
    console.log(
      bad(
        `No row for language "${language}" — the send degrades to a body-only payload,\n` +
          `  which Meta rejects for any template with a media header or a variable URL button.`
      )
    );
  }
}

// ---------- 4. what Meta actually approved ----------
console.log(H('template as approved by Meta'));
let metaTemplate = null;
if (!active.waba_id) {
  console.log(
    warn('No waba_id on the config row — skipping (set it in Settings).')
  );
} else {
  const res = await graphFetch(
    `${GRAPH}/${active.waba_id}/message_templates?name=${encodeURIComponent(templateName)}&limit=50`,
    { headers: { Authorization: `Bearer ${active.token}` } }
  );
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.log(bad(`HTTP ${res.status} — ${JSON.stringify(payload)}`));
  } else if (!payload.data?.length) {
    console.log(bad('Meta has no template with that name on this WABA.'));
  } else {
    for (const t of payload.data) {
      const match = t.language === language;
      console.log(
        `  ${match ? '→' : ' '} language ${String(t.language).padEnd(8)} status ${String(t.status).padEnd(10)} category ${t.category}`
      );
      if (match) metaTemplate = t;
    }
    if (!metaTemplate) {
      console.log(
        bad(
          `Meta has no "${templateName}" in "${language}". Language codes must match exactly\n` +
            `  (es ≠ es_ES ≠ es_MX) — this is error 132001.`
        )
      );
    } else if (metaTemplate.status !== 'APPROVED') {
      console.log(
        bad(
          `Status is ${metaTemplate.status} — only APPROVED templates can be sent.`
        )
      );
    } else {
      console.log('\n  components:');
      for (const c of metaTemplate.components ?? []) {
        if (c.type === 'HEADER') {
          console.log(
            `    HEADER  format ${c.format}  vars ${varCount(c.text)}`
          );
        } else if (c.type === 'BODY') {
          console.log(`    BODY    vars ${varCount(c.text)}`);
          console.log(
            `            "${String(c.text).replace(/\n/g, ' ').slice(0, 90)}"`
          );
        } else if (c.type === 'BUTTONS') {
          c.buttons.forEach((b, i) =>
            console.log(
              `    BUTTON ${i}  ${b.type}${b.url ? ` url vars ${varCount(b.url)}` : ''}`
            )
          );
        } else {
          console.log(`    ${c.type}`);
        }
      }
    }
  }
}

// ---------- 5. build the payload from Meta's own definition ----------
if (!metaTemplate || !to) {
  console.log(H('payload'));
  console.log(
    warn(
      !to
        ? 'Pass --to +593… to build (and optionally send) a payload.'
        : 'Skipped — no approved template to build against.'
    )
  );
  process.exit(0);
}

console.log(H('payload'));
const components = [];
const header = (metaTemplate.components ?? []).find((c) => c.type === 'HEADER');
const bodyComp = (metaTemplate.components ?? []).find((c) => c.type === 'BODY');
const buttonsComp = (metaTemplate.components ?? []).find(
  (c) => c.type === 'BUTTONS'
);

if (header) {
  if (header.format === 'TEXT' && varCount(header.text) > 0) {
    if (!headerText) {
      console.log(
        bad(
          `Header declares ${varCount(header.text)} variable(s) — pass --header <value>.`
        )
      );
      process.exit(1);
    }
    components.push({
      type: 'header',
      parameters: [{ type: 'text', text: headerText }],
    });
  } else if (header.format !== 'TEXT') {
    const localRow = rows.find((r) => r.language === language);
    const link = localRow?.header_media_url;
    if (!link) {
      console.log(
        bad(
          `Template has a ${header.format} header but the local row has no header_media_url.\n` +
            '  Meta requires the media component on every send — this send cannot succeed\n' +
            '  until header_media_url is set (a public https URL, not a header_handle).'
        )
      );
      process.exit(1);
    }
    const kind = header.format.toLowerCase();
    components.push({
      type: 'header',
      parameters: [{ type: kind, [kind]: { link } }],
    });
  }
}

const needed = varCount(bodyComp?.text);
if (bodyValues.length < needed) {
  console.log(
    bad(
      `Body declares ${needed} variable(s) but you passed ${bodyValues.length} (--body). This is error 132000.`
    )
  );
  process.exit(1);
}
if (needed > 0) {
  components.push({
    type: 'body',
    parameters: bodyValues
      .slice(0, needed)
      .map((text) => ({ type: 'text', text })),
  });
}

(buttonsComp?.buttons ?? []).forEach((b, i) => {
  if (b.type === 'URL' && varCount(b.url) > 0) {
    console.log(
      warn(
        `Button ${i} has a {{1}} URL suffix — this script does not fill it; the send will fail with 132012.`
      )
    );
  }
});

const payload = {
  messaging_product: 'whatsapp',
  recipient_type: 'individual',
  to: to.replace(/[^\d]/g, ''),
  type: 'template',
  template: {
    name: templateName,
    language: { code: language },
    ...(components.length ? { components } : {}),
  },
};
console.log(JSON.stringify(payload, null, 2));

if (!doSend) {
  console.log(`\n${warn('Dry run — nothing sent. Add --send to deliver it.')}`);
  process.exit(0);
}

console.log(H('POST /messages'));
const sendRes = await graphFetch(
  `${GRAPH}/${active.phone_number_id}/messages`,
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${active.token}`,
    },
    body: JSON.stringify(payload),
  }
);
const sendText = await sendRes.text();
console.log(`  HTTP ${sendRes.status}`);
console.log(`  ${sendText}`);
if (sendRes.ok) {
  console.log(
    `\n${ok('Meta accepted it. If the message never arrives, the problem is delivery (24h window, opt-in, number quality), not the payload.')}`
  );
}
