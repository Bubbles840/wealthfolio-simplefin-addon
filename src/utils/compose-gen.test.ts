import { describe, it, expect } from 'vitest';
import { generateEnvFile, generateComposeSnippet } from './compose-gen';
import type { ComposeConfig } from './compose-gen';

const config: ComposeConfig = {
  wealthfolioApiUrl: 'http://wealthfolio:7500',
  accountMapping: { 'sfin-1': 'wf-a' },
  syncSchedule: '0 */6 * * *',
  lookbackDays: 7,
  mappingRules: [{ pattern: 'dividend', matchType: 'contains', activityType: 'DIVIDEND' }],
};

describe('generateEnvFile', () => {
  it('includes an empty SIMPLEFIN_SETUP_TOKEN placeholder, never an access URL', () => {
    const env = generateEnvFile(config);
    expect(env).toContain('SIMPLEFIN_SETUP_TOKEN=');
    expect(env).not.toContain('SIMPLEFIN_ACCESS_URL');
    expect(env).not.toContain('user:pass');
  });

  it('includes ACCOUNT_MAPPING as JSON', () => {
    expect(generateEnvFile(config)).toContain('ACCOUNT_MAPPING=');
    expect(generateEnvFile(config)).toContain('sfin-1');
  });

  it('points STATE_FILE at the persistent volume', () => {
    expect(generateEnvFile(config)).toContain('STATE_FILE=/data/state.json');
  });

  it('does not include any undefined values', () => {
    expect(generateEnvFile(config)).not.toContain('undefined');
  });
});

describe('generateComposeSnippet', () => {
  it('builds locally from the companion Dockerfile (no published image)', () => {
    const snippet = generateComposeSnippet(config);
    expect(snippet).toContain('build:');
    expect(snippet).toContain('dockerfile: companion/Dockerfile');
    expect(snippet).not.toContain('image:');
  });

  it('uses non-root user', () => {
    expect(generateComposeSnippet(config)).toContain('1000:1000');
  });

  it('includes env_file reference', () => {
    expect(generateComposeSnippet(config)).toContain('env_file');
  });

  it('mounts a persistent volume for claimed credentials', () => {
    const snippet = generateComposeSnippet(config);
    expect(snippet).toContain('simplefin-sync-data:/data');
    expect(snippet).toContain('volumes:');
  });
});
