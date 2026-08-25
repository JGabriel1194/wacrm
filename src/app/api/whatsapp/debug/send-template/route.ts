import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import { buildTemplateSendPayload } from '@/lib/whatsapp/meta-api';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import type { MessageTemplate } from '@/types';

// ============================================================
// Template-send diagnostics.
//
// The normal send path collapses every failure into a single
// `{ error }` string, which is not enough to debug a production-only
// template rejection: you can't see what we looked up locally, what
// payload we built, or what Meta actually answered.
//
// This route reproduces the send step by step and returns all three:
//
//   POST /api/whatsapp/debug/send-template
//   {
//     "template_name": "order_update",
//     "template_language": "es",          // optional
//     "to": "+593987654321",              // or "contact_id"
//     "params": { "body": ["Gabriel"], "headerText": "...", "buttonParams": {} },
//     "send": false                        // true → actually delivers
//   }
//
// With `send: false` (the default) NOTHING is delivered: you get the
// exact JSON we would have POSTed to Graph, so a builder-side problem
// (missing body value, media header without a URL) is visible without
// spending a message. With `send: true` the request goes to Meta and
// the raw HTTP status + raw response body come back verbatim —
// including `error.error_data.details` and `fbtrace_id`.
//
// Admin-only, and the access token is never echoed back (only a
// fingerprint, so you can tell "wrong token" from "expired token").
// ============================================================

const META_API_VERSION = 'v21.0';

interface DebugBody {
  template_name?: string;
  template_language?: string;
  to?: string;
  contact_id?: string;
  params?: {
    body?: string[];
    headerText?: string;
    headerMediaUrl?: string;
    headerMediaId?: string;
    buttonParams?: Record<number, string>;
  };
  send?: boolean;
}

/** Token fingerprint — enough to compare, useless to steal. */
function fingerprint(token: string): string {
  if (!token) return '(empty)';
  return `${token.slice(0, 6)}…${token.slice(-4)} (len ${token.length})`;
}

export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }

  const { supabase, accountId } = ctx;
  const report: Record<string, unknown> = {
    step: 'start',
    account_id: accountId,
    node_env: process.env.NODE_ENV,
    meta_api_version: META_API_VERSION,
  };

  try {
    const body = (await request.json()) as DebugBody;
    const templateName = body.template_name;
    if (!templateName) {
      return NextResponse.json(
        { error: 'template_name is required', report },
        { status: 400 }
      );
    }

    // ---- 1. WhatsApp config -------------------------------------
    report.step = 'config';
    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single();

    if (configError || !config) {
      report.config = { found: false, error: configError?.message ?? null };
      return NextResponse.json(
        { ok: false, reason: 'whatsapp_not_configured', report },
        { status: 200 }
      );
    }

    let accessToken = '';
    let decryptError: string | null = null;
    try {
      accessToken = decrypt(config.access_token);
    } catch (err) {
      decryptError = err instanceof Error ? err.message : String(err);
    }

    report.config = {
      found: true,
      phone_number_id: config.phone_number_id,
      waba_id: config.waba_id ?? null,
      status: config.status,
      access_token: decryptError ? null : fingerprint(accessToken),
      decrypt_error: decryptError,
    };

    if (decryptError) {
      return NextResponse.json(
        { ok: false, reason: 'token_decrypt_failed', report },
        { status: 200 }
      );
    }

    // ---- 2. Recipient --------------------------------------------
    report.step = 'recipient';
    let rawPhone = body.to ?? null;
    if (!rawPhone && body.contact_id) {
      const { data: contact } = await supabase
        .from('contacts')
        .select('phone')
        .eq('id', body.contact_id)
        .eq('account_id', accountId)
        .maybeSingle();
      rawPhone = contact?.phone ?? null;
    }
    const sanitized = rawPhone ? sanitizePhoneForMeta(rawPhone) : null;
    report.recipient = {
      raw: rawPhone,
      sanitized,
      valid_e164: sanitized ? isValidE164(sanitized) : false,
    };

    // ---- 3. Local template row ------------------------------------
    report.step = 'template_row';
    const language = body.template_language || 'en_US';

    // Every language we hold for this name — a send that silently
    // degrades usually means the row exists under another language
    // code (`es` vs `es_ES` vs `en_US`).
    const { data: allRows } = await supabase
      .from('message_templates')
      .select('id, name, language, status, header_type, meta_template_id')
      .eq('account_id', accountId)
      .eq('name', templateName);

    const { data: row } = await supabase
      .from('message_templates')
      .select('*')
      .eq('account_id', accountId)
      .eq('name', templateName)
      .eq('language', language)
      .maybeSingle();

    report.template_lookup = {
      requested: { name: templateName, language },
      languages_available: (allRows ?? []).map((r) => ({
        language: r.language,
        status: r.status,
        header_type: r.header_type,
        meta_template_id: r.meta_template_id,
      })),
      exact_match: row ? true : false,
      row_shape_valid: row ? isMessageTemplate(row) : null,
    };

    if (!row) {
      report.warning =
        'No local row for that name+language. The send falls back to a body-only payload, which Meta rejects for templates with a media header or URL buttons.';
    }

    const template: MessageTemplate | undefined =
      row && isMessageTemplate(row) ? row : undefined;

    if (template) {
      report.template = {
        status: template.status,
        header_type: template.header_type ?? null,
        header_media_url: template.header_media_url ?? null,
        header_vars: extractVariableIndices(template.header_content ?? '')
          .length,
        body_vars: extractVariableIndices(template.body_text).length,
        buttons: (template.buttons ?? []).map((b, i) => ({
          index: i,
          type: b.type,
          has_url_variable:
            b.type === 'URL' ? extractVariableIndices(b.url).length > 0 : false,
        })),
      };
    }

    // ---- 4. Build the payload -------------------------------------
    report.step = 'build_payload';
    let payload: Record<string, unknown>;
    try {
      payload = buildTemplateSendPayload({
        to: sanitized ?? 'MISSING_RECIPIENT',
        templateName,
        language,
        template,
        messageParams: body.params,
        params: body.params?.body,
      });
    } catch (err) {
      report.build_error = err instanceof Error ? err.message : String(err);
      return NextResponse.json(
        { ok: false, reason: 'payload_build_failed', report },
        { status: 200 }
      );
    }
    report.payload = payload;

    // ---- 5. Optionally hit Meta ------------------------------------
    if (!body.send) {
      report.step = 'dry_run';
      return NextResponse.json(
        {
          ok: true,
          sent: false,
          note: 'Dry run — nothing was delivered. Re-POST with "send": true to hit Meta.',
          report,
        },
        { status: 200 }
      );
    }

    if (!sanitized || !isValidE164(sanitized)) {
      return NextResponse.json(
        { ok: false, reason: 'invalid_recipient', report },
        { status: 200 }
      );
    }

    report.step = 'meta_call';
    const url = `https://graph.facebook.com/${META_API_VERSION}/${config.phone_number_id}/messages`;
    const started = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep the raw text */
    }

    report.meta_response = {
      http_status: response.status,
      ok: response.ok,
      elapsed_ms: Date.now() - started,
      body: parsed,
    };

    return NextResponse.json(
      { ok: response.ok, sent: response.ok, report },
      { status: 200 }
    );
  } catch (err) {
    report.unexpected_error = err instanceof Error ? err.message : String(err);
    console.error('[debug/send-template] unexpected error:', err);
    return NextResponse.json({ ok: false, report }, { status: 500 });
  }
}
