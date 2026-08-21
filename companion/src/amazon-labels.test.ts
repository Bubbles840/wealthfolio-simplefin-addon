import { describe, it, expect, vi } from 'vitest';
import { createAmazonLabelMenu } from './amazon-labels.js';

/** A menu over an in-memory config/catalogue pair, so a test can assert what
 *  was PERSISTED rather than what the code claimed to persist. */
function makeMenu(over: Partial<Parameters<typeof createAmazonLabelMenu>[0]> = {}) {
  const state = {
    config: {
      host: 'imap.example.com', user: 'me@example.com', password: 'app-password',
      labelOverrides: { 'Existing Label': 'Groceries' },
    } as any,
    labels: { 'Pet Supplies': { category: 'Shopping', matched: false } } as any,
  };
  const deps = {
    readConfig: vi.fn(async () => state.config),
    writeConfig: vi.fn(async (next: any) => { state.config = next; }),
    readLabels: vi.fn(async () => state.labels),
    writeLabels: vi.fn(async (map: any) => { state.labels = map; }),
    mainCategories: vi.fn(async () => ['Groceries', 'Housing', 'Pet Care']),
    log: vi.fn(),
    ...over,
  };
  return { menu: createAmazonLabelMenu(deps as any), deps, state };
}

const ui = () => ({ edit: vi.fn(async () => {}), answer: vi.fn(async () => {}) });

describe('amazon label menu', () => {
  it('offers one button per label, carrying a token rather than the label', () => {
    // Telegram caps callback_data at 64 bytes and an Amazon label is arbitrary
    // text, so the label cannot ride in the button.
    const { menu } = makeMenu();
    const kb = menu.keyboardFor(['Pet Supplies', 'Kitchen & Dining'])!;
    expect(kb.inline_keyboard).toHaveLength(2);
    expect(kb.inline_keyboard[0][0].text).toBe('Change: Pet Supplies');
    for (const [btn] of kb.inline_keyboard) {
      expect(btn.callback_data.startsWith('cz:al:')).toBe(true);
      expect(Buffer.byteLength(btn.callback_data)).toBeLessThanOrEqual(64);
    }
  });

  it('keeps callback_data inside Telegram\'s limit for an absurd label', () => {
    const { menu } = makeMenu();
    const kb = menu.keyboardFor(['x'.repeat(400)])!;
    expect(Buffer.byteLength(kb.inline_keyboard[0][0].callback_data)).toBeLessThanOrEqual(64);
  });

  it('gives no keyboard when there is nothing to offer', () => {
    expect(makeMenu().menu.keyboardFor([])).toBeUndefined();
  });

  it('claims only its own callbacks, leaving the transaction menu alone', () => {
    // Both ride the `cz:` prefix, so a wrong answer here either swallows the
    // transaction menu's taps or lets it swallow these.
    const { menu } = makeMenu();
    expect(menu.handles('cz:al:1')).toBe(true);
    expect(menu.handles('cz:alc:1:0')).toBe(true);
    expect(menu.handles('cz:3:2')).toBe(false);
    expect(menu.handles('cz:recategorize')).toBe(false);
  });

  it('lists the main categories when the button is tapped', async () => {
    const { menu } = makeMenu();
    const token = menu.keyboardFor(['Pet Supplies'])!.inline_keyboard[0][0].callback_data.slice('cz:al:'.length);
    const u = ui();
    await menu.onCallback({ data: `cz:al:${token}` }, u);
    const [text, kb] = u.edit.mock.calls[0];
    expect(text).toContain('Pet Supplies');
    expect(kb.inline_keyboard.map((r: any) => r[0].text)).toEqual(['Groceries', 'Housing', 'Pet Care']);
  });

  it('records the override WITHOUT destroying the mailbox credentials', async () => {
    // The same secret holds the IMAP password; a whole-object write from a
    // stale snapshot would delete it and silently stop Amazon categorisation.
    const { menu, state } = makeMenu();
    const token = menu.keyboardFor(['Pet Supplies'])!.inline_keyboard[0][0].callback_data.slice('cz:al:'.length);
    await menu.onCallback({ data: `cz:al:${token}` }, ui());
    await menu.onCallback({ data: `cz:alc:${token}:2` }, ui());

    expect(state.config.password).toBe('app-password');
    expect(state.config.host).toBe('imap.example.com');
    expect(state.config.labelOverrides).toEqual({
      'Existing Label': 'Groceries',   // other overrides survive
      'Pet Supplies': 'Pet Care',
    });
    // The addon's own list is kept in step, so the Sync page agrees with chat.
    expect(state.labels['Pet Supplies']).toEqual({ category: 'Pet Care', matched: true });
  });

  it('resolves the choice against what the menu SHOWED, not a fresh read', async () => {
    // A category added between drawing the picker and tapping it would shift
    // every index and file the label under the wrong one.
    const { menu, deps, state } = makeMenu();
    const token = menu.keyboardFor(['Pet Supplies'])!.inline_keyboard[0][0].callback_data.slice('cz:al:'.length);
    await menu.onCallback({ data: `cz:al:${token}` }, ui());
    deps.mainCategories.mockResolvedValue(['AAA New Category', 'Groceries', 'Housing', 'Pet Care']);
    await menu.onCallback({ data: `cz:alc:${token}:2` }, ui());
    expect(state.config.labelOverrides['Pet Supplies']).toBe('Pet Care');
  });

  it('answers rather than hangs when the session is gone', async () => {
    // Every button outlives the process that minted it.
    const { menu, deps } = makeMenu();
    const u = ui();
    await menu.onCallback({ data: 'cz:al:999' }, u);
    expect(u.answer).toHaveBeenCalledWith(expect.stringContaining('expired'));
    expect(deps.writeConfig).not.toHaveBeenCalled();
  });

  it('falls back to the built-in categories when the database is unreadable', async () => {
    // The companion runs happily without the database mount; the picker must
    // not be empty there.
    const { menu } = makeMenu({ mainCategories: vi.fn(async () => { throw new Error('no db'); }) });
    const token = menu.keyboardFor(['Pet Supplies'])!.inline_keyboard[0][0].callback_data.slice('cz:al:'.length);
    const u = ui();
    await menu.onCallback({ data: `cz:al:${token}` }, u);
    const names = u.edit.mock.calls[0][1].inline_keyboard.map((r: any) => r[0].text);
    expect(names).toContain('Groceries');
    expect(names).toContain('Pet Care');
  });

  it('never leaves the button spinning when the write fails', async () => {
    const { menu } = makeMenu({ writeConfig: vi.fn(async () => { throw new Error('secret write failed'); }) });
    const token = menu.keyboardFor(['Pet Supplies'])!.inline_keyboard[0][0].callback_data.slice('cz:al:'.length);
    await menu.onCallback({ data: `cz:al:${token}` }, ui());
    const u = ui();
    await expect(menu.onCallback({ data: `cz:alc:${token}:0` }, u)).resolves.toBeUndefined();
    expect(u.answer).toHaveBeenCalled();
  });

  it('still records the override when only the display catalogue fails', async () => {
    // The override is what decides future filings; a display list is not.
    const { menu, state } = makeMenu({ writeLabels: vi.fn(async () => { throw new Error('nope'); }) });
    const token = menu.keyboardFor(['Pet Supplies'])!.inline_keyboard[0][0].callback_data.slice('cz:al:'.length);
    await menu.onCallback({ data: `cz:al:${token}` }, ui());
    await menu.onCallback({ data: `cz:alc:${token}:0` }, ui());
    expect(state.config.labelOverrides['Pet Supplies']).toBe('Groceries');
  });
});
