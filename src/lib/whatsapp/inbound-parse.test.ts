import { describe, expect, it } from 'vitest';
import { extractTappedReply, toMessageContentType } from './inbound-parse';

describe('extractTappedReply — template quick-reply (type: button)', () => {
  it('reads the payload Meta sends for a template button tap', () => {
    expect(
      extractTappedReply({
        type: 'button',
        button: { payload: 'Enfermería', text: 'Enfermería' },
      })
    ).toEqual({ replyId: 'Enfermería', title: 'Enfermería' });
  });

  it('prefers a custom payload over the visible label', () => {
    expect(
      extractTappedReply({
        type: 'button',
        button: { payload: 'carrera_enfermeria', text: 'Enfermería' },
      })
    ).toEqual({ replyId: 'carrera_enfermeria', title: 'Enfermería' });
  });

  it('falls back to the label when payload is absent', () => {
    expect(
      extractTappedReply({ type: 'button', button: { text: 'Matrículas' } })
    ).toEqual({ replyId: 'Matrículas', title: 'Matrículas' });
  });

  it('returns null when the button carries neither payload nor text', () => {
    expect(extractTappedReply({ type: 'button', button: {} })).toBeNull();
  });
});

describe('extractTappedReply — interactive messages', () => {
  it('reads button_reply', () => {
    expect(
      extractTappedReply({
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: { id: 'yes', title: 'Sí, confirmo' },
        },
      })
    ).toEqual({ replyId: 'yes', title: 'Sí, confirmo' });
  });

  it('reads list_reply', () => {
    expect(
      extractTappedReply({
        type: 'interactive',
        interactive: {
          type: 'list_reply',
          list_reply: { id: 'row_2', title: 'Segunda opción' },
        },
      })
    ).toEqual({ replyId: 'row_2', title: 'Segunda opción' });
  });

  it('falls back to the id when the title is empty', () => {
    expect(
      extractTappedReply({
        type: 'interactive',
        interactive: { button_reply: { id: 'yes', title: '' } },
      })
    ).toEqual({ replyId: 'yes', title: 'yes' });
  });

  it('returns null for a malformed interactive payload', () => {
    expect(
      extractTappedReply({ type: 'interactive', interactive: {} })
    ).toBeNull();
  });
});

describe('extractTappedReply — non-taps', () => {
  it.each(['text', 'image', 'audio', 'location', 'reaction'])(
    'returns null for %s',
    (type) => {
      expect(extractTappedReply({ type })).toBeNull();
    }
  );
});

describe('toMessageContentType', () => {
  it('maps a template button tap onto the interactive content type', () => {
    expect(toMessageContentType('button')).toBe('interactive');
  });

  it('passes through types the CHECK constraint already allows', () => {
    for (const type of [
      'text',
      'image',
      'document',
      'audio',
      'video',
      'location',
      'template',
      'interactive',
    ]) {
      expect(toMessageContentType(type)).toBe(type);
    }
  });

  it('maps stickers to image', () => {
    expect(toMessageContentType('sticker')).toBe('image');
  });

  it('falls back to text for unknown types', () => {
    expect(toMessageContentType('contacts')).toBe('text');
    expect(toMessageContentType('order')).toBe('text');
  });
});
