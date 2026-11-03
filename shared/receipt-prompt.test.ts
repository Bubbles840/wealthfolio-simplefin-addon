import { describe, it, expect } from 'vitest';
import { parseTranscript, receiptChatRequest, RECEIPT_PROMPT } from './receipt-prompt.js';

describe('the request', () => {
  it('sends the image with the schema, at temperature 0, without streaming', () => {
    const body = receiptChatRequest('m', 'aGVsbG8=');
    expect(body).toMatchObject({ model: 'm', stream: false, options: { temperature: 0 } });
    expect(body.messages[0]).toMatchObject({ role: 'user', content: RECEIPT_PROMPT, images: ['aGVsbG8='] });
    expect(body.format.required).toContain('payments');
  });

  it('asks for a transcription only, and names no store', () => {
    expect(RECEIPT_PROMPT).toMatch(/do not calculate anything/);
  });
});

describe('parseTranscript', () => {
  it('reads an answer, filling what the model left out', () => {
    const t = parseTranscript(JSON.stringify({ store: 'Shop', date: '2027-03-14', lines: [], subtotal: '1.00', payments: [] }));
    expect(t).toEqual({ store: 'Shop', date: '2027-03-14', lines: [], subtotal: '1.00', tax: '', taxLines: [], total: '', payments: [] });
  });

  it('refuses what is not a transcript', () => {
    expect(['not json', 'null', '{"lines":[]}', '{"payments":[]}'].map(parseTranscript)).toEqual([null, null, null, null]);
  });
});
