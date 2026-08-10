import { describe, it, expect } from 'vitest';
import { pruneDismissals } from './dismissals.js';

// The Telegram transport's own tests live in ./telegram-listener.test.ts now —
// the listener owns `getUpdates`, so the `d:<activityId>` parsing, the
// answerCallbackQuery and the offset advance are asserted there (see
// "startTelegramListener — dismiss callbacks"). What is left here is the ledger.

describe('pruneDismissals', () => {
  it('drops entries older than 60 days and keeps the rest', () => {
    const now = new Date('2026-07-30T00:00:00Z');
    const pruned = pruneDismissals(
      { 'act-old': '2026-05-01T00:00:00Z', 'act-new': '2026-07-20T00:00:00Z' },
      now,
    );
    expect(pruned).toEqual({ 'act-new': '2026-07-20T00:00:00Z' });
  });
});
