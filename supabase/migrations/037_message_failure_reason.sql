-- ============================================================
-- 037_message_failure_reason
--
-- Keep the reason a message failed, instead of only the fact.
--
-- Meta reports most outbound failures asynchronously. The POST to
-- /messages returns 200 with a wamid, and only later does a status
-- webhook arrive with `status: "failed"` and an `errors` array naming
-- the cause:
--
--   "statuses": [{ "id": "wamid…", "status": "failed",
--     "errors": [{ "code": 131042, "title": "Business eligibility
--       payment issue", "error_data": { "details": "…" } }] }]
--
-- `handleStatusUpdate` copied `status` onto the row and dropped the
-- errors array on the floor. The result: a bubble marked failed with
-- no explanation anywhere — not in the UI, not in the logs, not in the
-- database. An operator watching a template send fail had literally no
-- way to learn why, which is exactly the state that made a billing
-- block (131042) look like an application bug for days.
--
-- Two columns, both nullable, both only ever written by the webhook:
--   error_code    Meta's numeric code — the part we can map to a
--                 translated, actionable message in the UI.
--   error_message Meta's own text (title + details), kept verbatim as
--                 the fallback for a code we don't recognise yet.
--
-- Backfill is not possible: the errors were never stored. Existing
-- failed rows keep NULLs and render as they do today.
-- ============================================================

ALTER TABLE messages ADD COLUMN IF NOT EXISTS error_code INTEGER;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS error_message TEXT;

COMMENT ON COLUMN messages.error_code IS
  'Meta error code from the status webhook when status = failed. Mapped to a translated message via src/lib/whatsapp/meta-error-codes.ts.';
COMMENT ON COLUMN messages.error_message IS
  'Meta''s verbatim error text from the status webhook. Fallback for an unmapped error_code.';

-- Failed messages are the ones support actually looks up, and they are
-- a small slice of the table — a partial index keeps that lookup cheap
-- without paying for the 99% that succeeded.
CREATE INDEX IF NOT EXISTS idx_messages_failed
  ON messages (conversation_id, created_at DESC)
  WHERE status = 'failed';
