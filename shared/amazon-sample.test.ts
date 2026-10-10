import { describe, it, expect } from 'vitest';
import { redactAmazonText, toAmazonMailSample, amazonSamplesAsFixtureText, AMAZON_SAMPLE_LIMIT } from './amazon-sample.js';

describe('redactAmazonText', () => {
  it('replaces the delivery line with the fixtures\' stand-in', () => {
    expect(redactAmazonText('Arriving tomorrow\nNicholas - LOUISVILLE, KY\nOrder #'))
      .toBe('Arriving tomorrow\nJordan - SPRINGFIELD, IL\nOrder #');
  });

  it('removes a personal address but keeps Amazon\'s own', () => {
    // A hand-forwarded order carries the forwarder's address AND Amazon's in its
    // From: lines; the forwarded-mail check needs Amazon's to recognise it.
    expect(redactAmazonText('From: Nick <nick@example.com>\nFrom: "Amazon.com" <auto-confirm@amazon.com>'))
      .toBe('From: Nick <<email>>\nFrom: "Amazon.com" <auto-confirm@amazon.com>');
  });

  it('drops link query strings, which carry tracking and shipment codes', () => {
    expect(redactAmazonText('https://www.amazon.com/progress-tracker/package?orderId=1&shipmentId=X'))
      .toBe('https://www.amazon.com/progress-tracker/package');
    expect(redactAmazonText('[here.](https://www.amazon.com/print.html?orderID=1) One'))
      .toBe('[here.](https://www.amazon.com/print.html) One');
  });
});

describe('toAmazonMailSample', () => {
  it('keeps the copies apart, redacted, without blank lines', () => {
    const s = toAmazonMailSample({
      date: '2026-10-05T17:11:52.000Z',
      from: 'shipment-tracking@amazon.com',
      parts: { subject: 'Shipped 1 item: Hair Care', plain: 'Order #\n\n   \nNicholas - LOUISVILLE, KY', html: '1 Hair Care item' },
    });
    expect(s).toEqual({
      at: '2026-10-05T17:11:52.000Z',
      from: 'shipment-tracking@amazon.com',
      subject: 'Shipped 1 item: Hair Care',
      plain: 'Order #\nJordan - SPRINGFIELD, IL',
      html: '1 Hair Care item',
    });
  });

  it('hides a sender that is not Amazon', () => {
    expect(toAmazonMailSample({ date: 'd', from: 'nick@example.com', parts: {} }).from).toBe('<email>');
  });

  it('trims each copy to 80 lines and 4,000 characters', () => {
    const long = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(60)}`).join('\n');
    const s = toAmazonMailSample({ date: 'd', parts: { plain: long } });
    expect(s.plain.split('\n').length).toBeLessThanOrEqual(80);
    expect(s.plain.length).toBeLessThanOrEqual(4000);
  });

  it('keeps at most five', () => {
    expect(AMAZON_SAMPLE_LIMIT).toBe(5);
  });
});

describe('amazonSamplesAsFixtureText', () => {
  it('writes the fixture shape, copies as line arrays', () => {
    const sample = { at: '2026-10-05T17:11:52.000Z', from: 'shipment-tracking@amazon.com', subject: 'S', plain: 'a\nb', html: 'c' };
    expect(JSON.parse(amazonSamplesAsFixtureText([sample]))).toEqual([{
      note: 'Captured 2026-10-05 from shipment-tracking@amazon.com',
      subject: 'S', plain: ['a', 'b'], html: ['c'],
    }]);
  });
});
