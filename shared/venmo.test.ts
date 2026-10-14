import { describe, it, expect } from 'vitest';
import {
  classifyVenmoEmail, clipVenmoNote, isVenmoMessage, toVenmoMailSample, VENMO_BANK_TRANSFER_NOTE, VENMO_NOTE_MAX,
} from './venmo';

// Every fixture here is BUILT FROM VENMO'S DOCUMENTED NOTIFICATION WORDING, not
// copied from a real email — none has been seen yet. Replace them with Nick's
// real (redacted) emails when they arrive (follow-ups §13).

const PAID = {
  subject: 'You paid Jane Doe $25.00',
  plain: 'You paid Jane Doe\n$25.00\nRent October 🏠\nSee transaction\nPayment ID: 4123456789012345678\n',
};

describe('classifyVenmoEmail', () => {
  it('reads "You paid <name> $X": money out, the name, the amount and the note', () => {
    expect(classifyVenmoEmail(PAID)).toEqual({
      status: 'payment',
      record: {
        direction: 'out', kind: 'payment', amountCents: 2500, counterparty: 'Jane Doe', note: 'Rent October 🏠',
        paymentId: '4123456789012345678',
      },
    });
  });

  it('reads "<name> paid you $X" from the HTML copy, a signed amount and a quoted note', () => {
    const r = classifyVenmoEmail({
      subject: 'Sam Lee paid you $1,200.00',
      html: '\n\nSam Lee paid you\n\n\n+ $1,200.00\n\n"Utilities split"\n\nSee transaction\n',
    });
    expect(r).toEqual({
      status: 'payment',
      record: { direction: 'in', kind: 'payment', amountCents: 120000, counterparty: 'Sam Lee', note: 'Utilities split' },
    });
  });

  it('counts a charge request you completed as paid, and one completed for you as received', () => {
    expect(classifyVenmoEmail({
      subject: "You completed Alex Kim's $42.50 charge request",
      plain: "You completed Alex Kim's charge request\n- $42.50\nConcert tickets\n",
    }).record).toEqual({ direction: 'out', kind: 'request', amountCents: 4250, counterparty: 'Alex Kim', note: 'Concert tickets' });
    expect(classifyVenmoEmail({
      subject: 'Alex Kim paid your $18.00 request',
      plain: 'Alex Kim paid your request\n$18.00\nPizza night\n',
    }).record).toEqual({ direction: 'in', kind: 'request', amountCents: 1800, counterparty: 'Alex Kim', note: 'Pizza night' });
  });

  it('reads a transfer to your bank as money in, with a fixed note', () => {
    expect(classifyVenmoEmail({
      subject: 'Your $300.00 transfer to your bank has been initiated',
      plain: 'You transferred $300.00 to your bank account ending in 1234.\n',
    })).toEqual({
      status: 'payment',
      record: { direction: 'in', kind: 'bank-transfer', amountCents: 30000, counterparty: null, note: VENMO_BANK_TRANSFER_NOTE },
    });
    expect(VENMO_BANK_TRANSFER_NOTE).toBe('Transfer to your bank');
  });

  it('reads a message forwarded by hand: Fwd: off the subject, its header lines never the note', () => {
    const r = classifyVenmoEmail({
      subject: 'Fwd: You paid Jane Doe $25.00',
      plain: '---------- Forwarded message ---------\nFrom: Venmo <venmo@venmo.com>\nDate: Oct 3, 2026\n'
        + 'Subject: You paid Jane Doe $25.00\nTo: <nick@example.com>\n\nYou paid Jane Doe\n$25.00\nRent October\n',
    });
    expect(r.record).toEqual({ direction: 'out', kind: 'payment', amountCents: 2500, counterparty: 'Jane Doe', note: 'Rent October' });
  });

  it('reads the head from the body when the subject is not one', () => {
    const r = classifyVenmoEmail({ subject: 'Venmo', plain: 'Jane Doe paid you\n$7.00\nCoffee\n' });
    expect(r.record).toEqual({ direction: 'in', kind: 'payment', amountCents: 700, counterparty: 'Jane Doe', note: 'Coffee' });
  });

  it('keeps Markdown characters in a name or note raw — Telegram escapes them, not the parser', () => {
    const r = classifyVenmoEmail({ subject: 'You paid J_D *Smith* $9.99', plain: 'You paid J_D *Smith*\n$9.99\n*Rent* _Oct_ [2]\n' });
    expect(r.record).toMatchObject({ counterparty: 'J_D *Smith*', note: '*Rent* _Oct_ [2]' });
  });

  it('ignores Venmo mail that moves no money: a security code, a request, marketing', () => {
    expect(classifyVenmoEmail({ subject: 'Your Venmo security code', plain: 'Your code is 123456.' })).toEqual({ status: 'ignored' });
    expect(classifyVenmoEmail({ subject: 'Jane Doe requests $25.00', plain: 'Jane Doe requests\n$25.00\nRent' })).toEqual({ status: 'ignored' });
    expect(classifyVenmoEmail({ subject: 'Introducing Venmo Teen', plain: 'A debit card for teens.' })).toEqual({ status: 'ignored' });
  });

  it('calls a payment it cannot read unrecognised — no amount line, no note, or a shape it does not know', () => {
    expect(classifyVenmoEmail({ subject: 'You paid Jane Doe $25.00', plain: 'Something changed.\n' })).toEqual({ status: 'unrecognised' });
    expect(classifyVenmoEmail({ subject: 'You paid Jane Doe $25.00', plain: 'You paid Jane Doe\n$25.00\nSee transaction\n' }))
      .toEqual({ status: 'unrecognised' });
    expect(classifyVenmoEmail({ subject: 'Payment completed', plain: '$25.00 sent' })).toEqual({ status: 'unrecognised' });
    expect(classifyVenmoEmail({ subject: 'Your bank transfer is on its way', plain: 'Expect it in 1-3 business days.' }))
      .toEqual({ status: 'unrecognised' });
  });

  it('clips a long note to 60 characters and makes newlines spaces', () => {
    const long = 'Groceries for the whole apartment this week including the big Costco run';
    expect(clipVenmoNote(long)).toBe('Groceries for the whole apartment this week including the b…');
    expect([...clipVenmoNote(long)].length).toBe(VENMO_NOTE_MAX);
    expect(clipVenmoNote('Rent\nOctober\r\n  split')).toBe('Rent October split');
    expect(clipVenmoNote(`${'🍕'.repeat(70)}`)).toBe(`${'🍕'.repeat(59)}…`);
  });
});

