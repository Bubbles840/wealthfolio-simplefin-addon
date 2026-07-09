import { describe, it, expect } from 'vitest';
import { generateEnvFile, generateComposeSnippet } from './compose-gen';
import type { ComposeConfig } from './compose-gen';

const config: ComposeConfig = {
  accessUrl: 'https://user:pass@bridge.simplefin.org/simplefin',
  wealthfolioApiUrl: 'http://wealthfolio:7500',
  accountMapping: { 'sfin-1': 'wf-a' },
  syncSchedule: '0 */6 * * *',
  lookbackDays: 7,
  mappingRules: [{ pattern: 'dividend', matchType: 'contains', activityType: 'DIVIDEND' }],
};

describe('generateEnvFile', () => {
  it('includes SIMPLEFIN_ACCESS_URL', () => {
    expect(generateEnvFile(config)).toContain('SIMPLEFIN_ACCESS_URL=https://user:pass@bridge');
  });

  it('includes ACCOUNT_MAPPING as JSON', () => {
    expect(generateEnvFile(config)).toContain('ACCOUNT_MAPPING=');
    expect(generateEnvFile(config)).toContain('sfin-1');
  });

  it('includes a .gitignore warning', () => {
    expect(generateEnvFile(config)).toContain('.gitignore');
  });

  it('does not include any undefined values', () => {
    expect(generateEnvFile(config)).not.toContain('undefined');
  });
});

describe('generateComposeSnippet', () => {
  it('references the ghcr image', () => {
    expect(generateComposeSnippet(config)).toContain('ghcr.io/wealthfolio-community/simplefin-sync');
  });

  it('uses non-root user', () => {
    expect(generateComposeSnippet(config)).toContain('1000:1000');
  });

  it('includes env_file reference', () => {
    expect(generateComposeSnippet(config)).toContain('env_file');
  });
});
