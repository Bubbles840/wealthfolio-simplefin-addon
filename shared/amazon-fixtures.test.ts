import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { classifyAmazonEmail, type AmazonEmailClassification } from './amazon.js';

/**
 * Every real Amazon email the parser has been fixed against, one file each, in
 * the shape the Amazon card's "Show what couldn't be read" copies (plus
 * `expect`). One test per file, so a fix for a new layout can never silently
 * break an old one — which is how the Sept 2026 fix shipped a parser that read
 * a single copy and broke on the real three-copy message.
 *
 * Adding a format: paste the card's copied sample into a new file here, add
 * `expect`, and make it pass.
 */
interface AmazonEmailFixture {
  note: string;
  subject: string;
  plain: string[];
  html: string[];
  expect: AmazonEmailClassification;
}

const DIR = join(process.cwd(), 'shared', '__fixtures__', 'amazon-emails');
const files = readdirSync(DIR).filter((f) => f.endsWith('.json')).sort();

describe('real Amazon emails', () => {
  it('has fixtures to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(file, () => {
      const fx = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as AmazonEmailFixture;
      expect(classifyAmazonEmail({
        subject: fx.subject,
        plain: fx.plain.join('\n'),
        html: fx.html.join('\n'),
      })).toEqual(fx.expect);
    });
  }
});