describe('isVenmoMessage', () => {
  it('knows Venmo by its sender, or by the From: line of a hand-forwarded copy', () => {
    expect(isVenmoMessage('venmo@venmo.com', '')).toBe(true);
    expect(isVenmoMessage('nick@gmail.com', 'From: Venmo <venmo@venmo.com>\nYou paid Jane Doe')).toBe(true);
    expect(isVenmoMessage('nick@gmail.com', 'I paid Jane on venmo.com yesterday')).toBe(false);
    expect(isVenmoMessage('auto-confirm@amazon.com', 'Thanks for your order')).toBe(false);
    expect(isVenmoMessage(undefined, '')).toBe(false);
  });
});

describe('toVenmoMailSample', () => {
  it('redacts like Amazon’s samples and keeps Venmo’s own sender', () => {
    const s = toVenmoMailSample({
      date: '2026-10-03T12:00:00Z',
      from: 'venmo@venmo.com',
      parts: { subject: 'You paid Jane Doe $25.00', plain: 'Hello Alex,\nYou paid Jane Doe\n\n$25.00\nsent to nick@example.com\n' },
    });
    expect(s).toEqual({
      at: '2026-10-03T12:00:00Z', from: 'venmo@venmo.com', subject: 'You paid Jane Doe $25.00',
      plain: 'Hello Jordan,\nYou paid Jane Doe\n$25.00\nsent to <email>', html: '',
    });
    expect(toVenmoMailSample({ date: 'x', from: 'nick@gmail.com', parts: {} }).from).toBe('<email>');
  });
});
