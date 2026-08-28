# Debugging template sends in production

Template sends are the one path where almost everything that can go
wrong goes wrong _at Meta_, not in our code — and the failure is
environment-specific: the template row, the access token, the phone
number id and the approved template all live in the production
account. Reproducing it locally usually means reproducing nothing.

This document describes what the server now logs, and the diagnostics
endpoint that lets you inspect a send without shell access.

---

## 1. What the logs contain

Three log lines matter. All of them go to stdout, so on Coolify they
appear under the application's **Logs** tab (or
`docker logs -f <container>` on the host).

| Prefix                                              | When                         | What it tells you                                                                             |
| --------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------- |
| `[meta-api] <status> from Graph:`                   | Any Graph rejection          | Meta's **full** error envelope, including `error.error_data.details` and `fbtrace_id`         |
| `[meta-api] template send rejected — payload:`      | A template send Meta refused | The exact JSON body we POSTed                                                                 |
| `[send-message] Meta send failed for all variants:` | Same send, our side          | account / conversation / template name + language, and whether a local template row was found |

A fourth line appears when the local catalog and the send disagree:

```
[send-message] no local template row for "order_update" (es) in account … — sending body-only payload
```

That one is worth treating as an error. Without a local row the send
degrades to a body-only payload, and Meta rejects it outright for any
template with a media header or a variable URL button. The usual cause
is a language-code mismatch (`es` vs `es_ES` vs `en_US`) between the
row we store and the value the caller passes — run **Settings → Sync
from Meta** and compare.

### Verbose mode

Set `WHATSAPP_DEBUG=true` in the environment to also log every
outgoing payload on the **success** path:

```
[wa-debug] POST /messages (template) {"url":"…","body":{…}}
```

Leave it off by default — these lines contain recipient phone numbers.

---

## 2. The diagnostics endpoint

```
POST /api/whatsapp/debug/send-template
```

Admin role required. It walks the same steps the real send does and
returns a report instead of an `{ error }` string.

Dry run (nothing is delivered):

```bash
curl -X POST https://<your-host>/api/whatsapp/debug/send-template \
  -H 'Content-Type: application/json' \
  -b 'sb-access-token=…; sb-refresh-token=…' \
  -d '{
        "template_name": "order_update",
        "template_language": "es",
        "to": "+593987654321",
        "params": { "body": ["Gabriel"] }
      }'
```

The easiest way to send it authenticated is from the browser devtools
console while logged into the dashboard — the session cookie rides
along automatically:

```js
await fetch('/api/whatsapp/debug/send-template', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    template_name: 'order_update',
    template_language: 'es',
    to: '+593987654321',
    params: { body: ['Gabriel'] },
  }),
})
  .then((r) => r.json())
  .then(console.log);
```

The report has five sections:

- **`config`** — phone number id, WABA id, connection status, and a
  token _fingerprint_ (`EAAG12…9f0c (len 211)`). The token itself is
  never returned. `decrypt_error` non-null means `ENCRYPTION_KEY`
  differs from the one the token was stored with — a classic
  "works in one environment, not the other".
- **`recipient`** — the raw phone, the sanitized E.164 form, and
  whether it passes validation.
- **`template_lookup`** — every language we hold for that template
  name, and whether the requested one matched exactly.
- **`template`** — header type, header media URL, how many variables
  the header and body declare, and each button with whether its URL
  carries a `{{1}}`. Compare these counts against the values you pass.
- **`payload`** — the exact JSON we would POST to Graph. A
  builder-side failure (`Body has 2 variable(s) but only 1 value(s)
were supplied`) surfaces here as `build_error`, before any network
  call.

Add `"send": true` to actually deliver. The response then also carries
`meta_response` with the raw HTTP status and Meta's verbatim body —
which is where `error.error_data.details` and `fbtrace_id` live.

---

## 3. The errors Meta returns most often

| Code                 | Meaning                                  | Where to look                                                                             |
| -------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `132000`             | Parameter count mismatch                 | `template.body_vars` vs the length of `params.body` in the report                         |
| `132001`             | Template does not exist in this language | `template_lookup.languages_available` — and the template must be APPROVED                 |
| `132005`             | Translated text too long                 | A body variable expanded past Meta's limit                                                |
| `132012`             | Parameter format mismatch                | Usually a `{{1}}` URL button suffix, or a media header sent as a handle instead of a link |
| `131047`             | Re-engagement required                   | Outside the 24h window with a non-template message                                        |
| `131026`             | Message undeliverable                    | Recipient not on WhatsApp, or the number is not in the test list                          |
| `100` (subcode `33`) | Object does not exist                    | Wrong `phone_number_id`, or the token has no access to it                                 |
| `190`                | Access token expired/invalid             | `config.access_token` fingerprint — re-connect in Settings                                |

