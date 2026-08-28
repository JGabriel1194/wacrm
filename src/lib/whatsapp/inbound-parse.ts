/**
 * Pure helpers for reading the two *different* shapes Meta uses to tell
 * us "the customer tapped something".
 *
 * This distinction is the whole reason this module exists:
 *
 *   - A quick-reply button on a **template** message arrives as
 *     `type: 'button'` with `{ button: { payload, text } }`.
 *   - A button / row on an **interactive** message (one we composed
 *     ourselves with `type: 'interactive'`) arrives as
 *     `type: 'interactive'` with `{ interactive: { button_reply } }`.
 *
 * Handling only the second shape silently breaks every template-driven
 * menu: the tap lands in the `default:` branch, gets stored as
 * "[Unsupported message type: button]", and the `interactive_reply`
 * automation trigger never sees a reply id to match on.
 */

/** Minimal slice of the inbound webhook message these helpers read. */
export interface InboundReplySource {
  type: string;
  /** Template quick-reply tap. */
  button?: { payload?: string; text?: string };
  /** Interactive-message button / list-row tap. */
  interactive?: {
    type?: 'button_reply' | 'list_reply';
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
}

export interface TappedReply {
  /**
   * Stable id the automations engine matches `trigger_config.reply_ids`
   * against, and what we persist to `messages.interactive_reply_id`.
   */
  replyId: string;
  /** Human-readable label, used as the inbox bubble's text. */
  title: string;
}

/**
 * Return the tapped option for both template and interactive taps, or
 * null when this message isn't a tap at all.
 *
 * Note on template payloads: templates created through the CRM define
 * QUICK_REPLY buttons with a label only — no custom payload — and the
 * send path only overrides payloads for URL / COPY_CODE buttons. So Meta
 * echoes the button's own label back as `payload`, which makes the
 * button text the de-facto reply id. We still prefer `payload` over
 * `text` so a template that *does* carry a custom payload keeps working.
 */
export function extractTappedReply(
  message: InboundReplySource
): TappedReply | null {
  if (message.type === 'button') {
    const replyId = message.button?.payload ?? message.button?.text;
    if (!replyId) return null;
    return { replyId, title: message.button?.text || replyId };
  }

  if (message.type === 'interactive') {
    const reply =
      message.interactive?.button_reply ?? message.interactive?.list_reply;
    if (!reply?.id) return null;
    return { replyId: reply.id, title: reply.title || reply.id };
  }

  return null;
}

/**
 * The `messages.content_type` CHECK constraint (widened in migration 010
 * to add 'interactive') allows exactly this set. Anything else has to be
 * mapped to the closest allowed value or the INSERT fails outright.
 */
const ALLOWED_CONTENT_TYPES = new Set([
  'text',
  'image',
  'document',
  'audio',
  'video',
  'location',
  'template',
  'interactive',
]);

/**
 * Map an inbound WhatsApp message type onto an allowed
 * `messages.content_type` value.
 *
 * 'button' maps to 'interactive' so a template tap is stored exactly
 * like an interactive tap — same content_type, same
 * `interactive_reply_id` column — and the inbox renders both with the
 * tap affordance.
 */
export function toMessageContentType(whatsappType: string): string {
  if (ALLOWED_CONTENT_TYPES.has(whatsappType)) return whatsappType;
  // Template quick-reply tap → stored like any other tap.
  if (whatsappType === 'button') return 'interactive';
  // Stickers are images under the hood.
  if (whatsappType === 'sticker') return 'image';
  // reaction, unknown → text fallback.
  return 'text';
}
