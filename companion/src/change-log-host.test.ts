import { describe, it, expect, vi } from 'vitest';
import { categoryRuleCreatedChange } from '../../shared/change-entries.js';
import { createChangeLogWriter, type ChangeBucket } from '../../shared/change-log.js';
import { companionChangeSink, readCompanionChangeLog, recordCompanionChanges, type SecretClient } from './change-log-host.js';

const NOW = new Date('2026-10-12T14:05:00Z');

function client(seed: Record<string, string> = {}): SecretClient & { data: Map<string, string> } {
  const data = new Map(Object.entries(seed));
  return {
    data,
    getAddonSecret: vi.fn(async (_addon: string, k: string) => data.get(k) ?? null),
    setAddonSecret: vi.fn(async (_addon: string, k: string, v: string) => { data.set(k, v); }),
  };
}
const rule = () => categoryRuleCreatedChange({ ruleId: 'rule-7', name: 'Telegram: TRADER JOE S', pattern: 'TRADER JOE S', categoryId: 'cat-gro', categoryName: 'Groceries' });

describe('the companion change log', () => {
  it('writes the companion’s own key through the add-on secrets, and clears by writing an empty string', async () => {
    const c = client({ 'change_log:companion:2026-06': '{"old":1}' });
    const writer = createChangeLogWriter({ writer: 'companion', now: () => NOW });
    await recordCompanionChanges(c, [rule()], undefined, NOW, writer);
    const b = JSON.parse(c.data.get('change_log:companion:2026-10')!) as ChangeBucket;
    expect(b.entries).toEqual([expect.objectContaining({ writer: 'companion', actor: 'you', kind: 'category-rule-created' })]);
    expect('run' in b.entries[0]).toBe(false);
    expect(c.setAddonSecret).toHaveBeenCalledWith('simplefin-sync', 'change_log:companion:2026-06', '');
  });

  it('stamps an after-sync step with the sync’s run', async () => {
    const c = client();
    const writer = createChangeLogWriter({ writer: 'companion', now: () => NOW });
    const sink = companionChangeSink(c, NOW, writer);
    expect(sink.run).toBe(`c${NOW.getTime().toString(36)}`);
    await recordCompanionChanges(c, [rule()], sink.run, NOW, writer);
    expect((JSON.parse(c.data.get('change_log:companion:2026-10')!) as ChangeBucket).entries[0].run).toBe(sink.run);
  });

  it('a sync and a tap in the same moment both land', async () => {
    const c = client();
    const slow = c.getAddonSecret;
    c.getAddonSecret = vi.fn(async (a: string, k: string) => { await new Promise((r) => setTimeout(r, 5)); return slow(a, k); });
    const writer = createChangeLogWriter({ writer: 'companion', now: () => NOW });
    const sink = companionChangeSink(c, NOW, writer);
    await Promise.all([
      sink.append([{ ...rule(), id: 'c1', at: NOW.toISOString(), writer: 'companion' }]),
      recordCompanionChanges(c, [rule()], undefined, NOW, writer),
    ]);
    expect((JSON.parse(c.data.get('change_log:companion:2026-10')!) as ChangeBucket).entries).toHaveLength(2);
  });

  it('reads the merged log', async () => {
    const c = client();
    const writer = createChangeLogWriter({ writer: 'companion', now: () => NOW });
    await recordCompanionChanges(c, [rule()], undefined, NOW, writer);
    const read = await readCompanionChangeLog(c, NOW);
    expect(read.entries.map((e) => e.summary)).toEqual(['Created a rule: descriptions containing "TRADER JOE S" go to Groceries']);
  });
});