`132012` deserves a note: a template's `header_handle` is a
Resumable-Upload handle valid only as the _creation-time_ sample. It is
not a reusable send-time media id, so the send builder deliberately
ignores it and requires `header_media_url` (or an explicit
`headerMediaId` from a real `/media` upload) instead. A template whose
`header_media_url` is empty will fail every send until it is set.

---

## 4. "Could not reach graph.facebook.com"

If the log shows a `[meta-api] Could not reach graph.facebook.com: …`
line, Meta never answered — this is a transport failure, not a template
problem, and no amount of payload fixing will help.

The cause code tells you which:

| Cause                                                          | Meaning                                                                                                                                                                                                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN` | Something is intercepting HTTPS — a campus/corporate firewall, a VPN, or an antivirus with HTTPS scanning. Node ships its own root store and does not inherit the one macOS or Windows trusts, so the proxy's CA is unknown to it. |
| `ENOTFOUND`, `EAI_AGAIN`                                       | DNS failure                                                                                                                                                                                                                        |
| `ECONNREFUSED`, `ETIMEDOUT`                                    | No outbound route to Meta                                                                                                                                                                                                          |

For the TLS case, the fix in order of preference:

1. Point Node at the intercepting CA — export it from Keychain Access
   (macOS) and run with `NODE_EXTRA_CA_CERTS=/path/to/proxy-ca.pem`.
2. Work from a network that does not intercept (a phone hotspot).
3. `NODE_TLS_REJECT_UNAUTHORIZED=0` — diagnostics only, never in the
   app, and never in production.

Identify the signer with:

```bash
openssl s_client -connect graph.facebook.com:443 \
  -servername graph.facebook.com </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -subject
```

An issuer that is not DigiCert (Meta's CA) is your interceptor.

This is the usual reason template sends "work in production but not in
development": the production host reaches Meta directly, the dev machine
sits behind the proxy.

---

## 5. Diagnosing from your own terminal

`scripts/diagnose-template-send.mjs` runs the same checks without a
deploy, against whichever database `.env.local` points at:

```bash
node scripts/diagnose-template-send.mjs \
  --template carreras_istah_2026 --language es \
  --to +593998463093 --body "Gabriel"
```

It prints fingerprints (never values) of `ENCRYPTION_KEY` and the
service-role key so you can compare them against the deployed
environment, tries to decrypt every `whatsapp_config` token, verifies
the token against Graph, lists the template's local rows next to the
definition Meta actually approved, and builds the payload. Add `--send`
to deliver, `--insecure` to skip TLS verification when a proxy is in the
way.

---

## 6. What the operator sees

A rejection no longer reaches the UI as Meta's English developer string.
`src/lib/whatsapp/meta-error-codes.ts` maps the codes we can act on to a
stable key; the send route puts it on the wire as `meta_error`, and
`useMetaErrorMessage` renders `WhatsAppErrors.<key>` through next-intl
(en / es / ko).

So `(#131042) Business eligibility payment issue` becomes:

> Meta is blocking business-initiated messages: this WhatsApp Business
> account has no valid payment method. Add one in Meta Business Manager
> and settle any outstanding balance.

An unmapped code still shows Meta's raw text — degrading to "less
friendly", never to "no information". `meta-error-codes.test.ts` asserts
that every key exists in all three locales, so a half-translated key
fails in CI rather than at render time on the screen you're debugging.

To add a code: add it to `BY_CODE`, add the key to `META_ERROR_KEYS`,
and add the message to all three files in `messages/`. The test will
tell you if you missed one.

---

## 7. The failure that never touches the response

Most outbound failures are **asynchronous**. `POST /messages` returns
200 with a wamid, the message is stored as `sent`, and only later does a
status webhook arrive:

```json
"statuses": [{
  "id": "wamid…",
  "status": "failed",
  "errors": [{ "code": 131042, "title": "Business eligibility payment issue" }]
}]
```

Nothing about that reaches the browser response, so no toast can ever
fire for it. Before migration 037 the handler copied `status` onto the
row and dropped `errors` entirely — the bubble went red and the reason
existed nowhere: not in the UI, not in the logs, not in the database.

Now `handleStatusUpdate` logs the whole thing as `[webhook] message
failed:` and persists `error_code` + `error_message` on the row, and the
bubble renders the translated reason underneath itself.

So there are two distinct paths, and it matters which one you're
debugging:

| Symptom                                          | Path                                              | Where the reason is                                                  |
| ------------------------------------------------ | ------------------------------------------------- | -------------------------------------------------------------------- |
| Toast on send, request is 502                    | Synchronous — Meta refused the API call           | Response `meta_error`, and `[meta-api]` in the logs                  |
| No toast, request is 200, bubble turns red later | Asynchronous — Meta accepted then failed delivery | Under the bubble, `messages.error_code`, and `[webhook]` in the logs |

A billing block (131042) usually takes the second path, which is why it
can look like nothing happened at all.
