# Subscriptions & bills (R2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One stored subscription document and one shared roster that the app card, the mini app, `/subscriptions`, the weekly report and a new daily "Coming up" block all render from — with hide, confirm, remind, rename and hand-added subscriptions in both the app and Telegram.

**Architecture:** `shared/subscription-prefs.ts` owns the stored document (`subscription_prefs`), its corrupt-aware parser and the pure edits; `editSubscriptionPrefs` re-reads before every write and mirrors the two legacy lists. `shared/subscription-roster.ts` turns cube + document + `today` into one `Roster` (groups, next dates, totals, link suggestions) plus the date arithmetic both modules need. `shared/subscription-links.ts` finds "Is HULU your Hulu?" candidates at cube build. Telegram text lives in `shared/telegram.ts` (list, Coming-up block, news, next-week line); the stateless `cz:sb:` menu is `companion/src/subscriptions-menu.ts`; the app card is `src/components/budget/SubscriptionsCard.tsx`.

**Tech Stack:** TypeScript, React (addon), vitest (root project: jsdom, `src/` + `shared/`; companion project: node, `companion/src/`), Telegram Bot API (legacy `Markdown` parse mode).

**Spec:** `docs/superpowers/specs/2026-10-12-subscriptions-and-ask-flows-design.md` — Part B, plus the "One deliberate change" note. Binding rulings: the R2 decisions (R2-1 … R2-14) are folded into the tasks below.

**Deviations from the spec (decided, do not "fix"):**
- **No no-companion app mode (R2-2).** Without a cube the whole Budget board is an empty state, so the card is unreachable. `buildRoster` still supports `detectionAvailable: false` (an older companion's `subscriptions: null`, Telegram, tests). The card's Remind control shows the "reminders are sent by the companion" hint when the cube is stale by BudgetTab's existing `STALE_MS` test, linking through `onSetUpCompanion`.
- **App rows use words, not emoji (R2-1):** `· reminder 3d` and `· added by you`. Telegram keeps 🔔 and ✍️. The card's existing 🎉 line stays.
- **"Cancelled?" window:** asked on the first three mornings an entry is overdue — 8, 9 and 10 days after the missed date. The spec's "days 7–9" would overlap the 7-day late grace by one day.
- **Creep freshness** keeps `CREEP_FRESH_DAYS = 3`, now counted in whole calendar days: the charge day and the three after it.
- **The 📅 on "Coming up" and "Next week" follows the report glyph style** (clean, the default, drops it, like every decorative header glyph). State glyphs 🔔 📈 ✓ always show.
- **Telegram Maybes ask one at a time** (`❓ Is X a subscription?` with the spec's two buttons), so each button pair has one subject.
- **One money format for every subscription surface** (`rosterMoney`): `$11.99`, `$99`, `$1,250.50` — `.00` is dropped, so the old app strings `$20.00/mo` become `$20/mo`.
- **The app's Delete gets an Undo line** (reusing `restoreDeleted`); the spec lists Undo for Telegram only.
- **Weekly "Next week"** counts the seven days after the report's day (Monday–Sunday for the Sunday report).
- **A corrupt document makes the app card read-only** under its notice (no buttons), rather than offering edits that are refused; Telegram keeps its buttons and answers each tap with the refusal.

**Task order (changed from the suggested one, on purpose):** the date helpers ship with the document (Task 1) because `acceptLink` needs them; the pure Telegram formatters (Task 5) and the `/subscriptions` menu (Task 6) come before the report changes (Tasks 8–9), so every report button opens a menu that already exists, and the weekly line moved into the report task with the daily block; the app rework is a data-layer task (10, with a one-task adapter so every gate stays green) and three card tasks (11 rows and groups, 12 inline controls, 13 the hand-added form) — one task would be too large to review.

## Global Constraints

- **One document, two writers.** Every subscription write — app and bot — is `editSubscriptionPrefs(get, set, edit, now)` with one of the pure edits from `shared/subscription-prefs.ts`. No whole-list snapshot write survives this release (`setHiddenSubscriptions` / `setConfirmedSubscriptions` are removed).
- **Corrupt is not absent.** `parseSubscriptionPrefs` returns `ok | absent | corrupt`. A corrupt stored document is never overwritten: reads fall back to the legacy lists flagged `unreadable: true`; writes throw `SubscriptionPrefsUnreadableError` before calling `set`.
- **Secret keys (verbatim):** `subscription_prefs` (the document), `hidden_subscriptions` and `confirmed_subscriptions` (legacy, mirrored on every write, hand-added keys left out), `subscription_news_sent` (companion bookkeeping), `report_cube`.
- **Keys:** a detected entry's key is the detector's name; a hand-added entry's key is `m:<id>` forever (linked or not); ids are 8 base-36 characters (`newManualId`). Button handles are `findingHandle(key)` (FNV-1a, 8 hex).
- **Telegram:** legacy `Markdown`. Bank- and user-supplied text goes through `escapeMarkdown` AND stays outside every `*…*`/`_…_` entity — legacy Markdown ignores a backslash escape inside an entity, so `*SQ \*BLUE*` is still refused (see the note above `formatBiggestThisWeek` in `shared/telegram.ts`). Button labels are plain text and are not escaped.
- **`callback_data` ≤ 64 bytes.** Menu prefix `cz:sb:` (`cz:sb:o` opens the list as a NEW message); flows start with `askStartData('sub-add')` / `askStartData('sub-rename', handle)`. `cz:sb:` is routed in `onMenuCallback` BEFORE the categorize fallthrough.
- **Windows (verbatim):** late = 1–7 days past the predicted date; overdue = more than 7; "cancelled?" lines on days 8–10 after the missed date; creep line on days 0–3 after the charge; reminders 1, 3 or 7 days; the daily due list covers `today` and the 6 days after; weekly "Next week" covers tomorrow and the 6 days after; link suggestions look at the last 45 days, ±3 days of a due date, within 15% of the amount; deleted hand-added entries are kept 7 days; news event ids are pruned after 60 days; the Telegram list pages at 10 rows.
- **Dates** are `YYYY-MM-DD` strings. Arithmetic goes through the helpers in `shared/subscription-roster.ts` (UTC, day clamped). `today` is the reader's local calendar day: `localIsoDay(now)` in shared/app code, `toDateString(now)` in `companion/src/index.ts` (the same local-parts formula).
- **App copy carries no emoji** (`src/pages/copy-policy.test.tsx`): no `\p{Extended_Pictographic}` in card buttons, labels, rows or headings. Use `Restore`, not `↩ Restore`.
- **Tests use a fixed `now`.** Pure functions take `today`/`now`. Companion integration tests wrap in `vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 12, 8, 0, 0)); try { … } finally { vi.useRealTimers(); }`. App tests use `vi.useFakeTimers({ toFake: ['Date'] })` (real timers keep `waitFor` working).
- **Fixtures copy real shapes:** a `report_cube` secret is a JSON string with EVERY required field (`version, asOf, months, categories, accounts, spend, uncategorized, income, budgets, merchants, feesInterest, netWorth, liquid, pool`) and `subscriptions` entries shaped like `DetectedSubscription` (with `kind`, `prevCents`, `recent`); secrets are JSON strings in a `Map`; merchant rows are `{ month, date, notes: '<desc> · TRN-<n>', amount /* dollars */ }`.
- **Imports:** shared sources import siblings WITH `.js`; `src/` imports shared WITHOUT an extension; companion imports `'../../shared/x.js'` and `'./x.js'`. New SecretsStore methods are optional-called from `SyncPage` (`store.getSubscriptionPrefs?.()`).
- **Gates before calling a task done:** the touched project's tests, plus `npm run type-check` when `src/` or `shared/` changed and `npm --prefix companion run build` when `companion/` or `shared/` changed. Before the final task: `npm test`, `npm --prefix companion test`, `npm run type-check`, `npm --prefix companion run build`.
- **No version bump, tag or release.** CHANGELOG goes under `[Unreleased]`.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **A bank name with Markdown characters** (`PAYPAL *HULU`, `SQ *COFFEE_CLUB`) on the morning report's Coming-up lines → escaped and outside any bold, so Telegram does not refuse the whole report. Pinned end to end through `composeDailyDigestMessage` in Task 8.
- **A charge on the 31st** → next date Feb 28 (Feb 29 in a leap year), Apr 30; a hand-added Jan 31 seen in March is due Mar 31, not Mar 28 (counted from the anchor, never from the clamped month). Pinned in Task 2.
- **A corrupt `subscription_prefs` when a Telegram button is tapped** → "Couldn't read your subscription settings — nothing was changed.", the stored text byte-identical, and the list still honours the legacy hides. Pinned in Task 6.
- **Daily report off and the companion down on the reminder's first morning** → the reminder arrives the next morning inside the window, exactly once; nothing repeats the morning after. Pinned in Task 9.
- **A report's `🙈 Hide Netflix` tapped after Netflix was already hidden in the app** → "That one is already sorted — refreshing.", the list arrives as a NEW message (the report is never edited), nothing is written. Pinned in Task 6.

---

## File Structure

| File | Responsibility |
|---|---|
| `shared/subscription-roster.ts` (create) | Date and key helpers (Task 1); `buildRoster`, `dueWithin`, roster text helpers (Task 2). |
| `shared/subscription-prefs.ts` (create) | Document types, `parseSubscriptionPrefs`, `loadSubscriptionPrefs`, `editSubscriptionPrefs`, the pure edits. |
| `shared/handle.ts` (create) | `findingHandle` moved here (leaf module) so the roster can use it without an import cycle; `shared/findings.ts` re-exports it. |
| `shared/subscriptions.ts` (modify) | `DetectedSubscription.recent` filled by `detectSubscriptions`. |
| `shared/subscription-links.ts` (create) | `findLinkSuggestions` (pure). |
| `shared/report-cube.ts` (modify) | Optional `subscriptionLinks` field. |
| `companion/src/report-cube-build.ts` (modify) | Optional `subscriptionPrefs` dep; publishes `subscriptionLinks`. |
| `companion/src/subscription-data.ts` (create) | `readSubscriptionRoster` — cube + document → `RosterRead`. |
| `companion/src/reports-server.ts` (modify) | Subscriptions section from the roster. |
| `shared/telegram.ts` (modify) | `formatSubscriptionList`, `formatComingUpBlock`, `formatSubscriptionNews`, `formatNextWeekLine`, news bookkeeping. |
| `companion/src/subscriptions-menu.ts` (create) | Stateless `cz:sb:` menu: list, detail, maybes, hidden, writes, undo. |
| `shared/telegram-commands.ts` (modify) | `/subscriptions` in More commands; `parseSubscriptionName`, `parseSubscriptionDate`, hint strings. |
| `shared/ask-flow.ts` (modify) | 64-byte guard in `askStartData`. |
| `companion/src/ask-flows.ts` (modify) | `buildSubAddFlow`, `buildSubRenameFlow`. |
| `companion/src/index.ts` (modify) | Bindings, `/subscriptions`, menu wiring, flows, daily block, weekly line, daily-off news; `readCubeSubscriptions` removed. |
| `src/utils/secrets.ts` (modify) | `getSubscriptionPrefs`, `editSubscriptionPrefs`, KEYS entries; old list methods removed. |
| `src/pages/SyncPage.tsx`, `src/tabs/BudgetTab.tsx` (modify) | Own and pass `subscriptionPrefs` + `onSubscriptionEdit`. |
| `src/components/budget/SubscriptionsCard.tsx` (create) | The card, from the roster. |
| `src/components/budget/ReportView.tsx` (modify) | Renders `SubscriptionsCard`; old `Subscriptions` component removed. |
| `src/components/ui.tsx` (modify) | New `sfin-subs-*` rules. |
| `README.md`, `CHANGELOG.md`, `docs/superpowers/follow-ups.md` (modify) | Docs and the legacy-mirror follow-up. |

---

### Task 1: Date helpers and the stored document

**Files:**
- Create: `shared/subscription-roster.ts` (date and key helpers only; Task 2 appends the roster)
- Create: `shared/subscription-roster.test.ts`
- Create: `shared/subscription-prefs.ts`
- Create: `shared/subscription-prefs.test.ts`

**Interfaces:**
- Consumes: `HIDDEN_SUBSCRIPTIONS_SECRET_KEY`, `CONFIRMED_SUBSCRIPTIONS_SECRET_KEY`, `parseHiddenSubscriptions` from `shared/subscriptions.ts`.
- Produces, `shared/subscription-roster.ts`:

```ts
export type Cadence = 'monthly' | 'yearly';
export function addMonthsClamped(iso: string, n: number): string;   // n may be negative
export function addYearsClamped(iso: string, n: number): string;
export function addDaysIso(iso: string, n: number): string;
export function daysBetween(from: string, to: string): number;      // whole days, to − from
export function addPeriod(iso: string, cadence: Cadence, n?: number): string;  // n defaults to 1
export function rollForward(iso: string, cadence: Cadence, today: string): string;
export function localIsoDay(d: Date): string;
export function manualKey(id: string): string;                      // 'm:<id>'
export function isManualKey(key: string): boolean;
```

- Produces, `shared/subscription-prefs.ts`:

```ts
export const SUBSCRIPTION_PREFS_SECRET_KEY = 'subscription_prefs';
export const DELETED_KEEP_DAYS = 7;
export type RemindDays = 1 | 3 | 7;
export interface ManualSubscription { id: string; name: string; cents: number; cadence: Cadence; nextDate: string; merchant?: string }
export interface DeletedSubscription extends ManualSubscription { deletedAt: string }
export interface SubscriptionPrefs {
  v: 1; hidden: string[]; confirmed: string[]; names: Record<string, string>;
  prevNames: Record<string, string | null>; remind: Record<string, RemindDays>;
  manual: ManualSubscription[]; deleted: DeletedSubscription[]; declinedLinks: string[];
}
export type ParsedSubscriptionPrefs = { kind: 'ok'; prefs: SubscriptionPrefs } | { kind: 'absent' } | { kind: 'corrupt' };
export interface LoadedSubscriptionPrefs { prefs: SubscriptionPrefs; unreadable: boolean }
export type SecretGet = (key: string) => Promise<string | null>;
export type SecretSet = (key: string, value: string) => Promise<void>;
export type SubscriptionEdit = (prefs: SubscriptionPrefs) => SubscriptionPrefs;
export class SubscriptionPrefsUnreadableError extends Error {}
export function isUnreadablePrefsError(err: unknown): boolean;
export function emptySubscriptionPrefs(): SubscriptionPrefs;
export function newManualId(random?: () => number): string;
export function parseSubscriptionPrefs(raw: string | null | undefined): ParsedSubscriptionPrefs;
export function loadSubscriptionPrefs(get: SecretGet): Promise<LoadedSubscriptionPrefs>;
export function editSubscriptionPrefs(get: SecretGet, set: SecretSet, edit: SubscriptionEdit, now?: Date): Promise<SubscriptionPrefs>;
export function hideKey(p: SubscriptionPrefs, key: string): SubscriptionPrefs;
export function unhideKey(p: SubscriptionPrefs, key: string): SubscriptionPrefs;
export function confirmKey(p: SubscriptionPrefs, key: string): SubscriptionPrefs;
export function unconfirmKey(p: SubscriptionPrefs, key: string): SubscriptionPrefs;
export function renameKey(p: SubscriptionPrefs, key: string, name: string): SubscriptionPrefs;
export function undoRename(p: SubscriptionPrefs, key: string): SubscriptionPrefs;
export function setRemind(p: SubscriptionPrefs, key: string, days: RemindDays | null): SubscriptionPrefs;
export function addManual(p: SubscriptionPrefs, entry: ManualSubscription): SubscriptionPrefs;
export function updateManual(p: SubscriptionPrefs, id: string, patch: Partial<Pick<ManualSubscription, 'name' | 'cents' | 'cadence' | 'nextDate'>>): SubscriptionPrefs;
export function deleteManual(p: SubscriptionPrefs, id: string, now: Date): SubscriptionPrefs;
export function restoreDeleted(p: SubscriptionPrefs, id: string): SubscriptionPrefs;
export function acceptLink(p: SubscriptionPrefs, link: { manualId: string; merchant: string; date: string }): SubscriptionPrefs;
export function declineLink(p: SubscriptionPrefs, manualId: string, merchant: string): SubscriptionPrefs;
export function pruneDeleted(p: SubscriptionPrefs, now: Date): SubscriptionPrefs;
```

- [ ] **Step 1: Write the failing tests**

Create `shared/subscription-roster.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  addDaysIso, addMonthsClamped, addPeriod, addYearsClamped, daysBetween, isManualKey, localIsoDay, manualKey,
  rollForward,
} from './subscription-roster.js';

describe('addMonthsClamped', () => {
  it.each([
    ['2026-01-15', 1, '2026-02-15'],
    ['2026-01-31', 1, '2026-02-28'],
    ['2028-01-31', 1, '2028-02-29'],
    ['2026-03-31', 1, '2026-04-30'],
    ['2026-12-31', 1, '2027-01-31'],
    ['2026-01-31', 2, '2026-03-31'],
    ['2026-03-15', -3, '2025-12-15'],
    ['2026-03-31', -1, '2026-02-28'],
  ] as const)('%s plus %i months is %s', (iso, n, want) => {
    expect(addMonthsClamped(iso, n)).toBe(want);
  });
});

describe('addYearsClamped', () => {
  it.each([
    ['2028-02-29', 1, '2029-02-28'],
    ['2028-02-29', 4, '2032-02-29'],
    ['2026-10-20', -1, '2025-10-20'],
  ] as const)('%s plus %i years is %s', (iso, n, want) => {
    expect(addYearsClamped(iso, n)).toBe(want);
  });
});

describe('addDaysIso / daysBetween / addPeriod', () => {
  it('adds days across month and year ends', () => {
    expect(addDaysIso('2026-10-30', 3)).toBe('2026-11-02');
    expect(addDaysIso('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDaysIso('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('counts whole days either way, unaffected by daylight saving', () => {
    expect(daysBetween('2026-10-03', '2026-10-12')).toBe(9);
    expect(daysBetween('2026-10-12', '2026-10-03')).toBe(-9);
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetween('2026-10-12', '2026-10-12')).toBe(0);
  });

  it('steps by the cadence', () => {
    expect(addPeriod('2026-10-08', 'monthly')).toBe('2026-11-08');
    expect(addPeriod('2026-10-08', 'yearly')).toBe('2027-10-08');
    expect(addPeriod('2026-10-08', 'monthly', -1)).toBe('2026-09-08');
  });
});

describe('rollForward', () => {
  it('keeps a date that is today or later', () => {
    expect(rollForward('2026-10-12', 'monthly', '2026-10-12')).toBe('2026-10-12');
    expect(rollForward('2026-12-01', 'yearly', '2026-10-12')).toBe('2026-12-01');
  });

  it('rolls a past date by months or by years', () => {
    expect(rollForward('2026-10-03', 'monthly', '2026-10-12')).toBe('2026-11-03');
    expect(rollForward('2025-03-03', 'yearly', '2026-10-12')).toBe('2027-03-03');
  });

  it('counts from the anchor, so a 31st comes back after a short month', () => {
    expect(rollForward('2026-01-31', 'monthly', '2026-03-05')).toBe('2026-03-31');
  });

  it('lands a Feb 29 anchor on Feb 28 in a year without one', () => {
    expect(rollForward('2024-02-29', 'yearly', '2026-10-12')).toBe('2027-02-28');
  });
});

describe('localIsoDay / manual keys', () => {
  it('reads the local calendar day', () => {
    expect(localIsoDay(new Date(2026, 9, 12, 23, 59))).toBe('2026-10-12');
    expect(localIsoDay(new Date(2026, 0, 5, 0, 1))).toBe('2026-01-05');
  });

  it('keys a hand-added entry as m:<id>', () => {
    expect(manualKey('ab12cd34')).toBe('m:ab12cd34');
    expect(isManualKey('m:ab12cd34')).toBe(true);
    expect(isManualKey('SPOTIFY')).toBe(false);
  });
});
```

Create `shared/subscription-prefs.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  acceptLink, addManual, confirmKey, declineLink, deleteManual, editSubscriptionPrefs, emptySubscriptionPrefs,
  hideKey, isUnreadablePrefsError, loadSubscriptionPrefs, newManualId, parseSubscriptionPrefs, pruneDeleted,
  renameKey, restoreDeleted, setRemind, SubscriptionPrefsUnreadableError, SUBSCRIPTION_PREFS_SECRET_KEY,
  unconfirmKey, undoRename, unhideKey, updateManual, type ManualSubscription, type SubscriptionPrefs,
} from './subscription-prefs.js';

const NOW = new Date('2026-10-12T15:00:00Z');
const HULU: ManualSubscription = { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' };
const prefs = (over: Partial<SubscriptionPrefs> = {}): SubscriptionPrefs => ({ ...emptySubscriptionPrefs(), ...over });

/** A Map behind get/set, exactly as both hosts' secrets behave: JSON strings. */
const memory = (entries: Record<string, string> = {}) => {
  const data = new Map(Object.entries(entries));
  return {
    data,
    get: vi.fn(async (k: string) => data.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { data.set(k, v); }),
  };
};

describe('parseSubscriptionPrefs', () => {
  it.each([null, undefined, '', '   '])('reads %j as absent', (raw) => {
    expect(parseSubscriptionPrefs(raw as string | null | undefined)).toEqual({ kind: 'absent' });
  });

  it.each([
    'not json',
    '[]',
    '{"v":2}',
    '{"hidden":[]}',
    '{"v":1,"hidden":"SPOTIFY"}',
    '{"v":1,"remind":{"SPOTIFY":5}}',
    '{"v":1,"names":{"SPOTIFY":7}}',
    '{"v":1,"manual":[{"id":"x","name":"X","cents":0,"cadence":"monthly","nextDate":"2026-10-20"}]}',
    '{"v":1,"manual":[{"id":"x","name":"X","cents":999,"cadence":"weekly","nextDate":"2026-10-20"}]}',
    '{"v":1,"deleted":[{"id":"x","name":"X","cents":999,"cadence":"monthly","nextDate":"2026-10-20"}]}',
  ])('reads %s as corrupt, never as empty', (raw) => {
    expect(parseSubscriptionPrefs(raw)).toEqual({ kind: 'corrupt' });
  });

  it('fills missing fields with defaults', () => {
    expect(parseSubscriptionPrefs('{"v":1}')).toEqual({ kind: 'ok', prefs: emptySubscriptionPrefs() });
  });

  it('round-trips a full document', () => {
    const doc = prefs({
      hidden: ['QR LIBRARY', 'm:hulu0001'], confirmed: ['RENT LLC'], names: { SPOTIFY: 'Spotify' },
      prevNames: { SPOTIFY: null }, remind: { SPOTIFY: 3 }, manual: [{ ...HULU, merchant: 'HULU' }],
      deleted: [{ ...HULU, id: 'gone0001', deletedAt: '2026-10-10T12:00:00.000Z' }],
      declinedLinks: ['hulu0001|DISNEY PLUS'],
    });
    expect(parseSubscriptionPrefs(JSON.stringify(doc))).toEqual({ kind: 'ok', prefs: doc });
  });
});

describe('loadSubscriptionPrefs', () => {
  it('builds the document from the two legacy settings while none is stored', async () => {
    const { get } = memory({ hidden_subscriptions: '["QR LIBRARY"]', confirmed_subscriptions: '["RENT LLC"]' });
    expect(await loadSubscriptionPrefs(get)).toEqual({
      prefs: prefs({ hidden: ['QR LIBRARY'], confirmed: ['RENT LLC'] }), unreadable: false,
    });
  });

  it('prefers the stored document over the legacy settings', async () => {
    const { get } = memory({
      [SUBSCRIPTION_PREFS_SECRET_KEY]: JSON.stringify(prefs({ hidden: ['NETFLIX'] })),
      hidden_subscriptions: '["QR LIBRARY"]',
    });
    expect((await loadSubscriptionPrefs(get)).prefs.hidden).toEqual(['NETFLIX']);
  });

  it('falls back to the legacy lists, flagged unreadable, when the document is corrupt', async () => {
    const { get } = memory({ [SUBSCRIPTION_PREFS_SECRET_KEY]: '{"v":1,"hidden":', hidden_subscriptions: '["QR LIBRARY"]' });
    expect(await loadSubscriptionPrefs(get)).toEqual({ prefs: prefs({ hidden: ['QR LIBRARY'] }), unreadable: true });
  });

  it('lets a failed read reject — unreachable is not empty', async () => {
    await expect(loadSubscriptionPrefs(async () => { throw new Error('ECONNREFUSED'); })).rejects.toThrow('ECONNREFUSED');
  });
});

describe('editSubscriptionPrefs', () => {
  it('re-reads right before writing, so a change made elsewhere since is kept', async () => {
    const m = memory({ [SUBSCRIPTION_PREFS_SECRET_KEY]: JSON.stringify(prefs({ hidden: ['NETFLIX'] })) });
    const written = await editSubscriptionPrefs(m.get, m.set, (p) => hideKey(p, 'SPOTIFY'), NOW);
    expect(written.hidden).toEqual(['NETFLIX', 'SPOTIFY']);
    expect(JSON.parse(m.data.get(SUBSCRIPTION_PREFS_SECRET_KEY)!)).toEqual(written);
  });

  it('imports the legacy lists on the first write and mirrors the result back into them', async () => {
    const m = memory({ hidden_subscriptions: '["QR LIBRARY"]', confirmed_subscriptions: '["RENT LLC"]' });
    await editSubscriptionPrefs(m.get, m.set, (p) => hideKey(p, 'SPOTIFY'), NOW);
    expect(JSON.parse(m.data.get(SUBSCRIPTION_PREFS_SECRET_KEY)!))
      .toMatchObject({ hidden: ['QR LIBRARY', 'SPOTIFY'], confirmed: ['RENT LLC'] });
    expect(m.data.get('hidden_subscriptions')).toBe('["QR LIBRARY","SPOTIFY"]');
    expect(m.data.get('confirmed_subscriptions')).toBe('["RENT LLC"]');
  });

  it('refuses to write over a corrupt document — nothing is touched', async () => {
    const m = memory({ [SUBSCRIPTION_PREFS_SECRET_KEY]: '{"v":1,"hidden":' });
    await expect(editSubscriptionPrefs(m.get, m.set, (p) => hideKey(p, 'SPOTIFY'), NOW))
      .rejects.toBeInstanceOf(SubscriptionPrefsUnreadableError);
    expect(m.set).not.toHaveBeenCalled();
    expect(m.data.get(SUBSCRIPTION_PREFS_SECRET_KEY)).toBe('{"v":1,"hidden":');
  });

  it('keeps hand-added keys out of the legacy mirror — an older reader would take them for merchants', async () => {
    const m = memory();
    await editSubscriptionPrefs(m.get, m.set, (p) => hideKey(hideKey(p, 'm:hulu0001'), 'SPOTIFY'), NOW);
    expect(m.data.get('hidden_subscriptions')).toBe('["SPOTIFY"]');
  });

  it('a failed mirror does not fail a committed edit', async () => {
    const m = memory();
    m.set.mockImplementation(async (k: string, v: string) => {
      if (k !== SUBSCRIPTION_PREFS_SECRET_KEY) throw new Error('mirror down');
      m.data.set(k, v);
    });
    await expect(editSubscriptionPrefs(m.get, m.set, (p) => hideKey(p, 'SPOTIFY'), NOW))
      .resolves.toMatchObject({ hidden: ['SPOTIFY'] });
    expect(JSON.parse(m.data.get(SUBSCRIPTION_PREFS_SECRET_KEY)!).hidden).toEqual(['SPOTIFY']);
  });

  it('prunes week-old deletions on every write', async () => {
    const old = { ...HULU, id: 'old00001', deletedAt: '2026-10-01T12:00:00.000Z' };
    const m = memory({ [SUBSCRIPTION_PREFS_SECRET_KEY]: JSON.stringify(prefs({ deleted: [old] })) });
    expect((await editSubscriptionPrefs(m.get, m.set, (p) => p, NOW)).deleted).toEqual([]);
  });
});

describe('edits', () => {
  it('hide and unhide are idempotent', () => {
    const once = hideKey(prefs(), 'SPOTIFY');
    expect(hideKey(once, 'SPOTIFY').hidden).toEqual(['SPOTIFY']);
    expect(unhideKey(once, 'SPOTIFY').hidden).toEqual([]);
    expect(unhideKey(prefs(), 'SPOTIFY').hidden).toEqual([]);
  });

  it('confirm and unconfirm', () => {
    const yes = confirmKey(prefs(), 'MYSTERY BOX');
    expect(yes.confirmed).toEqual(['MYSTERY BOX']);
    expect(confirmKey(yes, 'MYSTERY BOX').confirmed).toEqual(['MYSTERY BOX']);
    expect(unconfirmKey(yes, 'MYSTERY BOX').confirmed).toEqual([]);
  });

  it('rename keeps one level of history for Undo', () => {
    const first = renameKey(prefs(), 'SPOTIFY', '  Spotify ');
    expect(first.names).toEqual({ SPOTIFY: 'Spotify' });
    expect(first.prevNames).toEqual({ SPOTIFY: null });
    const second = renameKey(first, 'SPOTIFY', 'Spotify Duo');
    expect(second.prevNames).toEqual({ SPOTIFY: 'Spotify' });
    const undone = undoRename(second, 'SPOTIFY');
    expect(undone.names).toEqual({ SPOTIFY: 'Spotify' });
    expect(undone.prevNames).toEqual({});
    expect(undoRename(first, 'SPOTIFY').names).toEqual({});
    expect(undoRename(prefs(), 'SPOTIFY')).toEqual(prefs());
  });

  it('a blank rename changes nothing', () => {
    expect(renameKey(prefs(), 'SPOTIFY', '   ')).toEqual(prefs());
  });

  it('sets and clears a reminder', () => {
    const on = setRemind(prefs(), 'SPOTIFY', 3);
    expect(on.remind).toEqual({ SPOTIFY: 3 });
    expect(setRemind(on, 'SPOTIFY', null).remind).toEqual({});
  });

  it('adds and updates a hand-added entry', () => {
    const added = addManual(prefs(), HULU);
    expect(added.manual).toEqual([HULU]);
    expect(updateManual(added, 'hulu0001', { cents: 1099, cadence: 'yearly', nextDate: '2027-01-05' }).manual)
      .toEqual([{ ...HULU, cents: 1099, cadence: 'yearly', nextDate: '2027-01-05' }]);
  });

  it('delete leaves a tombstone that restore brings back', () => {
    const gone = deleteManual(addManual(prefs(), HULU), 'hulu0001', NOW);
    expect(gone.manual).toEqual([]);
    expect(gone.deleted).toEqual([{ ...HULU, deletedAt: '2026-10-12T15:00:00.000Z' }]);
    const back = restoreDeleted(gone, 'hulu0001');
    expect(back.manual).toEqual([HULU]);
    expect(back.deleted).toEqual([]);
  });

  it('accepting a link sets the merchant and next date, and moves hide and reminder to the hand-added key', () => {
    const before = prefs({ manual: [HULU], hidden: ['HULU'], remind: { HULU: 3 } });
    const after = acceptLink(before, { manualId: 'hulu0001', merchant: 'HULU', date: '2026-10-08' });
    expect(after.manual).toEqual([{ ...HULU, merchant: 'HULU', nextDate: '2026-11-08' }]);
    expect(after.hidden).toEqual(['m:hulu0001']);
    expect(after.remind).toEqual({ 'm:hulu0001': 3 });
  });

  it('a yearly link moves the next date a year on', () => {
    const yearly = { ...HULU, cadence: 'yearly' as const };
    expect(acceptLink(prefs({ manual: [yearly] }), { manualId: 'hulu0001', merchant: 'HULU', date: '2026-10-08' })
      .manual[0].nextDate).toBe('2027-10-08');
  });

  it("a link keeps the hand-added entry's own reminder over the merchant's", () => {
    const after = acceptLink(
      prefs({ manual: [HULU], remind: { HULU: 7, 'm:hulu0001': 1 } }),
      { manualId: 'hulu0001', merchant: 'HULU', date: '2026-10-08' },
    );
    expect(after.remind).toEqual({ 'm:hulu0001': 1 });
  });

  it('declining remembers the pair once', () => {
    expect(declineLink(declineLink(prefs(), 'hulu0001', 'HULU'), 'hulu0001', 'HULU').declinedLinks)
      .toEqual(['hulu0001|HULU']);
  });

  it('pruning drops week-old tombstones with everything keyed to them', () => {
    const fresh = { ...HULU, id: 'new00001', deletedAt: '2026-10-06T15:00:00.000Z' };
    const old = { ...HULU, id: 'old00001', deletedAt: '2026-10-04T15:00:00.000Z' };
    const pruned = pruneDeleted(prefs({
      deleted: [fresh, old],
      names: { 'm:old00001': 'Old', 'm:new00001': 'New' }, remind: { 'm:old00001': 3 },
      hidden: ['m:old00001'], declinedLinks: ['old00001|HULU', 'new00001|HULU'],
    }), NOW);
    expect(pruned.deleted).toEqual([fresh]);
    expect(pruned.names).toEqual({ 'm:new00001': 'New' });
    expect(pruned.remind).toEqual({});
    expect(pruned.hidden).toEqual([]);
    expect(pruned.declinedLinks).toEqual(['new00001|HULU']);
  });

  it('makes 8-character ids', () => {
    expect(newManualId(() => 0.5)).toBe('iiiiiiii');
    expect(newManualId()).toMatch(/^[0-9a-z]{8}$/);
  });

  it('recognises the refusal by class or by name', () => {
    expect(isUnreadablePrefsError(new SubscriptionPrefsUnreadableError())).toBe(true);
    expect(isUnreadablePrefsError({ name: 'SubscriptionPrefsUnreadableError' })).toBe(true);
    expect(isUnreadablePrefsError(new Error('x'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run shared/subscription-roster.test.ts shared/subscription-prefs.test.ts`
Expected: FAIL — `Failed to resolve import "./subscription-roster.js"` / `"./subscription-prefs.js"`.

- [ ] **Step 3: Implement the date and key helpers**

Create `shared/subscription-roster.ts`:

```ts
/**
 * shared/subscription-roster.ts
 *
 * ONE roster every subscription surface renders from — the app card, the
 * mini app, `/subscriptions`, the weekly line and the daily "Coming up"
 * block — so the "what counts" filter cannot drift between hand copies again.
 * Pure: the cube, the stored document and `today` come in; nothing is read.
 *
 * This first section is the date and key arithmetic the stored document's
 * edits need as well (shared/subscription-prefs.ts imports it; this module
 * imports only TYPES from there, so there is no runtime cycle). Dates are
 * YYYY-MM-DD strings, computed in UTC so a host's zone can never shift a day;
 * `today` is always the caller's local calendar day.
 */

export type Cadence = 'monthly' | 'yearly';

const DAY_MS = 86_400_000;
const pad2 = (n: number) => String(n).padStart(2, '0');
const isoOf = (y: number, m1: number, d: number) => `${y}-${pad2(m1)}-${pad2(d)}`;
const ymd = (iso: string): [number, number, number] =>
  [Number(iso.slice(0, 4)), Number(iso.slice(5, 7)), Number(iso.slice(8, 10))];
/** Days in month `m1` (1–12): day 0 of the following month is this month's last. */
const daysInMonth = (y: number, m1: number) => new Date(Date.UTC(y, m1, 0)).getUTCDate();

/** `iso` plus `n` months (negative allowed), the day clamped to the target
 *  month: Jan 31 + 1 → Feb 28, or Feb 29 in a leap year. */
export function addMonthsClamped(iso: string, n: number): string {
  const [y, m, d] = ymd(iso);
  const total = y * 12 + (m - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  return isoOf(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

/** `iso` plus `n` years, Feb 29 clamped to Feb 28 in a year without one. */
export function addYearsClamped(iso: string, n: number): string {
  const [y, m, d] = ymd(iso);
  return isoOf(y + n, m, Math.min(d, daysInMonth(y + n, m)));
}

export function addDaysIso(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` — negative when `to` is earlier. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** `n` periods after `iso`: months or years by cadence, day clamped. */
export function addPeriod(iso: string, cadence: Cadence, n = 1): string {
  return cadence === 'yearly' ? addYearsClamped(iso, n) : addMonthsClamped(iso, n);
}

/** The first of `iso`, `iso` + 1 period, `iso` + 2 periods … that is today or
 *  later. Always counted from `iso` itself, so a 31st stays the 31st wherever
 *  the month allows (Jan 31 → Feb 28 → Mar 31) instead of drifting to the 28th. */
export function rollForward(iso: string, cadence: Cadence, today: string): string {
  if (iso >= today) return iso;
  for (let n = 1; ; n += 1) {
    const next = addPeriod(iso, cadence, n);
    if (next >= today) return next;
  }
}

/** The local calendar day of `d` — what "today" means to the person reading. */
export function localIsoDay(d: Date): string {
  return isoOf(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

const MANUAL_PREFIX = 'm:';

/** A hand-added entry's roster key — kept even after it is linked to a merchant. */
export function manualKey(id: string): string {
  return `${MANUAL_PREFIX}${id}`;
}

export function isManualKey(key: string): boolean {
  return key.startsWith(MANUAL_PREFIX);
}
```

- [ ] **Step 4: Implement the document**

Create `shared/subscription-prefs.ts`:

```ts
/**
 * shared/subscription-prefs.ts
 *
 * The ONE stored document behind every subscription choice: what is hidden,
 * confirmed, renamed, reminded about, and added by hand. Two writers share it
 * — the app and the Telegram bot — so every write goes through
 * `editSubscriptionPrefs`, which re-reads the stored copy immediately before
 * writing and applies one of the pure edits below. Both writers call the same
 * edits, so a tap cannot mean one thing in the app and another in the chat.
 *
 * Corrupt is not absent. A document that exists but cannot be read refuses
 * every write: treating it as empty and saving would wipe every choice.
 *
 * `hidden` and `confirmed` are also written to the two pre-1.60 settings on
 * every edit, so an older companion or a stale tab reads correct lists during
 * an upgrade. Removing that mirror is a follow-up, one release after this.
 */
import {
  CONFIRMED_SUBSCRIPTIONS_SECRET_KEY, HIDDEN_SUBSCRIPTIONS_SECRET_KEY, parseHiddenSubscriptions,
} from './subscriptions.js';
import { addPeriod, isManualKey, manualKey, type Cadence } from './subscription-roster.js';

export const SUBSCRIPTION_PREFS_SECRET_KEY = 'subscription_prefs';
/** Days a deleted hand-added entry is kept for ↩ Undo. */
export const DELETED_KEEP_DAYS = 7;

export type RemindDays = 1 | 3 | 7;

export interface ManualSubscription {
  /** Short random id; the roster key is `m:<id>`, linked or not. */
  id: string;
  name: string;
  cents: number;
  cadence: Cadence;
  /** YYYY-MM-DD, as entered or as set when linked; the roster rolls it forward. */
  nextDate: string;
  /** The detector's name for its charges, once linked. */
  merchant?: string;
}

export interface DeletedSubscription extends ManualSubscription { deletedAt: string }

export interface SubscriptionPrefs {
  v: 1;
  /** Roster keys. */
  hidden: string[];
  /** Detector keys counted as subscriptions whatever their tier. */
  confirmed: string[];
  /** Key → display name. */
  names: Record<string, string>;
  /** One level of history for ↩ Undo on a rename; null = there was no name. */
  prevNames: Record<string, string | null>;
  /** Key → days of warning before a charge. */
  remind: Record<string, RemindDays>;
  manual: ManualSubscription[];
  /** ↩ Undo for a delete; pruned after DELETED_KEEP_DAYS. */
  deleted: DeletedSubscription[];
  /** `${manualId}|${merchant}` — a "No" to a link suggestion sticks. */
  declinedLinks: string[];
}

export type ParsedSubscriptionPrefs =
  | { kind: 'ok'; prefs: SubscriptionPrefs }
  | { kind: 'absent' }
  | { kind: 'corrupt' };

export interface LoadedSubscriptionPrefs {
  prefs: SubscriptionPrefs;
  /** A stored document exists but cannot be read: `prefs` is then the legacy
   *  lists, for reading only, and every write is refused. */
  unreadable: boolean;
}

export type SecretGet = (key: string) => Promise<string | null>;
export type SecretSet = (key: string, value: string) => Promise<void>;
export type SubscriptionEdit = (prefs: SubscriptionPrefs) => SubscriptionPrefs;

export class SubscriptionPrefsUnreadableError extends Error {
  constructor() {
    super('subscription_prefs is unreadable; refusing to overwrite it');
    this.name = 'SubscriptionPrefsUnreadableError';
  }
}

/** By name as well as by class: a bundle or a test double can carry its own copy of the class. */
export function isUnreadablePrefsError(err: unknown): boolean {
  return err instanceof SubscriptionPrefsUnreadableError
    || (typeof err === 'object' && err !== null
      && (err as { name?: unknown }).name === 'SubscriptionPrefsUnreadableError');
}

export function emptySubscriptionPrefs(): SubscriptionPrefs {
  return {
    v: 1, hidden: [], confirmed: [], names: {}, prevNames: {}, remind: {},
    manual: [], deleted: [], declinedLinks: [],
  };
}

/** 8 base-36 characters; `random` is injectable for tests. */
export function newManualId(random: () => number = Math.random): string {
  let id = '';
  for (let i = 0; i < 8; i += 1) id += Math.floor(random() * 36).toString(36);
  return id;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const INVALID = Symbol('invalid');
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
const recordOf = (v: unknown, ok: (x: unknown) => boolean): boolean => isRecord(v) && Object.values(v).every(ok);
const isRemind = (x: unknown): x is RemindDays => x === 1 || x === 3 || x === 7;

function isManual(v: unknown): v is ManualSubscription {
  if (!isRecord(v)) return false;
  return typeof v.id === 'string' && v.id !== ''
    && typeof v.name === 'string'
    && Number.isInteger(v.cents) && (v.cents as number) > 0
    && (v.cadence === 'monthly' || v.cadence === 'yearly')
    && typeof v.nextDate === 'string' && ISO_DAY.test(v.nextDate)
    && (v.merchant === undefined || typeof v.merchant === 'string');
}

const isDeleted = (v: unknown): v is DeletedSubscription =>
  isManual(v) && typeof (v as { deletedAt?: unknown }).deletedAt === 'string';

export function parseSubscriptionPrefs(raw: string | null | undefined): ParsedSubscriptionPrefs {
  // '' is how the companion clears a secret: its API has no delete.
  if (raw === null || raw === undefined || raw.trim() === '') return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'corrupt' };
  }
  if (!isRecord(parsed) || parsed.v !== 1) return { kind: 'corrupt' };
  const doc = parsed;
  // A missing field is its default; a present field of the wrong shape is
  // corruption — guessing there is exactly how a write wipes a choice.
  const field = <T>(name: string, ok: (x: unknown) => boolean, fallback: T): T | typeof INVALID =>
    doc[name] === undefined ? fallback : ok(doc[name]) ? (doc[name] as T) : INVALID;
  const empty = emptySubscriptionPrefs();
  const prefs = {
    v: 1 as const,
    hidden: field('hidden', isStringArray, empty.hidden),
    confirmed: field('confirmed', isStringArray, empty.confirmed),
    names: field('names', (x) => recordOf(x, (s) => typeof s === 'string'), empty.names),
    prevNames: field('prevNames', (x) => recordOf(x, (s) => s === null || typeof s === 'string'), empty.prevNames),
    remind: field('remind', (x) => recordOf(x, isRemind), empty.remind),
    manual: field('manual', (x) => Array.isArray(x) && x.every(isManual), empty.manual),
    deleted: field('deleted', (x) => Array.isArray(x) && x.every(isDeleted), empty.deleted),
    declinedLinks: field('declinedLinks', isStringArray, empty.declinedLinks),
  };
  if (Object.values(prefs).some((x) => x === INVALID)) return { kind: 'corrupt' };
  return { kind: 'ok', prefs: prefs as SubscriptionPrefs };
}

async function legacySubscriptionPrefs(get: SecretGet): Promise<SubscriptionPrefs> {
  const [hidden, confirmed] = await Promise.all([
    get(HIDDEN_SUBSCRIPTIONS_SECRET_KEY),
    get(CONFIRMED_SUBSCRIPTIONS_SECRET_KEY),
  ]);
  return { ...emptySubscriptionPrefs(), hidden: parseHiddenSubscriptions(hidden), confirmed: parseHiddenSubscriptions(confirmed) };
}

/** The document, or — while none is stored — one built from the two legacy
 *  settings, so nothing hidden or confirmed before 1.60 is lost. A failed read
 *  rejects: unreachable must never read as "nothing chosen". */
export async function loadSubscriptionPrefs(get: SecretGet): Promise<LoadedSubscriptionPrefs> {
  const parsed = parseSubscriptionPrefs(await get(SUBSCRIPTION_PREFS_SECRET_KEY));
  if (parsed.kind === 'ok') return { prefs: parsed.prefs, unreadable: false };
  return { prefs: await legacySubscriptionPrefs(get), unreadable: parsed.kind === 'corrupt' };
}

/**
 * The only write. Re-reads immediately before writing (two writers, no
 * compare-and-swap; taps are human-paced, so the residual race is accepted),
 * applies `edit`, prunes old deletions, writes, then mirrors `hidden` and
 * `confirmed` into the legacy settings. The mirror is best-effort: the
 * document is the commit, and a failed mirror must not make a saved edit
 * look failed (a retried "add" would add twice).
 */
export async function editSubscriptionPrefs(
  get: SecretGet,
  set: SecretSet,
  edit: SubscriptionEdit,
  now: Date = new Date(),
): Promise<SubscriptionPrefs> {
  const parsed = parseSubscriptionPrefs(await get(SUBSCRIPTION_PREFS_SECRET_KEY));
  if (parsed.kind === 'corrupt') throw new SubscriptionPrefsUnreadableError();
  const base = parsed.kind === 'ok' ? parsed.prefs : await legacySubscriptionPrefs(get);
  const next = pruneDeleted(edit(base), now);
  await set(SUBSCRIPTION_PREFS_SECRET_KEY, JSON.stringify(next));
  try {
    await set(HIDDEN_SUBSCRIPTIONS_SECRET_KEY, JSON.stringify(next.hidden.filter((k) => !isManualKey(k))));
    await set(CONFIRMED_SUBSCRIPTIONS_SECRET_KEY, JSON.stringify(next.confirmed));
  } catch {
    // Best-effort; see above.
  }
  return next;
}

const without = (list: string[], key: string) => list.filter((k) => k !== key);
const withKey = (list: string[], key: string) => (list.includes(key) ? list : [...list, key]);

export function hideKey(p: SubscriptionPrefs, key: string): SubscriptionPrefs {
  return { ...p, hidden: withKey(p.hidden, key) };
}

export function unhideKey(p: SubscriptionPrefs, key: string): SubscriptionPrefs {
  return { ...p, hidden: without(p.hidden, key) };
}

export function confirmKey(p: SubscriptionPrefs, key: string): SubscriptionPrefs {
  return { ...p, confirmed: withKey(p.confirmed, key) };
}

export function unconfirmKey(p: SubscriptionPrefs, key: string): SubscriptionPrefs {
  return { ...p, confirmed: without(p.confirmed, key) };
}

/** Records the name it replaces (one level) for ↩ Undo. Blank changes nothing. */
export function renameKey(p: SubscriptionPrefs, key: string, name: string): SubscriptionPrefs {
  const trimmed = name.trim();
  if (trimmed === '') return p;
  return {
    ...p,
    names: { ...p.names, [key]: trimmed },
    prevNames: { ...p.prevNames, [key]: p.names[key] ?? null },
  };
}

export function undoRename(p: SubscriptionPrefs, key: string): SubscriptionPrefs {
  if (!(key in p.prevNames)) return p;
  const prev = p.prevNames[key];
  const names = { ...p.names };
  if (prev === null) delete names[key];
  else names[key] = prev;
  const prevNames = { ...p.prevNames };
  delete prevNames[key];
  return { ...p, names, prevNames };
}

export function setRemind(p: SubscriptionPrefs, key: string, days: RemindDays | null): SubscriptionPrefs {
  const remind = { ...p.remind };
  if (days === null) delete remind[key];
  else remind[key] = days;
  return { ...p, remind };
}

export function addManual(p: SubscriptionPrefs, entry: ManualSubscription): SubscriptionPrefs {
  return { ...p, manual: [...p.manual.filter((m) => m.id !== entry.id), entry] };
}

export function updateManual(
  p: SubscriptionPrefs,
  id: string,
  patch: Partial<Pick<ManualSubscription, 'name' | 'cents' | 'cadence' | 'nextDate'>>,
): SubscriptionPrefs {
  return { ...p, manual: p.manual.map((m) => (m.id === id ? { ...m, ...patch } : m)) };
}

export function deleteManual(p: SubscriptionPrefs, id: string, now: Date): SubscriptionPrefs {
  const entry = p.manual.find((m) => m.id === id);
  if (!entry) return p;
  return {
    ...p,
    manual: p.manual.filter((m) => m.id !== id),
    deleted: [...p.deleted.filter((d) => d.id !== id), { ...entry, deletedAt: now.toISOString() }],
  };
}

export function restoreDeleted(p: SubscriptionPrefs, id: string): SubscriptionPrefs {
  const entry = p.deleted.find((d) => d.id === id);
  if (!entry) return p;
  const { deletedAt: _deletedAt, ...manual } = entry;
  return {
    ...p,
    deleted: p.deleted.filter((d) => d.id !== id),
    manual: [...p.manual.filter((m) => m.id !== id), manual],
  };
}

/** "Yes, HULU is my Hulu": the entry takes the merchant, its next date becomes
 *  the charge + one period, and a hide or reminder the user had set on the
 *  merchant moves to the hand-added key (its own reminder wins). */
export function acceptLink(
  p: SubscriptionPrefs,
  link: { manualId: string; merchant: string; date: string },
): SubscriptionPrefs {
  const entry = p.manual.find((m) => m.id === link.manualId);
  if (!entry) return p;
  const key = manualKey(entry.id);
  const hidden = p.hidden.includes(link.merchant) ? withKey(without(p.hidden, link.merchant), key) : p.hidden;
  const remind = { ...p.remind };
  if (link.merchant in remind) {
    if (!(key in remind)) remind[key] = remind[link.merchant];
    delete remind[link.merchant];
  }
  return {
    ...p,
    hidden,
    remind,
    manual: p.manual.map((m) => (m.id === entry.id
      ? { ...m, merchant: link.merchant, nextDate: addPeriod(link.date, m.cadence) }
      : m)),
  };
}

export function declineLink(p: SubscriptionPrefs, manualId: string, merchant: string): SubscriptionPrefs {
  return { ...p, declinedLinks: withKey(p.declinedLinks, `${manualId}|${merchant}`) };
}

/** Drops tombstones older than DELETED_KEEP_DAYS, with every name, reminder,
 *  hide and declined link keyed to them. */
export function pruneDeleted(p: SubscriptionPrefs, now: Date): SubscriptionPrefs {
  const cutoff = now.getTime() - DELETED_KEEP_DAYS * 86_400_000;
  const gone = p.deleted.filter((d) => !(Date.parse(d.deletedAt) >= cutoff));
  if (gone.length === 0) return p;
  const goneIds = new Set(gone.map((d) => d.id));
  const goneKeys = new Set(gone.map((d) => manualKey(d.id)));
  const dropKeys = <T>(rec: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(rec).filter(([k]) => !goneKeys.has(k)));
  return {
    ...p,
    deleted: p.deleted.filter((d) => !goneIds.has(d.id)),
    hidden: p.hidden.filter((k) => !goneKeys.has(k)),
    names: dropKeys(p.names),
    prevNames: dropKeys(p.prevNames),
    remind: dropKeys(p.remind),
    declinedLinks: p.declinedLinks.filter((x) => !goneIds.has(x.split('|')[0])),
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run shared/subscription-roster.test.ts shared/subscription-prefs.test.ts`
Expected: PASS.

Run: `npm run type-check && npm --prefix companion run build`
Expected: both succeed (the companion build compiles `shared/`).

- [ ] **Step 6: Commit**

```bash
git add shared/subscription-roster.ts shared/subscription-roster.test.ts shared/subscription-prefs.ts shared/subscription-prefs.test.ts
git commit -m "Subscriptions: one stored document, its edits, and month-end-safe date helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 2: The roster

**Files:**
- Create: `shared/handle.ts`
- Modify: `shared/findings.ts` (`findingHandle`, ~line 87-104 — moved out, re-exported)
- Modify: `shared/subscriptions.ts` (`DetectedSubscription` ~line 36-53; `found.push` in `detectSubscriptions` ~line 138-149)
- Test: `shared/subscriptions.test.ts`
- Modify: `companion/src/report-cube-build.test.ts` (the `'detects subscriptions from dated merchant rows'` expectation, ~line 78-81)
- Modify: `shared/subscription-roster.ts` (append)
- Test: `shared/subscription-roster.test.ts` (append)

**Interfaces:**
- Consumes: Task 1 helpers and types; `CubeMerchant` from `shared/report-cube.ts`; `DetectedSubscription` from `shared/subscriptions.ts`.
- Produces:
  - `shared/handle.ts`: `export function findingHandle(key: string): string` (moved verbatim; `shared/findings.ts` re-exports it, so every existing import keeps working).
  - `DetectedSubscription.recent?: Array<{ date: string; cents: number }>` — newest three charges, newest first.
  - In `shared/subscription-roster.ts`:

```ts
export type RosterGroup = 'subscription' | 'bill' | 'maybe';
export interface RosterEntry {
  key: string; displayName: string; bankName?: string;
  group: RosterGroup; source: 'detected' | 'watched' | 'manual';
  cents: number; cadence: Cadence;
  nextDate: string | null; late?: boolean; overdueSince?: string;
  creep?: { fromCents: number; toCents: number; chargedOn: string };
  remind?: RemindDays;
  recent: Array<{ date: string; cents: number }>;
  handle: string;
}
export interface CubeLink { manualId: string; merchant: string; date: string; cents: number }
export interface RosterLinkSuggestion extends CubeLink { manualName: string }
export interface Roster {
  subscriptions: RosterEntry[]; bills: RosterEntry[]; maybes: RosterEntry[]; hidden: RosterEntry[];
  monthlyCents: number; yearlyCents: number; billsMonthlyCents: number;
  linkSuggestions: RosterLinkSuggestion[]; detectionAvailable: boolean;
}
export interface RosterInput {
  detected: readonly DetectedSubscription[] | null | undefined;
  merchants: ReadonlyArray<readonly CubeMerchant[]> | null | undefined;
  links: readonly unknown[] | null | undefined;
  prefs: SubscriptionPrefs;
  today: string;
}
export const LATE_GRACE_DAYS = 7;
export function buildRoster(input: RosterInput): Roster;
export function dueWithin(roster: Roster, today: string, days: number): RosterEntry[];
export function monthDay(iso: string): string;            // 'Oct 5'
export function rosterMoney(cents: number): string;       // '$11.99', '$99', '$1,250.50'
export function aboutDollars(cents: number): string;      // '$61'
export function rosterAmount(e: RosterEntry): string;     // '$11.99' | '$99/yr' | 'about $61' | 'no price yet'
export function rosterPrice(e: RosterEntry): string;      // rosterAmount + '/mo' for priced monthly entries
export function rosterWhen(e: RosterEntry): string;       // 'next Oct 15' | 'due Oct 8, not charged yet' | "expected Oct 3, hasn't charged" | 'watching'
export function formatRosterTotal(roster: Roster): string; // '$39.97/mo + $99/yr' (yearly part only when non-zero)
```

**Why the handle moves:** `shared/telegram.ts` will import the roster (Task 5), and `shared/findings.ts` → `shared/self-check.ts` → `shared/telegram.ts` would close a runtime import cycle. A leaf module breaks it.

- [ ] **Step 1: Write the failing tests**

Append to `shared/subscriptions.test.ts`:

```ts
describe('recent charges (1.60)', () => {
  it('publishes the newest three charges, newest first', () => {
    const [found] = detectSubscriptions([
      charge('2026-05-15', 'NETFLIX.COM', 1549), charge('2026-06-15', 'NETFLIX.COM', 1549),
      charge('2026-07-15', 'NETFLIX.COM', 1549), charge('2026-08-15', 'NETFLIX.COM', 1599),
    ], NOW);
    expect(found.recent).toEqual([
      { date: '2026-08-15', cents: 1599 }, { date: '2026-07-15', cents: 1549 }, { date: '2026-06-15', cents: 1549 },
    ]);
  });

  it('a two-charge group publishes both', () => {
    const [found] = detectSubscriptions([charge('2026-07-20', 'SPOTIFY USA', 1199), charge('2026-08-20', 'SPOTIFY USA', 1199)], NOW);
    expect(found.recent).toEqual([{ date: '2026-08-20', cents: 1199 }, { date: '2026-07-20', cents: 1199 }]);
  });
});
```

In `companion/src/report-cube-build.test.ts`, test `'detects subscriptions from dated merchant rows'`, extend the expected object with the new field:

```ts
    expect(cube.subscriptions).toEqual([{
      name: 'NETFLIX.COM', monthlyCents: 1549, count: 3,
      lastDate: '2026-08-26', lastCents: 1549, prevCents: 1549, creep: false, kind: 'subscription',
      recent: [
        { date: '2026-08-26', cents: 1549 }, { date: '2026-07-29', cents: 1549 }, { date: '2026-07-01', cents: 1549 },
      ],
    }]);
```

Append to `shared/subscription-roster.test.ts` (add these imports at the top of the file, extending the existing `./subscription-roster.js` import):

```ts
import { findingHandle } from './handle.js';
import { emptySubscriptionPrefs, type SubscriptionPrefs } from './subscription-prefs.js';
import type { DetectedSubscription } from './subscriptions.js';
import {
  aboutDollars, buildRoster, dueWithin, formatRosterTotal, monthDay, rosterAmount, rosterMoney, rosterPrice,
  rosterWhen, type RosterInput,
} from './subscription-roster.js';
```

```ts
const TODAY = '2026-10-12';
/** DetectedSubscription exactly as a 1.60 companion publishes it in the cube. */
const det = (name: string, over: Partial<DetectedSubscription> = {}): DetectedSubscription => {
  const lastDate = over.lastDate ?? '2026-09-15';
  const lastCents = over.lastCents ?? over.monthlyCents ?? 1199;
  return {
    name, monthlyCents: 1199, count: 4, lastDate, lastCents, prevCents: lastCents, creep: false, kind: 'subscription',
    recent: [{ date: lastDate, cents: lastCents }], ...over,
  };
};
const prefsWith = (over: Partial<SubscriptionPrefs> = {}): SubscriptionPrefs => ({ ...emptySubscriptionPrefs(), ...over });
const roster = (over: Partial<RosterInput> = {}) =>
  buildRoster({ detected: [], merchants: [[], []], links: [], prefs: prefsWith(), today: TODAY, ...over });
const names = (list: Array<{ displayName: string }>) => list.map((e) => e.displayName);

describe('buildRoster — groups', () => {
  it('sorts detections into subscriptions, bills and maybes; a kindless row is a subscription', () => {
    const r = roster({ detected: [
      det('SPOTIFY'),
      det('LG&E', { kind: 'bill', monthlyCents: 6149 }),
      det('MYSTERY BOX', { kind: 'possible', monthlyCents: 1500, count: 2 }),
      det('OLD CUBE ROW', { kind: undefined, monthlyCents: 499 }),
    ] });
    expect(names(r.subscriptions)).toEqual(['SPOTIFY', 'OLD CUBE ROW']);
    expect(names(r.bills)).toEqual(['LG&E']);
    expect(names(r.maybes)).toEqual(['MYSTERY BOX']);
    expect(r.detectionAvailable).toBe(true);
  });

  it('a confirmed bill or maybe counts as a subscription', () => {
    const r = roster({
      detected: [det('RENT LLC', { kind: 'bill', monthlyCents: 90000 }), det('MYSTERY BOX', { kind: 'possible' })],
      prefs: prefsWith({ confirmed: ['RENT LLC', 'MYSTERY BOX'] }),
    });
    expect(names(r.subscriptions)).toEqual(['RENT LLC', 'MYSTERY BOX']);
    expect(r.bills).toEqual([]);
    expect(r.maybes).toEqual([]);
  });

  it('hidden entries leave their group and every total', () => {
    const r = roster({
      detected: [det('SPOTIFY'), det('QR LIBRARY', { monthlyCents: 499 }), det('LG&E', { kind: 'bill', monthlyCents: 6149 })],
      prefs: prefsWith({ hidden: ['QR LIBRARY', 'LG&E'] }),
    });
    expect(names(r.subscriptions)).toEqual(['SPOTIFY']);
    expect(names(r.hidden)).toEqual(['LG&E', 'QR LIBRARY']);
    expect(r.monthlyCents).toBe(1199);
    expect(r.billsMonthlyCents).toBe(0);
  });

  it('shows a rename, keeping the bank name beside it', () => {
    const r = roster({ detected: [det('SPOTIFY')], prefs: prefsWith({ names: { SPOTIFY: 'Spotify' } }) });
    expect(r.subscriptions[0]).toMatchObject({ key: 'SPOTIFY', displayName: 'Spotify', bankName: 'SPOTIFY' });
    expect(roster({ detected: [det('SPOTIFY')] }).subscriptions[0].bankName).toBeUndefined();
  });

  it('prices a watched name from its newest month among the last three', () => {
    const r = roster({
      merchants: [
        [{ name: 'ANTHROPIC* CLAUDE SUB', cents: 1800, count: 1 }],
        [{ name: 'ANTHROPIC* CLAUDE SUB', cents: 2000, count: 1 }],
        [],
      ],
      prefs: prefsWith({ confirmed: ['ANTHROPIC* CLAUDE SUB', 'NEVER SEEN'] }),
    });
    expect(r.subscriptions.map((e) => [e.displayName, e.source, e.cents, e.nextDate])).toEqual([
      ['ANTHROPIC* CLAUDE SUB', 'watched', 2000, null],
      ['NEVER SEEN', 'watched', 0, null],
    ]);
    expect(rosterAmount(r.subscriptions[1])).toBe('no price yet');
    expect(rosterWhen(r.subscriptions[0])).toBe('watching');
  });
});

describe('buildRoster — next charge date', () => {
  it('is the last charge plus a month', () => {
    expect(roster({ detected: [det('SPOTIFY', { lastDate: '2026-09-15' })] }).subscriptions[0].nextDate).toBe('2026-10-15');
  });

  // Review Focus: a charge on the 31st.
  it('clamps a 31st to the month end, Feb 29 included', () => {
    expect(roster({ today: '2026-02-10', detected: [det('GYM', { lastDate: '2026-01-31' })] }).subscriptions[0].nextDate).toBe('2026-02-28');
    expect(roster({ today: '2028-02-10', detected: [det('GYM', { lastDate: '2028-01-31' })] }).subscriptions[0].nextDate).toBe('2028-02-29');
    expect(roster({ today: '2026-04-01', detected: [det('GYM', { lastDate: '2026-03-31' })] }).subscriptions[0].nextDate).toBe('2026-04-30');
  });

  // Review Focus: a charge on the 31st.
  it('a hand-added 31st comes back as the 31st after a short month', () => {
    const r = roster({
      today: '2026-03-05',
      prefs: prefsWith({ manual: [{ id: 'gym00001', name: 'Gym', cents: 4000, cadence: 'monthly', nextDate: '2026-01-31' }] }),
    });
    expect(r.subscriptions[0].nextDate).toBe('2026-03-31');
  });

  it('up to 7 days past: still listed, marked late', () => {
    expect(roster({ detected: [det('SPOTIFY', { lastDate: '2026-09-08' })] }).subscriptions[0]).toMatchObject({ nextDate: '2026-10-08', late: true });
    expect(roster({ detected: [det('SPOTIFY', { lastDate: '2026-09-05' })] }).subscriptions[0]).toMatchObject({ nextDate: '2026-10-05', late: true });
  });

  it('more than 7 days past: no next date, overdue since the missed one', () => {
    const e = roster({ detected: [det('NETFLIX', { lastDate: '2026-09-03' })] }).subscriptions[0];
    expect(e.nextDate).toBeNull();
    expect(e.overdueSince).toBe('2026-10-03');
    expect(e.late).toBeUndefined();
    expect(rosterWhen(e)).toBe("expected Oct 3, hasn't charged");
  });

  it('a hand-added entry rolls forward by its cadence and is never late or overdue', () => {
    const r = roster({ prefs: prefsWith({ manual: [
      { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-03' },
      { id: 'dom00001', name: 'Domain', cents: 1500, cadence: 'yearly', nextDate: '2025-03-03' },
    ] }) });
    expect(r.subscriptions.map((e) => [e.key, e.nextDate, e.late ?? false, e.overdueSince ?? null])).toEqual([
      ['m:hulu0001', '2026-11-03', false, null],
      ['m:dom00001', '2027-03-03', false, null],
    ]);
  });
});

describe('buildRoster — what detection adds', () => {
  it('a price rise shows the new price, the old one kept for the creep line', () => {
    const e = roster({ detected: [det('NETFLIX', { monthlyCents: 1549, lastCents: 1799, creep: true, lastDate: '2026-10-10' })] }).subscriptions[0];
    expect(e.cents).toBe(1799);
    expect(e.creep).toEqual({ fromCents: 1549, toCents: 1799, chargedOn: '2026-10-10' });
  });

  it('lists the newest three charges, falling back to the last charge on older cubes', () => {
    const recent = [{ date: '2026-09-15', cents: 1199 }, { date: '2026-08-15', cents: 1199 }, { date: '2026-07-15', cents: 1099 }];
    expect(roster({ detected: [det('SPOTIFY', { recent })] }).subscriptions[0].recent).toEqual(recent);
    expect(roster({ detected: [det('SPOTIFY', { recent: undefined, lastDate: '2026-09-15', lastCents: 1199 })] }).subscriptions[0].recent)
      .toEqual([{ date: '2026-09-15', cents: 1199 }]);
  });

  it('hands each entry the short hash of its key for button data, and its reminder', () => {
    const e = roster({ detected: [det('SPOTIFY')], prefs: prefsWith({ remind: { SPOTIFY: 3 } }) }).subscriptions[0];
    expect(e.handle).toBe(findingHandle('SPOTIFY'));
    expect(e.remind).toBe(3);
  });
});

describe('buildRoster — hand-added and linked', () => {
  const HULU = { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly' as const, nextDate: '2026-11-08', merchant: 'HULU' };

  it("a linked entry absorbs its detection into ONE row: its own name, key and reminder; detection's dates and price", () => {
    const r = roster({
      detected: [det('HULU', { monthlyCents: 1099, lastDate: '2026-10-08' }), det('SPOTIFY')],
      prefs: prefsWith({ manual: [HULU], remind: { 'm:hulu0001': 1 } }),
    });
    expect(names(r.subscriptions)).toEqual(['SPOTIFY', 'Hulu']);
    expect(r.subscriptions[1]).toMatchObject({
      key: 'm:hulu0001', source: 'manual', bankName: 'HULU', cents: 1099, nextDate: '2026-11-08', remind: 1,
      handle: findingHandle('m:hulu0001'),
    });
  });

  it('linked but not detected yet: the next date written at link time, rolled', () => {
    expect(roster({ today: '2026-11-20', prefs: prefsWith({ manual: [HULU] }) }).subscriptions[0])
      .toMatchObject({ key: 'm:hulu0001', nextDate: '2026-12-08', cents: 999, recent: [] });
  });

  it("offers the cube's link suggestions minus declined, linked, unknown and malformed ones", () => {
    const r = roster({
      prefs: prefsWith({
        manual: [
          { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' },
          { id: 'disn0001', name: 'Disney', cents: 1399, cadence: 'monthly', nextDate: '2026-10-21' },
          { id: 'linked01', name: 'Max', cents: 1699, cadence: 'monthly', nextDate: '2026-10-25', merchant: 'MAX.COM' },
        ],
        names: { 'm:hulu0001': 'Hulu (family)' },
        declinedLinks: ['disn0001|DISNEY PLUS'],
      }),
      links: [
        { manualId: 'hulu0001', merchant: 'HULU', date: '2026-09-19', cents: 999 },
        { manualId: 'disn0001', merchant: 'DISNEY PLUS', date: '2026-09-21', cents: 1399 },
        { manualId: 'linked01', merchant: 'MAX.COM', date: '2026-09-25', cents: 1699 },
        { manualId: 'gone0001', merchant: 'PEACOCK', date: '2026-09-25', cents: 799 },
        { manualId: 'hulu0001', merchant: 42 },
        'garbage',
      ],
    });
    expect(r.linkSuggestions).toEqual([
      { manualId: 'hulu0001', manualName: 'Hulu (family)', merchant: 'HULU', date: '2026-09-19', cents: 999 },
    ]);
  });
});

describe('buildRoster — totals', () => {
  it('monthly and yearly subscriptions total apart; bills have their own', () => {
    const r = roster({
      detected: [
        det('SPOTIFY'),
        det('NETFLIX', { monthlyCents: 1549, lastCents: 1799, creep: true, lastDate: '2026-09-22' }),
        det('LG&E', { kind: 'bill', monthlyCents: 6149, lastDate: '2026-09-28' }),
      ],
      prefs: prefsWith({ manual: [
        { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' },
        { id: 'dom00001', name: 'Domain', cents: 9900, cadence: 'yearly', nextDate: '2027-03-03' },
      ] }),
    });
    expect(r.monthlyCents).toBe(1199 + 1799 + 999);
    expect(r.yearlyCents).toBe(9900);
    expect(r.billsMonthlyCents).toBe(6149);
    expect(formatRosterTotal(r)).toBe('$39.97/mo + $99/yr');
    expect(names(r.subscriptions)).toEqual(['NETFLIX', 'SPOTIFY', 'Hulu', 'Domain']);
  });

  it('leaves the yearly part out when there is none', () => {
    expect(formatRosterTotal(roster({ detected: [det('SPOTIFY')] }))).toBe('$11.99/mo');
  });

  it('without a cube: hand-added and watched only, detection unavailable', () => {
    const r = roster({
      detected: null, merchants: null, links: null,
      prefs: prefsWith({ manual: [{ id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' }], confirmed: ['RENT LLC'] }),
    });
    expect(r.detectionAvailable).toBe(false);
    expect(names(r.subscriptions)).toEqual(['Hulu', 'RENT LLC']);
  });
});

describe('dueWithin', () => {
  it('lists subscriptions and bills due in the window, in date order — never maybes, hidden, late or watched', () => {
    const r = roster({
      detected: [
        det('SPOTIFY', { lastDate: '2026-09-15' }),
        det('RENT LLC', { kind: 'bill', monthlyCents: 80000, lastDate: '2026-09-13' }),
        det('LATE ONE', { lastDate: '2026-09-10' }),
        det('MYSTERY BOX', { kind: 'possible', lastDate: '2026-09-14' }),
        det('QR LIBRARY', { lastDate: '2026-09-16' }),
        det('ADOBE', { lastDate: '2026-09-19' }),
      ],
      prefs: prefsWith({ hidden: ['QR LIBRARY'], confirmed: ['WATCHED'] }),
    });
    expect(names(dueWithin(r, TODAY, 7))).toEqual(['RENT LLC', 'SPOTIFY']);
    expect(names(dueWithin(r, TODAY, 8))).toEqual(['RENT LLC', 'SPOTIFY', 'ADOBE']);
  });
});

describe('roster text helpers', () => {
  it('money drops .00 and keeps cents otherwise', () => {
    expect([1199, 9900, 125050, 0, 100000].map(rosterMoney)).toEqual(['$11.99', '$99', '$1,250.50', '$0', '$1,000']);
  });

  it('about-dollars rounds to whole dollars', () => {
    expect([6149, 14050, 80000].map(aboutDollars)).toEqual(['$61', '$141', '$800']);
  });

  it('amounts and prices per kind', () => {
    const r = roster({
      detected: [det('SPOTIFY'), det('LG&E', { kind: 'bill', monthlyCents: 6149 })],
      prefs: prefsWith({
        manual: [{ id: 'dom00001', name: 'Domain', cents: 9900, cadence: 'yearly', nextDate: '2027-03-03' }],
        confirmed: ['NEVER SEEN'],
      }),
    });
    const by = (n: string) => [...r.subscriptions, ...r.bills].find((e) => e.displayName === n)!;
    expect([rosterAmount(by('SPOTIFY')), rosterPrice(by('SPOTIFY'))]).toEqual(['$11.99', '$11.99/mo']);
    expect([rosterAmount(by('LG&E')), rosterPrice(by('LG&E'))]).toEqual(['about $61', 'about $61/mo']);
    expect([rosterAmount(by('Domain')), rosterPrice(by('Domain'))]).toEqual(['$99/yr', '$99/yr']);
    expect([rosterAmount(by('NEVER SEEN')), rosterPrice(by('NEVER SEEN'))]).toEqual(['no price yet', 'no price yet']);
  });

  it('says when, in words', () => {
    expect(monthDay('2026-10-05')).toBe('Oct 5');
    const r = roster({ detected: [det('A', { lastDate: '2026-09-15' }), det('B', { lastDate: '2026-09-08' })] });
    expect(r.subscriptions.map(rosterWhen)).toEqual(['next Oct 15', 'due Oct 8, not charged yet']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run shared/subscription-roster.test.ts shared/subscriptions.test.ts`
Expected: FAIL — `Failed to resolve import "./handle.js"`, and `found.recent` is `undefined`.

Run: `npm --prefix companion test -- src/report-cube-build.test.ts`
Expected: FAIL — the expected object has `recent`, the built one does not.

- [ ] **Step 3: Move the handle**

Create `shared/handle.ts` holding the doc comment and function body that sit in `shared/findings.ts` today, verbatim:

```ts
/**
 * shared/handle.ts
 *
 * A short, stable handle for a key, for `callback_data`.
 *
 * Telegram caps callback data at 64 bytes, and a key can carry a uuid plus an
 * account name. FNV-1a over the key gives 8 hex characters; a tap resolves the
 * handle by re-judging what it points at and hashing each key, so nothing has
 * to be remembered between a message going out and the tap arriving — which
 * can be hours, and a container restart, later. A leaf module (no imports) so
 * the subscription roster can use it without an import cycle through
 * shared/telegram.ts.
 */
export function findingHandle(key: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
```

In `shared/findings.ts`, delete the `findingHandle` doc comment and function and put in their place:

```ts
/** Moved to ./handle.ts (a leaf module); re-exported so existing imports keep working. */
export { findingHandle } from './handle.js';
```

- [ ] **Step 4: Publish `recent` from the detector**

In `shared/subscriptions.ts`, add to `DetectedSubscription` after `kind?`:

```ts
  /** 1.60: the newest three charges, newest first — the "last charges" on the
   *  card's detail and in /subscriptions. Absent on older cubes; readers fall
   *  back to `lastDate`/`lastCents`. */
  recent?: Array<{ date: string; cents: number }>;
```

In `detectSubscriptions`, add as the last property of the object passed to `found.push`, after `kind,`:

```ts
      // `recent` above is the trailing three, oldest first.
      recent: [...recent].reverse().map((c) => ({ date: c.date, cents: c.cents })),
```

- [ ] **Step 5: Implement the roster**

At the top of `shared/subscription-roster.ts`, below the header comment, add:

```ts
import { findingHandle } from './handle.js';
import type { CubeMerchant } from './report-cube.js';
import type { DetectedSubscription } from './subscriptions.js';
import type { ManualSubscription, RemindDays, SubscriptionPrefs } from './subscription-prefs.js';
```

Append to the end of the file:

```ts
// ── The roster ────────────────────────────────────────────────────────────

export type RosterGroup = 'subscription' | 'bill' | 'maybe';

export interface RosterEntry {
  key: string;
  /** Rename, else the hand-added name, else the detector's name. */
  displayName: string;
  /** The detector's (bank's) name, when it differs from displayName. */
  bankName?: string;
  group: RosterGroup;
  source: 'detected' | 'watched' | 'manual';
  /** Per charge; "about" for bills. */
  cents: number;
  cadence: Cadence;
  /** Null once overdue, and for watched names (no dates known). */
  nextDate: string | null;
  /** nextDate is past, inside the LATE_GRACE_DAYS grace. */
  late?: boolean;
  /** The predicted date passed more than LATE_GRACE_DAYS ago. */
  overdueSince?: string;
  creep?: { fromCents: number; toCents: number; chargedOn: string };
  remind?: RemindDays;
  /** Newest first, up to 3. */
  recent: Array<{ date: string; cents: number }>;
  /** findingHandle(key), for button data. */
  handle: string;
}

/** One cube link suggestion (shared/subscription-links.ts writes them). */
export interface CubeLink { manualId: string; merchant: string; date: string; cents: number }
export interface RosterLinkSuggestion extends CubeLink { manualName: string }

export interface Roster {
  subscriptions: RosterEntry[];
  bills: RosterEntry[];
  maybes: RosterEntry[];
  hidden: RosterEntry[];
  /** Subscriptions with a monthly cadence. */
  monthlyCents: number;
  /** Yearly ones — NOT divided by 12. */
  yearlyCents: number;
  billsMonthlyCents: number;
  linkSuggestions: RosterLinkSuggestion[];
  /** False without detection data (no cube, or `subscriptions: null`): hand-added only. */
  detectionAvailable: boolean;
}

export interface RosterInput {
  /** cube.subscriptions; null/undefined when there is no cube or the companion could not look. */
  detected: readonly DetectedSubscription[] | null | undefined;
  /** cube.merchants, oldest month first — prices watched names. */
  merchants: ReadonlyArray<readonly CubeMerchant[]> | null | undefined;
  /** cube.subscriptionLinks, UNVALIDATED (parseReportCube does not check optional fields). */
  links: readonly unknown[] | null | undefined;
  prefs: SubscriptionPrefs;
  /** YYYY-MM-DD, the reader's local day. */
  today: string;
}

/** Days a predicted charge may be missing before the entry counts as overdue. */
export const LATE_GRACE_DAYS = 7;

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isCubeLink(v: unknown): v is CubeLink {
  if (!v || typeof v !== 'object') return false;
  const l = v as Record<string, unknown>;
  return typeof l.manualId === 'string' && typeof l.merchant === 'string' && l.merchant !== ''
    && typeof l.date === 'string' && ISO_DAY_RE.test(l.date) && Number.isInteger(l.cents);
}

/** From the LAST CHARGE, never from an earlier prediction, so a bank that
 *  moves a billing day self-corrects the next month. */
function nextFromCharge(lastDate: string, cadence: Cadence, today: string): Pick<RosterEntry, 'nextDate' | 'late' | 'overdueSince'> {
  const predicted = addPeriod(lastDate, cadence);
  const past = daysBetween(predicted, today);
  if (past <= 0) return { nextDate: predicted };
  if (past <= LATE_GRACE_DAYS) return { nextDate: predicted, late: true };
  return { nextDate: null, overdueSince: predicted };
}

function fromDetection(d: DetectedSubscription, cadence: Cadence, today: string) {
  return {
    // After a price rise the newest charge is the price going forward.
    cents: d.creep ? d.lastCents : d.monthlyCents,
    ...nextFromCharge(d.lastDate, cadence, today),
    ...(d.creep ? { creep: { fromCents: d.monthlyCents, toCents: d.lastCents, chargedOn: d.lastDate } } : {}),
    recent: d.recent && d.recent.length > 0
      ? d.recent.slice(0, 3).map(({ date, cents }) => ({ date, cents }))
      : [{ date: d.lastDate, cents: d.lastCents }],
  };
}

/** Per-charge price of each merchant over the newest three cube months,
 *  newest month first — on the 2nd of a month the current month is two days
 *  deep, and a mid-month charge must still price (the v1.39 Anthropic miss). */
function recentMerchantPrices(merchants: RosterInput['merchants']): Map<string, number> {
  const out = new Map<string, number>();
  for (const month of [...(merchants ?? [])].slice(-3).reverse()) {
    for (const m of month ?? []) {
      if (!out.has(m.name)) out.set(m.name, m.count > 0 ? Math.round(m.cents / m.count) : 0);
    }
  }
  return out;
}

/** Monthly before yearly, then the biggest money first, then by name. */
const rosterOrder = (a: RosterEntry, b: RosterEntry) =>
  (a.cadence === b.cadence ? 0 : a.cadence === 'monthly' ? -1 : 1)
  || b.cents - a.cents
  || a.displayName.localeCompare(b.displayName);

export function buildRoster(input: RosterInput): Roster {
  const { prefs, today } = input;
  const detected = input.detected ?? null;
  const hidden = new Set(prefs.hidden);
  const confirmed = new Set(prefs.confirmed);
  const linkedManual = new Map<string, ManualSubscription>();
  for (const m of prefs.manual) if (m.merchant) linkedManual.set(m.merchant, m);
  const detectedByName = new Map((detected ?? []).map((d) => [d.name, d] as const));

  const naming = (key: string, fallback: string, bank: string | undefined) => {
    const displayName = prefs.names[key] ?? fallback;
    return bank && bank !== displayName ? { displayName, bankName: bank } : { displayName };
  };
  const reminder = (key: string): { remind?: RemindDays } => (prefs.remind[key] ? { remind: prefs.remind[key] } : {});

  const all: RosterEntry[] = [];
  for (const d of detected ?? []) {
    // A hand-added entry linked to this merchant IS this row (below).
    if (linkedManual.has(d.name)) continue;
    // Absent kind = a pre-1.36 cube's row, whose only meaning was "subscription".
    const kind = d.kind ?? 'subscription';
    const group: RosterGroup = confirmed.has(d.name) || kind === 'subscription' ? 'subscription'
      : kind === 'bill' ? 'bill' : 'maybe';
    all.push({
      key: d.name, ...naming(d.name, d.name, d.name), group, source: 'detected', cadence: 'monthly',
      ...fromDetection(d, 'monthly', today), ...reminder(d.name), handle: findingHandle(d.name),
    });
  }

  // Watched: confirmed, but the detector has no verdict (one charge so far).
  const prices = recentMerchantPrices(input.merchants);
  for (const name of new Set(prefs.confirmed)) {
    if (detectedByName.has(name) || linkedManual.has(name) || isManualKey(name)) continue;
    all.push({
      key: name, ...naming(name, name, name), group: 'subscription', source: 'watched',
      cents: prices.get(name) ?? 0, cadence: 'monthly', nextDate: null, recent: [],
      ...reminder(name), handle: findingHandle(name),
    });
  }

  for (const m of prefs.manual) {
    const key = manualKey(m.id);
    const d = m.merchant ? detectedByName.get(m.merchant) : undefined;
    const base = {
      key, ...naming(key, m.name, m.merchant), group: 'subscription' as const, source: 'manual' as const,
      cadence: m.cadence, ...reminder(key), handle: findingHandle(key),
    };
    // Linked AND detected: dates, price, history and creep from detection;
    // otherwise the stored date rolled forward — no overdue without charge data.
    all.push(d
      ? { ...base, ...fromDetection(d, m.cadence, today) }
      : { ...base, cents: m.cents, nextDate: rollForward(m.nextDate, m.cadence, today), recent: [] });
  }

  const visible = all.filter((e) => !hidden.has(e.key));
  const group = (g: RosterGroup) => visible.filter((e) => e.group === g).sort(rosterOrder);
  const subscriptions = group('subscription');
  const bills = group('bill');
  const sum = (list: RosterEntry[]) => list.reduce((s, e) => s + e.cents, 0);

  const declined = new Set(prefs.declinedLinks);
  const manualById = new Map(prefs.manual.map((m) => [m.id, m] as const));
  const linkSuggestions: RosterLinkSuggestion[] = [];
  for (const l of input.links ?? []) {
    if (!isCubeLink(l)) continue;
    const m = manualById.get(l.manualId);
    // Gone, already linked, answered No, or a merchant another entry claimed.
    if (!m || m.merchant || declined.has(`${l.manualId}|${l.merchant}`) || linkedManual.has(l.merchant)) continue;
    linkSuggestions.push({
      manualId: l.manualId, manualName: prefs.names[manualKey(m.id)] ?? m.name,
      merchant: l.merchant, date: l.date, cents: l.cents,
    });
  }

  return {
    subscriptions,
    bills,
    maybes: group('maybe'),
    hidden: all.filter((e) => hidden.has(e.key)).sort(rosterOrder),
    monthlyCents: sum(subscriptions.filter((e) => e.cadence === 'monthly')),
    yearlyCents: sum(subscriptions.filter((e) => e.cadence === 'yearly')),
    billsMonthlyCents: sum(bills),
    linkSuggestions,
    detectionAvailable: detected !== null,
  };
}

/** Subscriptions and bills charging in [today, today + days), date order.
 *  Late (past) and overdue entries are not "due"; maybes and hidden never are. */
export function dueWithin(roster: Roster, today: string, days: number): RosterEntry[] {
  const end = addDaysIso(today, days);
  return [...roster.subscriptions, ...roster.bills]
    .filter((e) => e.nextDate !== null && e.nextDate >= today && e.nextDate < end)
    .sort((a, b) => a.nextDate!.localeCompare(b.nextDate!) || a.displayName.localeCompare(b.displayName));
}

// ── Text every surface shares, so the card, the mini app and Telegram can
//    never print a different name, price or total for the same entry. ──────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-05" → "Oct 5" — shared/telegram.ts's `shortDate` shape, which this
 *  module cannot import (telegram.ts imports this one). */
export function monthDay(iso: string): string {
  return `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
}

const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** `$11.99`, `$99`, `$1,250.50` — cents kept unless they are zero. */
export function rosterMoney(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  const frac = abs % 100;
  return `${cents < 0 ? '-' : ''}$${thousands(Math.floor(abs / 100))}${frac === 0 ? '' : `.${String(frac).padStart(2, '0')}`}`;
}

/** A bill's "about" figure: whole dollars. */
export function aboutDollars(cents: number): string {
  return `$${thousands(Math.round(cents / 100))}`;
}

export function rosterAmount(e: RosterEntry): string {
  if (e.group === 'bill') return `about ${aboutDollars(e.cents)}`;
  if (e.source === 'watched' && e.cents === 0) return 'no price yet';
  return e.cadence === 'yearly' ? `${rosterMoney(e.cents)}/yr` : rosterMoney(e.cents);
}

/** rosterAmount with "/mo" on a priced monthly entry — the app card's price column. */
export function rosterPrice(e: RosterEntry): string {
  const amount = rosterAmount(e);
  return e.cadence === 'monthly' && amount !== 'no price yet' ? `${amount}/mo` : amount;
}

export function rosterWhen(e: RosterEntry): string {
  if (e.overdueSince) return `expected ${monthDay(e.overdueSince)}, hasn't charged`;
  if (e.nextDate === null) return 'watching';
  return e.late ? `due ${monthDay(e.nextDate)}, not charged yet` : `next ${monthDay(e.nextDate)}`;
}

/** `$87.42/mo + $99/yr` — the yearly part only when there is one. */
export function formatRosterTotal(roster: Roster): string {
  return `${rosterMoney(roster.monthlyCents)}/mo${roster.yearlyCents > 0 ? ` + ${rosterMoney(roster.yearlyCents)}/yr` : ''}`;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run shared/subscription-roster.test.ts shared/subscriptions.test.ts shared/findings.test.ts`
Expected: PASS (the existing `findingHandle` tests pass through the re-export).

Run: `npm --prefix companion test -- src/report-cube-build.test.ts src/findings-menu.test.ts`
Expected: PASS.

Run: `npm run type-check && npm --prefix companion run build`
Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add shared/handle.ts shared/findings.ts shared/subscriptions.ts shared/subscriptions.test.ts shared/subscription-roster.ts shared/subscription-roster.test.ts companion/src/report-cube-build.test.ts
git commit -m "Subscriptions: one roster every surface renders from; detector publishes recent charges

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Link suggestions in the cube

**Files:**
- Create: `shared/subscription-links.ts`
- Test: `shared/subscription-links.test.ts`
- Modify: `shared/report-cube.ts` (`ReportCube`, next to `subscriptions?` ~line 80-82)
- Modify: `companion/src/report-cube-build.ts` (`CubeBuildDeps` ~line 39-58; after `const subscriptions = …` ~line 212; the `cube` literal ~line 243)
- Test: `companion/src/report-cube-build.test.ts`
- Modify: `companion/src/index.ts` (new `subscriptionSecrets` above `function cubeBuildDeps` ~line 1563; new property in the object `cubeBuildDeps` returns; imports)

**Interfaces:**
- Consumes: Task 1 (`SubscriptionPrefs`, `loadSubscriptionPrefs`, `SecretGet`, `SecretSet`, date helpers, `localIsoDay`), Task 2 (`CubeLink`), `categoryRulePattern` from `shared/rule-pattern.ts`, `SubscriptionCharge` from `shared/subscriptions.ts`.
- Produces:
  - `shared/subscription-links.ts`: `export const LINK_WINDOW_DAYS = 45; export const LINK_DATE_SLACK_DAYS = 3; export const LINK_AMOUNT_TOLERANCE = 0.15; export function findLinkSuggestions(charges: readonly SubscriptionCharge[], prefs: SubscriptionPrefs, now: Date): CubeLink[]` — `merchant` is the detector's key (`categoryRulePattern(description) || description`), so a linked entry absorbs its detection.
  - `ReportCube.subscriptionLinks?: CubeLink[] | null` (null = prefs unreadable or no binding).
  - `CubeBuildDeps.subscriptionPrefs?(): Promise<SubscriptionPrefs | null>`.
  - In `index.ts` (module-private): `function subscriptionSecrets(wfClient: WealthfolioClient): { get: SecretGet; set: SecretSet }` — reused by Tasks 4, 6, 7, 9.

- [ ] **Step 1: Write the failing tests**

Create `shared/subscription-links.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { findLinkSuggestions } from './subscription-links.js';
import { emptySubscriptionPrefs, type ManualSubscription, type SubscriptionPrefs } from './subscription-prefs.js';

const NOW = new Date(2026, 9, 12, 9, 0, 0); // Oct 12, local morning
const HULU: ManualSubscription = { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' };
const prefsWith = (over: Partial<SubscriptionPrefs> = {}): SubscriptionPrefs => ({ ...emptySubscriptionPrefs(), manual: [HULU], ...over });
/** SubscriptionCharge as the cube builder makes it: description already through descriptionFromComment. */
const charge = (date: string, merchant: string, cents: number) => ({ date, merchant, cents });

describe('findLinkSuggestions', () => {
  it('suggests the one merchant whose charge lands near a due date at about the price', () => {
    expect(findLinkSuggestions([charge('2026-09-19', 'HULU 877-824-4858', 999), charge('2026-09-20', 'CHIPOTLE 1234', 1250)], prefsWith(), NOW))
      .toEqual([{ manualId: 'hulu0001', merchant: 'HULU', date: '2026-09-19', cents: 999 }]);
  });

  it('two charges from the SAME merchant are one candidate — the newest is offered', () => {
    const manual = [{ ...HULU, nextDate: '2026-10-08' }];
    expect(findLinkSuggestions(
      [charge('2026-09-08', 'HULU 877-824-4858', 999), charge('2026-10-08', 'HULU 877-824-4858', 999)],
      prefsWith({ manual }), NOW,
    )).toEqual([{ manualId: 'hulu0001', merchant: 'HULU', date: '2026-10-08', cents: 999 }]);
  });

  it('two merchants match: ambiguous, so none', () => {
    expect(findLinkSuggestions([charge('2026-09-19', 'HULU 877-824-4858', 999), charge('2026-09-21', 'DISNEY PLUS', 1029)], prefsWith(), NOW))
      .toEqual([]);
  });

  it.each([
    ['too far from the due date', charge('2026-09-16', 'HULU 877-824-4858', 999)],
    ['more than 15% off the price', charge('2026-09-20', 'HULU 877-824-4858', 1199)],
    ['older than 45 days', charge('2026-08-20', 'HULU 877-824-4858', 999)],
    ['dated after today', charge('2026-10-19', 'HULU 877-824-4858', 999)],
  ])('ignores a charge %s', (_why, c) => {
    expect(findLinkSuggestions([c], prefsWith(), NOW)).toEqual([]);
  });

  it('a No sticks, a linked entry is skipped, and a merchant another entry owns is not offered', () => {
    const hulu = charge('2026-09-19', 'HULU 877-824-4858', 999);
    expect(findLinkSuggestions([hulu], prefsWith({ declinedLinks: ['hulu0001|HULU'] }), NOW)).toEqual([]);
    expect(findLinkSuggestions([hulu], prefsWith({ manual: [{ ...HULU, merchant: 'HULU' }] }), NOW)).toEqual([]);
    const owner = { id: 'hulu0002', name: 'Hulu again', cents: 999, cadence: 'monthly' as const, nextDate: '2026-10-20', merchant: 'HULU' };
    expect(findLinkSuggestions([hulu], prefsWith({ manual: [HULU, owner] }), NOW)).toEqual([]);
  });

  it('declining one merchant leaves the other as the single candidate', () => {
    expect(findLinkSuggestions(
      [charge('2026-09-19', 'HULU 877-824-4858', 999), charge('2026-09-21', 'DISNEY PLUS', 1029)],
      prefsWith({ declinedLinks: ['hulu0001|DISNEY PLUS'] }), NOW,
    )).toEqual([{ manualId: 'hulu0001', merchant: 'HULU', date: '2026-09-19', cents: 999 }]);
  });

  it("matches a yearly entry against last year's due date", () => {
    const adobe = { id: 'adob0001', name: 'Adobe', cents: 9900, cadence: 'yearly' as const, nextDate: '2027-09-30' };
    expect(findLinkSuggestions([charge('2026-09-29', 'ADOBE CREATIVE 8ZK1', 9900)], prefsWith({ manual: [adobe] }), NOW))
      .toEqual([{ manualId: 'adob0001', merchant: 'ADOBE CREATIVE', date: '2026-09-29', cents: 9900 }]);
  });

  it('matches when the next date typed is after the charge it should link to', () => {
    expect(findLinkSuggestions([charge('2026-10-09', 'HULU 877-824-4858', 999)], prefsWith({ manual: [{ ...HULU, nextDate: '2026-11-10' }] }), NOW))
      .toEqual([{ manualId: 'hulu0001', merchant: 'HULU', date: '2026-10-09', cents: 999 }]);
  });
});
```

Append to `companion/src/report-cube-build.test.ts` (add `import { emptySubscriptionPrefs } from '../../shared/subscription-prefs.js';` to the imports):

```ts
describe('link suggestions in the cube (1.60)', () => {
  const hulu = { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly' as const, nextDate: '2026-09-20' };
  const huluRows = () => [
    { month: '2026-08', date: '2026-08-19', notes: 'HULU 877-824-4858 · TRN-41', amount: 9.99 },
    { month: '2026-08', date: '2026-08-21', notes: 'CHIPOTLE 1234 · TRN-42', amount: 14.5 },
  ];

  it("publishes the hand-added entries' link suggestions from the dated charges", async () => {
    const cube = await buildReportCube(deps({
      merchantRows: vi.fn(huluRows),
      subscriptionPrefs: vi.fn(async () => ({ ...emptySubscriptionPrefs(), manual: [hulu] })),
    }), NOW, 2);
    expect(cube.subscriptionLinks).toEqual([{ manualId: 'hulu0001', merchant: 'HULU', date: '2026-08-19', cents: 999 }]);
    expect(parseReportCube(JSON.stringify(cube))?.subscriptionLinks).toEqual(cube.subscriptionLinks);
  });

  it('publishes null without the binding or when reading the prefs fails — the cube still builds', async () => {
    expect((await buildReportCube(deps({ merchantRows: vi.fn(huluRows) }), NOW, 2)).subscriptionLinks).toBeNull();
    const failing = await buildReportCube(deps({
      merchantRows: vi.fn(huluRows),
      subscriptionPrefs: vi.fn(async () => { throw new Error('down'); }),
    }), NOW, 2);
    expect(failing.subscriptionLinks).toBeNull();
    expect(failing.months).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run shared/subscription-links.test.ts`
Expected: FAIL — `Failed to resolve import "./subscription-links.js"`.

Run: `npm --prefix companion test -- src/report-cube-build.test.ts`
Expected: FAIL — `cube.subscriptionLinks` is `undefined`.

- [ ] **Step 3: Implement**

Create `shared/subscription-links.ts`:

```ts
/**
 * shared/subscription-links.ts
 *
 * "Is HULU your Hulu?" — matching a hand-added subscription to the bank's
 * name for its charges, computed by the companion at cube build (raw charges
 * never leave the box; only the suggestions ride the cube).
 *
 * A candidate is a charge from the last LINK_WINDOW_DAYS that lands within
 * LINK_DATE_SLACK_DAYS of one of the entry's due dates (rolled backwards and
 * forwards from its stored next date) and within LINK_AMOUNT_TOLERANCE of its
 * amount. Candidates are counted per MERCHANT: one merchant charging twice is
 * one candidate; two merchants is ambiguous, and an ambiguous match is worse
 * than none (the Amazon lesson), so nothing is offered.
 */
import { categoryRulePattern } from './rule-pattern.js';
import type { SubscriptionCharge } from './subscriptions.js';
import type { SubscriptionPrefs } from './subscription-prefs.js';
import { addDaysIso, addPeriod, daysBetween, localIsoDay, type Cadence, type CubeLink } from './subscription-roster.js';

export const LINK_WINDOW_DAYS = 45;
export const LINK_DATE_SLACK_DAYS = 3;
export const LINK_AMOUNT_TOLERANCE = 0.15;

/** Every due date of an entry anchored at `anchor` that falls in [from, to]. */
function dueDatesBetween(anchor: string, cadence: Cadence, from: string, to: string): string[] {
  const monthIndex = (iso: string) => Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;
  const gap = cadence === 'yearly'
    ? Number(from.slice(0, 4)) - Number(anchor.slice(0, 4))
    : monthIndex(from) - monthIndex(anchor);
  const out: string[] = [];
  // Starting one period before `from`'s month guarantees nothing is skipped.
  for (let n = gap - 1; ; n += 1) {
    const due = addPeriod(anchor, cadence, n);
    if (due > to) break;
    if (due >= from) out.push(due);
  }
  return out;
}

export function findLinkSuggestions(
  charges: readonly SubscriptionCharge[],
  prefs: SubscriptionPrefs,
  now: Date,
): CubeLink[] {
  const today = localIsoDay(now);
  const since = addDaysIso(today, -LINK_WINDOW_DAYS);
  const recent = charges.filter((c) => c.merchant && c.cents > 0 && c.date >= since && c.date <= today);
  const claimed = new Set(prefs.manual.flatMap((m) => (m.merchant ? [m.merchant] : [])));
  const declined = new Set(prefs.declinedLinks);
  const out: CubeLink[] = [];
  for (const m of prefs.manual) {
    if (m.merchant) continue;
    const dues = dueDatesBetween(
      m.nextDate, m.cadence,
      addDaysIso(since, -LINK_DATE_SLACK_DAYS), addDaysIso(today, LINK_DATE_SLACK_DAYS),
    );
    const byMerchant = new Map<string, { date: string; cents: number }>();
    for (const c of recent) {
      if (Math.abs(c.cents - m.cents) > m.cents * LINK_AMOUNT_TOLERANCE) continue;
      if (!dues.some((d) => Math.abs(daysBetween(d, c.date)) <= LINK_DATE_SLACK_DAYS)) continue;
      // The detector's key, so accepting the link absorbs the detected row.
      const merchant = categoryRulePattern(c.merchant) || c.merchant;
      if (claimed.has(merchant) || declined.has(`${m.id}|${merchant}`)) continue;
      const seen = byMerchant.get(merchant);
      if (!seen || c.date > seen.date) byMerchant.set(merchant, { date: c.date, cents: c.cents });
    }
    if (byMerchant.size !== 1) continue;
    const [[merchant, hit]] = [...byMerchant];
    out.push({ manualId: m.id, merchant, date: hit.date, cents: hit.cents });
  }
  return out;
}
```

In `shared/report-cube.ts`, after the `subscriptions?` field:

```ts
  /** 1.60: hand-added subscriptions' likely bank names, "Is HULU your Hulu?"
   *  (shared/subscription-links.ts). Absent on older companions; null when the
   *  prefs could not be read. NOT validated by parseReportCube —
   *  buildRoster drops malformed entries. */
  subscriptionLinks?: import('./subscription-roster.js').CubeLink[] | null;
```

In `companion/src/report-cube-build.ts`:

1. Imports:
```ts
import { findLinkSuggestions } from '../../shared/subscription-links.js';
import type { SubscriptionPrefs } from '../../shared/subscription-prefs.js';
```

2. In `CubeBuildDeps`, after `drillRows?`:
```ts
  /** The subscription document, for link suggestions. Optional so an older
   *  binding keeps building cubes, just without suggestions. */
  subscriptionPrefs?(): Promise<SubscriptionPrefs | null>;
```

3. After `const subscriptions = datedCharges.length > 0 ? detectSubscriptions(datedCharges, now) : null;`:
```ts
  // Link suggestions ride the same dated charges. A failed read costs the
  // suggestions, never the cube.
  let subscriptionLinks: ReportCube['subscriptionLinks'] = null;
  if (deps.subscriptionPrefs && datedCharges.length > 0) {
    const prefs = await deps.subscriptionPrefs().catch(() => null);
    if (prefs) subscriptionLinks = findLinkSuggestions(datedCharges, prefs, now);
  }
```

4. In the `cube` literal, change `check, subscriptions, drill,` to `check, subscriptions, subscriptionLinks, drill,`.

In `companion/src/index.ts`:

1. Imports (beside the other shared imports):
```ts
import { loadSubscriptionPrefs, type SecretGet, type SecretSet } from '../../shared/subscription-prefs.js';
```

2. Above `function cubeBuildDeps`:
```ts
/** The two secret calls every subscription reader and writer goes through —
 *  the companion's half of shared/subscription-prefs.ts's `get`/`set`. */
function subscriptionSecrets(wfClient: WealthfolioClient): { get: SecretGet; set: SecretSet } {
  return {
    get: (key) => wfClient.getAddonSecret('simplefin-sync', key),
    set: (key, value) => wfClient.setAddonSecret('simplefin-sync', key, value),
  };
}
```

3. As the last property of the object `cubeBuildDeps` returns:
```ts
    // Link suggestions for hand-added subscriptions. An unreadable document
    // offers none rather than guessing from the legacy lists.
    subscriptionPrefs: async () => {
      const loaded = await loadSubscriptionPrefs(subscriptionSecrets(wfClient).get).catch(() => null);
      return loaded && !loaded.unreadable ? loaded.prefs : null;
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run shared/subscription-links.test.ts shared/report-cube.test.ts`
Expected: PASS.

Run: `npm --prefix companion test -- src/report-cube-build.test.ts`
Expected: PASS.

Run: `npm run type-check && npm --prefix companion run build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add shared/subscription-links.ts shared/subscription-links.test.ts shared/report-cube.ts companion/src/report-cube-build.ts companion/src/report-cube-build.test.ts companion/src/index.ts
git commit -m "Subscriptions: cube publishes link suggestions for hand-added entries

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 4: The companion's roster reader, and the mini app on the roster

**Files:**
- Create: `companion/src/subscription-data.ts`
- Test: `companion/src/subscription-data.test.ts`
- Modify: `companion/src/reports-server.ts` (`ReportsServerDeps` ~line 30-42; `BoardData` ~line 92-99; the `subscriptions` section ~line 173-185; the `dashboardHtml({...})` call ~line 270-276; imports ~line 20-28)
- Test: `companion/src/reports-server.test.ts` (the `deps` fake ~line 20-31; new test)
- Modify: `companion/src/index.ts` (reports-server binding ~line 3553-3558)

**Interfaces:**
- Consumes: Task 1 (`loadSubscriptionPrefs`, `SecretGet`, `SubscriptionPrefs`, `emptySubscriptionPrefs`, `localIsoDay`), Task 2 (`buildRoster`, `Roster`, `RosterEntry`, `rosterPrice`, `aboutDollars`, `formatRosterTotal`), Task 3 (`subscriptionSecrets`), `parseReportCube` / `REPORT_CUBE_SECRET_KEY`.
- Produces:
  - `companion/src/subscription-data.ts`:
    ```ts
    export interface RosterRead { roster: Roster; prefs: SubscriptionPrefs; unreadable: boolean; today: string }
    /** Rejects when Wealthfolio cannot be read — callers choose silence (reports) or "Couldn't reach Wealthfolio" (taps). */
    export function readSubscriptionRoster(get: SecretGet, today: string): Promise<RosterRead>;
    ```
  - `ReportsServerDeps.readSubscriptionPrefs(): Promise<SubscriptionPrefs>` REPLACES `readHiddenSubscriptions` and `readConfirmedSubscriptions`.

- [ ] **Step 1: Write the failing tests**

Create `companion/src/subscription-data.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { readSubscriptionRoster } from './subscription-data.js';

const TODAY = '2026-10-12';
/** A report_cube secret as the companion publishes it — every required field. */
const cubeJson = (subscriptions: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({
  version: 1, asOf: '2026-10-12T06:00:00.000Z', months: ['2026-09', '2026-10'], categories: [], accounts: [],
  spend: [[], []], uncategorized: [[], []], income: [[], []], budgets: [[], []], merchants: [[], []],
  feesInterest: [0, 0], netWorth: [null, null], liquid: [null, null], pool: null, subscriptions, ...extra,
});
const SPOTIFY = {
  name: 'SPOTIFY', monthlyCents: 1199, count: 5, lastDate: '2026-09-15', lastCents: 1199, prevCents: 1199,
  creep: false, kind: 'subscription', recent: [{ date: '2026-09-15', cents: 1199 }],
};
const getter = (entries: Record<string, string>) => vi.fn(async (k: string) => entries[k] ?? null);

describe('readSubscriptionRoster', () => {
  it('builds the roster from the cube and the stored document', async () => {
    const read = await readSubscriptionRoster(getter({
      report_cube: cubeJson([SPOTIFY]),
      subscription_prefs: JSON.stringify({ v: 1, names: { SPOTIFY: 'Spotify' } }),
    }), TODAY);
    expect(read.roster.subscriptions[0]).toMatchObject({ displayName: 'Spotify', nextDate: '2026-10-15' });
    expect(read.prefs.names).toEqual({ SPOTIFY: 'Spotify' });
    expect(read).toMatchObject({ unreadable: false, today: TODAY });
  });

  it('reads the legacy lists while no document exists', async () => {
    const read = await readSubscriptionRoster(getter({ report_cube: cubeJson([SPOTIFY]), hidden_subscriptions: '["SPOTIFY"]' }), TODAY);
    expect(read.roster.subscriptions).toEqual([]);
    expect(read.roster.hidden.map((e) => e.key)).toEqual(['SPOTIFY']);
  });

  it('flags a corrupt document and falls back to the legacy lists', async () => {
    const read = await readSubscriptionRoster(getter({
      report_cube: cubeJson([SPOTIFY]), subscription_prefs: '{"v":1,"hidden":', hidden_subscriptions: '["SPOTIFY"]',
    }), TODAY);
    expect(read.unreadable).toBe(true);
    expect(read.roster.hidden.map((e) => e.key)).toEqual(['SPOTIFY']);
  });

  it('without a cube: hand-added only, detection unavailable', async () => {
    const read = await readSubscriptionRoster(getter({
      subscription_prefs: JSON.stringify({ v: 1, manual: [{ id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' }] }),
    }), TODAY);
    expect(read.roster.detectionAvailable).toBe(false);
    expect(read.roster.subscriptions.map((e) => e.displayName)).toEqual(['Hulu']);
  });

  it("passes the cube's link suggestions through", async () => {
    const read = await readSubscriptionRoster(getter({
      report_cube: cubeJson([], { subscriptionLinks: [{ manualId: 'hulu0001', merchant: 'HULU', date: '2026-09-19', cents: 999 }] }),
      subscription_prefs: JSON.stringify({ v: 1, manual: [{ id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' }] }),
    }), TODAY);
    expect(read.roster.linkSuggestions.map((s) => s.merchant)).toEqual(['HULU']);
  });

  it('rejects when Wealthfolio cannot be read', async () => {
    await expect(readSubscriptionRoster(vi.fn(async () => { throw new Error('ECONNREFUSED'); }), TODAY)).rejects.toThrow('ECONNREFUSED');
  });
});
```

In `companion/src/reports-server.test.ts`, add `import { emptySubscriptionPrefs } from '../../shared/subscription-prefs.js';`, and in the `deps` fake replace the two lines `readHiddenSubscriptions: …` and `readConfirmedSubscriptions: …` with:

```ts
  readSubscriptionPrefs: vi.fn(async () => emptySubscriptionPrefs()),
```

Then add inside `describe('handleReportsRequest', …)`:

```ts
  it('renders subscriptions from the roster: renames, hides, bills apart, the card\'s total', async () => {
    const d = deps({
      readCube: vi.fn(async () => ({ ...CUBE, subscriptions: [
        { name: 'SPOTIFY', monthlyCents: 1099, count: 5, lastDate: '2026-08-20', lastCents: 1099, creep: false, kind: 'subscription' },
        { name: 'LG&E', monthlyCents: 6149, count: 6, lastDate: '2026-08-28', lastCents: 6149, creep: false, kind: 'bill' },
        { name: 'QR LIBRARY', monthlyCents: 499, count: 4, lastDate: '2026-08-22', lastCents: 499, creep: false, kind: 'subscription' },
      ] } as never)),
      readSubscriptionPrefs: vi.fn(async () => ({
        ...emptySubscriptionPrefs(),
        names: { SPOTIFY: 'Spotify' },
        hidden: ['QR LIBRARY'],
        manual: [{ id: 'dom00001', name: 'Domain', cents: 9900, cadence: 'yearly' as const, nextDate: '2027-03-03' }],
      })),
    });
    const res = await handleReportsRequest(d, { method: 'POST', path: '/page', body: pageBody() });
    expect(res.body).toContain('<span>Spotify</span><span>$10.99/mo</span>');
    expect(res.body).not.toContain('QR LIBRARY');
    expect(res.body).toContain('$10.99/mo + $99/yr across 2');
    expect(res.body).toContain('<span>LG&amp;E</span><span>about $61/mo</span>');
  });
```

The existing `'renders merchants and subscriptions as readable rows'` test stays as it is (`'$10.99'` is still in `$10.99/mo`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix companion test -- src/subscription-data.test.ts src/reports-server.test.ts`
Expected: FAIL — `Failed to load url ./subscription-data.js`, and the reports server never calls `readSubscriptionPrefs`.

- [ ] **Step 3: Implement**

Create `companion/src/subscription-data.ts`:

```ts
/**
 * companion/src/subscription-data.ts
 *
 * The roster as every companion surface sees it: the published cube plus the
 * stored subscription document, built for one `today`. One reader, so the
 * weekly line, the morning block, /subscriptions and its buttons cannot
 * disagree about what counts.
 */
import { parseReportCube, REPORT_CUBE_SECRET_KEY } from '../../shared/report-cube.js';
import { loadSubscriptionPrefs, type SecretGet, type SubscriptionPrefs } from '../../shared/subscription-prefs.js';
import { buildRoster, type Roster } from '../../shared/subscription-roster.js';

export interface RosterRead {
  roster: Roster;
  /** What the roster was built from — the menu's undo paths read `deleted` and `prevNames`. */
  prefs: SubscriptionPrefs;
  /** The stored document is corrupt: `prefs` is the legacy lists and writes are refused. */
  unreadable: boolean;
  today: string;
}

/** Rejects when Wealthfolio cannot be read; callers choose silence (a report)
 *  or "Couldn't reach Wealthfolio — try again." (a tap). */
export async function readSubscriptionRoster(get: SecretGet, today: string): Promise<RosterRead> {
  const [cubeRaw, loaded] = await Promise.all([get(REPORT_CUBE_SECRET_KEY), loadSubscriptionPrefs(get)]);
  const cube = parseReportCube(cubeRaw);
  const roster = buildRoster({
    detected: cube?.subscriptions ?? null,
    merchants: cube?.merchants ?? [],
    links: cube?.subscriptionLinks ?? [],
    prefs: loaded.prefs,
    today,
  });
  return { roster, prefs: loaded.prefs, unreadable: loaded.unreadable, today };
}
```

In `companion/src/reports-server.ts`:

1. Imports: remove `subscriptionSummary` from the `../../shared/report-data.js` import list, and add:
```ts
import type { SubscriptionPrefs } from '../../shared/subscription-prefs.js';
import {
  aboutDollars, buildRoster, formatRosterTotal, localIsoDay, rosterPrice, type RosterEntry,
} from '../../shared/subscription-roster.js';
```

2. In `ReportsServerDeps`, replace `readHiddenSubscriptions(): Promise<string[]>;` and `readConfirmedSubscriptions(): Promise<string[]>;` with:
```ts
  /** The subscription document the card and the bot edit (1.60). */
  readSubscriptionPrefs(): Promise<SubscriptionPrefs>;
```

3. In `BoardData`, replace `hiddenSubs: string[];` and `confirmedSubs: string[];` with:
```ts
  subscriptionPrefs: SubscriptionPrefs;
  /** The reader's local day, for next dates. */
  today: string;
```

4. Replace the whole `if (id === 'subscriptions') { … }` block with:
```ts
    if (id === 'subscriptions') {
      // The roster, as the card and /subscriptions render it: one filter, three surfaces.
      const roster = buildRoster({
        detected: cube.subscriptions ?? null,
        merchants: cube.merchants,
        links: cube.subscriptionLinks ?? [],
        prefs: data.subscriptionPrefs,
        today: data.today,
      });
      if (!roster.detectionAvailable && roster.subscriptions.length === 0) return '';
      const row = (e: RosterEntry) => `<div class="row"><span>${esc(e.displayName)}</span><span>${esc(rosterPrice(e))}</span></div>`;
      const total = `<div class="row total"><span>Total</span><span>${formatRosterTotal(roster)} across ${roster.subscriptions.length}</span></div>`;
      const bills = roster.bills.length > 0
        ? `<div class="row total"><span>Bills</span><span>about ${aboutDollars(roster.billsMonthlyCents)}/mo</span></div>${roster.bills.map(row).join('')}`
        : '';
      return section(id, 'Subscriptions', `${roster.subscriptions.map(row).join('')}${total}${bills}`);
    }
```

5. In the `dashboardHtml({ … })` call of the `/page` handler, replace the `hiddenSubs: …` and `confirmedSubs: …` lines with:
```ts
        subscriptionPrefs: await deps.readSubscriptionPrefs(),
        today: localIsoDay(deps.now?.() ?? new Date()),
```

In `companion/src/index.ts`:

1. Extend the Task 3 import from `../../shared/subscription-prefs.js` with `emptySubscriptionPrefs`.

2. In the reports-server deps object, replace the `readHiddenSubscriptions: …` and `readConfirmedSubscriptions: …` properties with:
```ts
      // The document the card and the bot edit. A failed read renders the page
      // with nothing hidden rather than no page.
      readSubscriptionPrefs: async () =>
        (await loadSubscriptionPrefs(subscriptionSecrets(wfClient).get).catch(() => null))?.prefs ?? emptySubscriptionPrefs(),
```

`HIDDEN_SUBSCRIPTIONS_SECRET_KEY`, `CONFIRMED_SUBSCRIPTIONS_SECRET_KEY` and `parseHiddenSubscriptions` are still used by `readCubeSubscriptions` until Task 8; leave their import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix companion test -- src/subscription-data.test.ts src/reports-server.test.ts`
Expected: PASS.

Run: `npm --prefix companion run build`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add companion/src/subscription-data.ts companion/src/subscription-data.test.ts companion/src/reports-server.ts companion/src/reports-server.test.ts companion/src/index.ts
git commit -m "Subscriptions: one companion roster reader; the mini app renders from it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The Telegram subscription text (pure)

**Files:**
- Modify: `shared/telegram.ts` (new section at the end of the file; one import at the top)
- Test: `shared/telegram-subscriptions.test.ts` (create)

**Interfaces:**
- Consumes: Task 2 (`Roster`, `RosterEntry`, `dueWithin`, `daysBetween`, `rosterAmount`, `rosterMoney`, `rosterWhen`, `formatRosterTotal`, `aboutDollars`); existing `escapeMarkdown`, `formatDollars`, `shortDate`, `headerGlyph` (module-private), `GlyphStyle`, `DEFAULT_GLYPH_STYLE`, `ReportDetail` in `shared/telegram.ts`.
- Produces (all exported from `shared/telegram.ts`):

```ts
export const SUBSCRIPTION_PAGE_SIZE = 10;
export function subscriptionListPage(roster: Roster, page: number): { entries: RosterEntry[]; page: number; pages: number };
export function formatSubscriptionRow(e: RosterEntry): string;
export const SUBSCRIPTIONS_UNREADABLE_NOTE: string;
export function formatSubscriptionList(roster: Roster, page: number, opts?: { unreadable?: boolean }): string;
export interface ComingUpBlock { text: string; cancelled: RosterEntry[] }
export function formatComingUpBlock(roster: Roster, today: string, detail: ReportDetail, style?: GlyphStyle): ComingUpBlock | null;
export const SUBSCRIPTION_NEWS_SECRET_KEY = 'subscription_news_sent';
export interface SubscriptionNews { text: string; events: string[]; cancelled: RosterEntry[] }
export function formatSubscriptionNews(roster: Roster, today: string, sent: Readonly<Record<string, string>>, style?: GlyphStyle): SubscriptionNews | null;
export function parseNewsSent(raw: string | null | undefined): Record<string, string>;
export function pruneNewsSent(sent: Readonly<Record<string, string>>, today: string): Record<string, string>;
export function formatNextWeekLine(due: RosterEntry[], style?: GlyphStyle): string | null;
```

Event ids are `${key}|remind|${nextDate}`, `${key}|creep|${chargedOn}`, `${key}|cancel|${overdueSince}`; `sent` maps an event id to the day it was sent.

- [ ] **Step 1: Write the failing tests**

Create `shared/telegram-subscriptions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GLYPH_STYLE, formatComingUpBlock, formatNextWeekLine, formatSubscriptionList, formatSubscriptionNews,
  formatSubscriptionRow, parseNewsSent, pruneNewsSent, subscriptionListPage,
} from './telegram.js';
import { buildRoster, dueWithin, type RosterInput } from './subscription-roster.js';
import { emptySubscriptionPrefs, type SubscriptionPrefs } from './subscription-prefs.js';
import type { DetectedSubscription } from './subscriptions.js';

const TODAY = '2026-10-12';
const GLYPHS = { mode: 'glyphs' as const, overrides: {} };
/** DetectedSubscription exactly as a 1.60 companion publishes it in the cube. */
const det = (name: string, over: Partial<DetectedSubscription> = {}): DetectedSubscription => {
  const lastDate = over.lastDate ?? '2026-09-15';
  const lastCents = over.lastCents ?? over.monthlyCents ?? 1199;
  return {
    name, monthlyCents: 1199, count: 4, lastDate, lastCents, prevCents: lastCents, creep: false, kind: 'subscription',
    recent: [{ date: lastDate, cents: lastCents }], ...over,
  };
};
const prefsWith = (over: Partial<SubscriptionPrefs> = {}): SubscriptionPrefs => ({ ...emptySubscriptionPrefs(), ...over });
const roster = (over: Partial<RosterInput> = {}) =>
  buildRoster({ detected: [], merchants: [[], []], links: [], prefs: prefsWith(), today: TODAY, ...over });

/** A morning: a reminder 3 days out, a bill due in 4, a fresh price rise with a
 *  Markdown star in the bank's name, a charge missed 9 days ago, one far off. */
const morning = (today = TODAY, prefs: Partial<SubscriptionPrefs> = { remind: { SPOTIFY: 3 } }) => roster({
  today,
  detected: [
    det('SPOTIFY', { lastDate: '2026-09-15' }),
    det('RENT LLC', { kind: 'bill', monthlyCents: 80000, lastDate: '2026-09-16' }),
    det('PAYPAL *HULU', { monthlyCents: 999, lastCents: 1099, creep: true, lastDate: '2026-10-10' }),
    det('NETFLIX', { monthlyCents: 1549, lastDate: '2026-09-03' }),
    det('ADOBE', { monthlyCents: 5499, lastDate: '2026-09-25' }),
  ],
  prefs: prefsWith(prefs),
});

describe('formatComingUpBlock', () => {
  it('Full: reminders, the week ahead, the price rise, the missed charge — in that order', () => {
    expect(formatComingUpBlock(morning(), TODAY, 'full')?.text).toBe([
      '*Coming up*',
      '🔔 SPOTIFY charges in 3 days · $11.99',
      'RENT LLC Oct 16 · about $800',
      '📈 PAYPAL \\*HULU charged $10.99 — up from its usual $9.99.',
      "✓ NETFLIX didn't charge Oct 3 — cancelled?",
    ].join('\n'));
  });

  it('Brief leaves out the week ahead', () => {
    expect(formatComingUpBlock(morning(), TODAY, 'brief')?.text).toBe([
      '*Coming up*',
      '🔔 SPOTIFY charges in 3 days · $11.99',
      '📈 PAYPAL \\*HULU charged $10.99 — up from its usual $9.99.',
      "✓ NETFLIX didn't charge Oct 3 — cancelled?",
    ].join('\n'));
  });

  it('never repeats a 🔔 entry in the week ahead', () => {
    expect(formatComingUpBlock(morning(), TODAY, 'full')!.text.match(/SPOTIFY/g)).toHaveLength(1);
  });

  it('says tomorrow and today as the day comes, and nothing before the window opens', () => {
    expect(formatComingUpBlock(morning('2026-10-14'), '2026-10-14', 'brief')!.text).toContain('🔔 SPOTIFY charges tomorrow · $11.99');
    expect(formatComingUpBlock(morning('2026-10-15'), '2026-10-15', 'brief')!.text).toContain('🔔 SPOTIFY charges today · $11.99');
    expect(formatComingUpBlock(morning('2026-10-11'), '2026-10-11', 'brief')?.text ?? '').not.toContain('🔔');
  });

  it('the price-rise line lasts the charge day and the three after it', () => {
    const block = (today: string) => formatComingUpBlock(morning(today), today, 'brief')?.text ?? '';
    expect(block('2026-10-13')).toContain('📈');
    expect(block('2026-10-14')).not.toContain('📈');
  });

  it('asks "cancelled?" on the first three mornings an entry is overdue', () => {
    const asked = (today: string) => (formatComingUpBlock(morning(today), today, 'brief')?.text ?? '').includes('NETFLIX didn');
    expect(['2026-10-10', '2026-10-11', '2026-10-13', '2026-10-14'].map(asked)).toEqual([false, true, true, false]);
  });

  it('returns the entries behind the "cancelled?" lines, for their Hide buttons', () => {
    expect(formatComingUpBlock(morning(), TODAY, 'brief')!.cancelled.map((e) => e.key)).toEqual(['NETFLIX']);
  });

  it('is absent when it has nothing to say, and hidden entries say nothing', () => {
    expect(formatComingUpBlock(roster({ detected: [det('ADOBE', { lastDate: '2026-09-25' })] }), TODAY, 'full')).toBeNull();
    expect(formatComingUpBlock(morning(TODAY, {
      remind: { SPOTIFY: 3 }, hidden: ['SPOTIFY', 'RENT LLC', 'PAYPAL *HULU', 'NETFLIX'],
    }), TODAY, 'full')).toBeNull();
  });

  it('escapes renamed names too, and keeps them out of bold', () => {
    const r = roster({
      today: '2026-10-14',
      detected: [det('SPOTIFY', { lastDate: '2026-09-15' })],
      prefs: prefsWith({ remind: { SPOTIFY: 1 }, names: { SPOTIFY: 'Spotify_Family*' } }),
    });
    expect(formatComingUpBlock(r, '2026-10-14', 'brief')?.text).toBe('*Coming up*\n🔔 Spotify\\_Family\\* charges tomorrow · $11.99');
  });

  it('puts the calendar on the header only when the reports wear glyphs', () => {
    expect(formatComingUpBlock(morning(), TODAY, 'brief', GLYPHS)!.text.split('\n')[0]).toBe('📅 *Coming up*');
    expect(formatComingUpBlock(morning(), TODAY, 'brief', DEFAULT_GLYPH_STYLE)!.text.split('\n')[0]).toBe('*Coming up*');
  });
});

describe('formatSubscriptionNews (daily report off)', () => {
  it('says each event once: what was sent stays out, and there is no week-ahead list', () => {
    const news = formatSubscriptionNews(morning(), TODAY, { 'SPOTIFY|remind|2026-10-15': '2026-10-11' })!;
    expect(news.text).toBe([
      '*Coming up*',
      '📈 PAYPAL \\*HULU charged $10.99 — up from its usual $9.99.',
      "✓ NETFLIX didn't charge Oct 3 — cancelled?",
    ].join('\n'));
    expect(news.events).toEqual(['PAYPAL *HULU|creep|2026-10-10', 'NETFLIX|cancel|2026-10-03']);
    expect(news.cancelled.map((e) => e.key)).toEqual(['NETFLIX']);
  });

  it('is null once everything has been said', () => {
    expect(formatSubscriptionNews(morning(), TODAY, {
      'SPOTIFY|remind|2026-10-15': '2026-10-12',
      'PAYPAL *HULU|creep|2026-10-10': '2026-10-12',
      'NETFLIX|cancel|2026-10-03': '2026-10-12',
    })).toBeNull();
  });
});

describe('news bookkeeping', () => {
  it('reads the sent map leniently — it is the companion\'s own memo, not a user choice', () => {
    expect(parseNewsSent(null)).toEqual({});
    expect(parseNewsSent('oops')).toEqual({});
    expect(parseNewsSent('{"a|remind|2026-10-15":"2026-10-12","b":3}')).toEqual({ 'a|remind|2026-10-15': '2026-10-12' });
  });

  it('forgets events sent more than 60 days ago', () => {
    expect(pruneNewsSent({ old: '2026-08-12', edge: '2026-08-13', fresh: '2026-10-01' }, TODAY))
      .toEqual({ edge: '2026-08-13', fresh: '2026-10-01' });
  });
});

describe('formatNextWeekLine', () => {
  it('counts and totals the week; the calendar only with glyphs', () => {
    const due = dueWithin(morning(), '2026-10-13', 7);
    expect(formatNextWeekLine(due, GLYPHS)).toBe('📅 Next week: 2 charges · $811.99');
    expect(formatNextWeekLine(due.slice(0, 1))).toBe('Next week: 1 charge · $11.99');
    expect(formatNextWeekLine([])).toBeNull();
  });
});

describe('formatSubscriptionList', () => {
  const list = () => roster({
    detected: [
      det('SPOTIFY', { lastDate: '2026-09-15' }),
      det('NETFLIX', { monthlyCents: 1549, lastCents: 1799, creep: true, lastDate: '2026-09-22' }),
      det('LG&E', { kind: 'bill', monthlyCents: 6149, lastDate: '2026-09-28' }),
    ],
    prefs: prefsWith({
      names: { SPOTIFY: 'Spotify' },
      remind: { SPOTIFY: 3 },
      manual: [
        { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' },
        { id: 'dom00001', name: 'Domain', cents: 9900, cadence: 'yearly', nextDate: '2027-03-03' },
      ],
    }),
  });

  it('renders the groups with their totals, the way the spec draws them', () => {
    expect(formatSubscriptionList(list(), 0)).toBe([
      '💳 *Subscriptions* · $39.97/mo + $99/yr',
      'NETFLIX — $17.99 · next Oct 22 · ⬆ was $15.49',
      'Spotify — $11.99 · next Oct 15 🔔',
      'Hulu ✍️ — $9.99 · next Oct 20',
      'Domain ✍️ — $99/yr · next Mar 3',
      '📄 *Bills* · about $61/mo',
      'LG&E — about $61 · next Oct 28',
    ].join('\n'));
  });

  it('leads with an unreadable-settings note and a link suggestion', () => {
    const r = roster({
      prefs: prefsWith({ manual: [{ id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' }] }),
      links: [{ manualId: 'hulu0001', merchant: 'HULU', date: '2026-09-19', cents: 999 }],
    });
    const lines = formatSubscriptionList(r, 0, { unreadable: true }).split('\n');
    expect(lines[0]).toBe("⚠️ Couldn't read your subscription settings — changes are paused, and this list shows your older choices.");
    expect(lines[2]).toBe('Is HULU your Hulu? ($9.99 on Sep 19)');
  });

  it('says what to do when the list is empty', () => {
    expect(formatSubscriptionList(roster(), 0))
      .toBe('💳 *Subscriptions* · $0/mo\nNothing recurring found yet — tap ➕ Add to track one by hand.');
    expect(formatSubscriptionList(roster({ detected: null }), 0))
      .toContain("The companion hasn't looked for recurring charges yet — tap ➕ Add to track one by hand.");
  });

  it('pages at ten rows', () => {
    const many = roster({ detected: Array.from({ length: 12 }, (_, i) => det(`SUB ${String(i).padStart(2, '0')}`, { monthlyCents: 1000 + i })) });
    expect(subscriptionListPage(many, 0).entries).toHaveLength(10);
    expect(subscriptionListPage(many, 1)).toMatchObject({ page: 1, pages: 2 });
    expect(subscriptionListPage(many, 9).page).toBe(1);
    expect(formatSubscriptionList(many, 1)).toContain('_Page 2 of 2_');
  });

  it('escapes bank names and marks reminded rows', () => {
    const r = roster({ detected: [det('SQ *COFFEE_CLUB', { lastDate: '2026-09-15' })], prefs: prefsWith({ remind: { 'SQ *COFFEE_CLUB': 1 } }) });
    expect(formatSubscriptionRow(r.subscriptions[0])).toBe('SQ \\*COFFEE\\_CLUB — $11.99 · next Oct 15 🔔');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run shared/telegram-subscriptions.test.ts`
Expected: FAIL — `formatComingUpBlock is not a function` (and the others).

- [ ] **Step 3: Implement**

At the top of `shared/telegram.ts`, below `import type { PoolStatus } from './pool.js';`, add:

```ts
import {
  aboutDollars, daysBetween, dueWithin, formatRosterTotal, rosterAmount, rosterMoney, rosterWhen,
  type Roster, type RosterEntry,
} from './subscription-roster.js';
```

Append to the end of `shared/telegram.ts`:

```ts
// ── Subscriptions (1.60) ──────────────────────────────────────────────────
//
// SAFETY: every bank- or user-supplied name below is escaped AND kept out of
// bold/italic. Legacy Markdown ignores a backslash escape inside an entity
// (see formatBiggestThisWeek), so `*SQ \*COFFEE*` would cost the whole message.

export const SUBSCRIPTION_PAGE_SIZE = 10;

/** One page of the list's rows: subscriptions, then bills. An out-of-range
 *  page clamps to the last one, so an old Next › button still lands somewhere. */
export function subscriptionListPage(roster: Roster, page: number): { entries: RosterEntry[]; page: number; pages: number } {
  const all = [...roster.subscriptions, ...roster.bills];
  const pages = Math.max(1, Math.ceil(all.length / SUBSCRIPTION_PAGE_SIZE));
  const p = Math.min(Math.max(0, Math.floor(page) || 0), pages - 1);
  return { entries: all.slice(p * SUBSCRIPTION_PAGE_SIZE, (p + 1) * SUBSCRIPTION_PAGE_SIZE), page: p, pages };
}

/** `Spotify — $11.99 · next Oct 15 🔔`, `Hulu ✍️ — $9.99 · next Oct 20`,
 *  `Netflix — $17.99 · next Oct 22 · ⬆ was $15.49`. */
export function formatSubscriptionRow(e: RosterEntry): string {
  const mark = e.source === 'manual' ? ' ✍️' : '';
  const bell = e.remind ? ' 🔔' : '';
  const creep = e.creep ? ` · ⬆ was ${rosterMoney(e.creep.fromCents)}` : '';
  return `${escapeMarkdown(e.displayName)}${mark} — ${rosterAmount(e)} · ${rosterWhen(e)}${bell}${creep}`;
}

export const SUBSCRIPTIONS_UNREADABLE_NOTE =
  "⚠️ Couldn't read your subscription settings — changes are paused, and this list shows your older choices.";

export function formatSubscriptionList(roster: Roster, page: number, opts: { unreadable?: boolean } = {}): string {
  const { entries, page: p, pages } = subscriptionListPage(roster, page);
  const lines: string[] = [];
  if (opts.unreadable) lines.push(SUBSCRIPTIONS_UNREADABLE_NOTE, '');
  const link = roster.linkSuggestions[0];
  if (link) {
    lines.push(
      `Is ${escapeMarkdown(link.merchant)} your ${escapeMarkdown(link.manualName)}? (${rosterMoney(link.cents)} on ${shortDate(link.date)})`,
      '',
    );
  }
  lines.push(`💳 *Subscriptions* · ${formatRosterTotal(roster)}`);
  if (roster.subscriptions.length === 0 && roster.bills.length === 0) {
    lines.push(roster.detectionAvailable
      ? 'Nothing recurring found yet — tap ➕ Add to track one by hand.'
      : "The companion hasn't looked for recurring charges yet — tap ➕ Add to track one by hand.");
  }
  lines.push(...entries.filter((e) => e.group === 'subscription').map(formatSubscriptionRow));
  const bills = entries.filter((e) => e.group === 'bill');
  if (bills.length > 0) {
    lines.push(`📄 *Bills* · about ${aboutDollars(roster.billsMonthlyCents)}/mo`, ...bills.map(formatSubscriptionRow));
  }
  if (pages > 1) lines.push(`_Page ${p + 1} of ${pages}_`);
  return lines.join('\n');
}

/** The 1.x digest's rule, now in whole days: the charge day and three more. */
const CREEP_FRESH_DAYS = 3;
/** "Cancelled?" on the first three mornings an entry is overdue — overdue
 *  starts once the 7-day late grace is over. */
const CANCEL_ASK_FROM_DAYS = 8;
const CANCEL_ASK_TO_DAYS = 10;

interface ComingUpLine { id: string; text: string; entry: RosterEntry }

function comingUpParts(roster: Roster, today: string) {
  const active = [...roster.subscriptions, ...roster.bills];
  const reminders: ComingUpLine[] = dueWithin(roster, today, 8)
    .filter((e) => e.remind !== undefined && daysBetween(today, e.nextDate!) <= e.remind)
    .map((e) => {
      const days = daysBetween(today, e.nextDate!);
      const when = days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`;
      return { id: `${e.key}|remind|${e.nextDate}`, text: `🔔 ${escapeMarkdown(e.displayName)} charges ${when} · ${rosterAmount(e)}`, entry: e };
    });
  const reminded = new Set(reminders.map((l) => l.entry.key));
  const creeps: ComingUpLine[] = active
    .filter((e) => {
      if (!e.creep) return false;
      const days = daysBetween(e.creep.chargedOn, today);
      return days >= 0 && days <= CREEP_FRESH_DAYS;
    })
    .map((e) => ({
      id: `${e.key}|creep|${e.creep!.chargedOn}`,
      text: `📈 ${escapeMarkdown(e.displayName)} charged ${formatDollars(e.creep!.toCents / 100, 2)}`
        + ` — up from its usual ${formatDollars(e.creep!.fromCents / 100, 2)}.`,
      entry: e,
    }));
  const cancels: ComingUpLine[] = active
    .filter((e) => {
      if (!e.overdueSince) return false;
      const days = daysBetween(e.overdueSince, today);
      return days >= CANCEL_ASK_FROM_DAYS && days <= CANCEL_ASK_TO_DAYS;
    })
    .map((e) => ({
      id: `${e.key}|cancel|${e.overdueSince}`,
      text: `✓ ${escapeMarkdown(e.displayName)} didn't charge ${shortDate(e.overdueSince!)} — cancelled?`,
      entry: e,
    }));
  const due = dueWithin(roster, today, 7).filter((e) => !reminded.has(e.key));
  return { reminders, creeps, cancels, due };
}

export interface ComingUpBlock {
  text: string;
  /** Entries behind the "cancelled?" lines, in order — for their Hide buttons. */
  cancelled: RosterEntry[];
}

/**
 * The daily report's "Coming up" block, after the spending summary and before
 * the 🧹 line. Brief: reminders, the price-rise line and "cancelled?". Full
 * adds everything charging today and the 6 days after that is not already on
 * a 🔔 line. Null when there is nothing to say.
 */
export function formatComingUpBlock(
  roster: Roster,
  today: string,
  detail: ReportDetail,
  style: GlyphStyle = DEFAULT_GLYPH_STYLE,
): ComingUpBlock | null {
  const { reminders, creeps, cancels, due } = comingUpParts(roster, today);
  const lines = reminders.map((l) => l.text);
  if (detail === 'full' && due.length > 0) {
    lines.push(due.map((e) => `${escapeMarkdown(e.displayName)} ${shortDate(e.nextDate!)} · ${rosterAmount(e)}`).join(' · '));
  }
  lines.push(...creeps.map((l) => l.text), ...cancels.map((l) => l.text));
  if (lines.length === 0) return null;
  return { text: [`${headerGlyph('📅', style)}*Coming up*`, ...lines].join('\n'), cancelled: cancels.map((l) => l.entry) };
}

/** Companion setting: which "Coming up" events were sent while the daily
 *  report is off — event id → the day it was sent. */
export const SUBSCRIPTION_NEWS_SECRET_KEY = 'subscription_news_sent';
const NEWS_KEEP_DAYS = 60;

export interface SubscriptionNews {
  text: string;
  /** Ids to record as sent once the message is delivered. */
  events: string[];
  cancelled: RosterEntry[];
}

/** With the daily report off: the 🔔, 📈 and ✓ lines not sent before, as one
 *  short message (no week-ahead list). A reminder goes out on the first
 *  morning inside its window that the companion runs. Null when nothing is new. */
export function formatSubscriptionNews(
  roster: Roster,
  today: string,
  sent: Readonly<Record<string, string>>,
  style: GlyphStyle = DEFAULT_GLYPH_STYLE,
): SubscriptionNews | null {
  const { reminders, creeps, cancels } = comingUpParts(roster, today);
  const fresh = [...reminders, ...creeps, ...cancels].filter((l) => !(l.id in sent));
  if (fresh.length === 0) return null;
  return {
    text: [`${headerGlyph('📅', style)}*Coming up*`, ...fresh.map((l) => l.text)].join('\n'),
    events: fresh.map((l) => l.id),
    cancelled: fresh.filter((l) => cancels.includes(l)).map((l) => l.entry),
  };
}

/** Lenient on purpose: a lost memo can at worst repeat a line once. */
export function parseNewsSent(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([, day]) => typeof day === 'string')) as Record<string, string>;
  } catch {
    return {};
  }
}

export function pruneNewsSent(sent: Readonly<Record<string, string>>, today: string): Record<string, string> {
  return Object.fromEntries(Object.entries(sent).filter(([, day]) => daysBetween(day, today) <= NEWS_KEEP_DAYS));
}

/** The weekly report's `📅 Next week: 4 charges · $852`, or null for none. */
export function formatNextWeekLine(due: RosterEntry[], style: GlyphStyle = DEFAULT_GLYPH_STYLE): string | null {
  if (due.length === 0) return null;
  const total = due.reduce((s, e) => s + e.cents, 0);
  return `${headerGlyph('📅', style)}Next week: ${due.length} ${due.length === 1 ? 'charge' : 'charges'} · ${rosterMoney(total)}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run shared/telegram-subscriptions.test.ts shared/telegram.test.ts`
Expected: PASS (the existing telegram tests are untouched).

Run: `npm run type-check && npm --prefix companion run build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add shared/telegram.ts shared/telegram-subscriptions.test.ts
git commit -m "Telegram: subscription list, Coming-up block, report-off news and next-week line

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 6: `/subscriptions` — the stateless menu

**Files:**
- Create: `companion/src/subscriptions-menu.ts`
- Test: `companion/src/subscriptions-menu.test.ts`
- Modify: `shared/telegram-commands.ts` (`TELEGRAM_MORE_COMMANDS` ~line 63-69 and its comment)
- Test: `shared/telegram-commands.test.ts` (`'keeps the other five working…'` ~line 59-69)
- Modify: `companion/src/index.ts` (imports; new `readRosterFor` beside `subscriptionSecrets`; `case 'subscriptions'` in `buildTelegramCommandHandler`'s switch, before `case 'status':` ~line 3013; the menu in `buildTelegramListenerDeps` after `const findings…` ~line 3290; routing in `onMenuCallback` after the `findings.handles` check ~line 3435)
- Test: `companion/src/index.test.ts` (inside `describe('buildTelegramCommandHandler', …)` ~line 1957)

**Interfaces:**
- Consumes: Task 1 edits and `isUnreadablePrefsError`; Task 2 (`Roster`, `RosterEntry`, `manualKey`, `rosterAmount`, `rosterMoney`, `rosterWhen`); Task 3 (`subscriptionSecrets`); Task 4 (`RosterRead`, `readSubscriptionRoster`); Task 5 (`formatSubscriptionList`, `subscriptionListPage`); `askStartData` (`shared/ask-flow.ts`), `findingHandle` (`shared/findings.ts`), `MENU_CALLBACK_PREFIX` (`shared/categorize-menu.ts`), `escapeMarkdown`, `shortDate`, `InlineKeyboard` (`shared/telegram.ts`).
- Produces (`companion/src/subscriptions-menu.ts`):

```ts
export const SUBSCRIPTIONS_CALLBACK_PREFIX = 'cz:sb:';
export const OPEN_SUBSCRIPTIONS = 'cz:sb:o';
export const SUBSCRIPTIONS_BUTTON = { text: '💳 Subscriptions', callback_data: 'cz:sb:o' };
export const SEE_ALL_SUBSCRIPTIONS_BUTTON = { text: 'See all', callback_data: 'cz:sb:o' };
export const SUBSCRIPTIONS_GONE_ANSWER = 'That one is already sorted — refreshing.';
export const SUBSCRIPTIONS_UNREACHABLE_REPLY = "Couldn't reach Wealthfolio — try again.";
export const SUBSCRIPTIONS_UNREADABLE_REPLY = "Couldn't read your subscription settings — nothing was changed.";
export const SUBSCRIPTIONS_RENAME_GONE_REPLY = 'That one is gone now — send /subscriptions for the current list.';
export interface MenuScreen { text: string; keyboard: InlineKeyboard }
export interface SubscriptionsMenuUi { edit(text: string, keyboard?: InlineKeyboard): Promise<void>; answer(text?: string): Promise<void>; send(text: string, keyboard?: InlineKeyboard): Promise<void> }
export interface SubscriptionsMenuDeps {
  read(now: Date): Promise<RosterRead>;
  edit(edit: SubscriptionEdit, now: Date): Promise<SubscriptionPrefs>;
  now(): Date;
  log(msg: string): void;
}
export interface SubscriptionsMenu { handles(data: string): boolean; onCallback(cb: { data: string; chatId: number }, ui: SubscriptionsMenuUi): Promise<void> }
export function hideFromReportButton(e: RosterEntry): { text: string; callback_data: string };   // 'cz:sb:hr:<handle>'
export function undoRenameButton(handle: string): { text: string; callback_data: string };     // 'cz:sb:un:<handle>'
export function findRosterEntry(roster: Roster, handle: string): RosterEntry | undefined;
export function renderSubscriptionList(read: RosterRead, page: number): MenuScreen;
export function renderSubscriptionDetail(e: RosterEntry): MenuScreen;
export function renderMaybe(roster: Roster): MenuScreen;
export function renderHidden(roster: Roster): MenuScreen;
export function createSubscriptionsMenu(deps: SubscriptionsMenuDeps): SubscriptionsMenu;
```

- In `index.ts` (module-private): `async function readRosterFor(wfClient: WealthfolioClient, now: Date): Promise<RosterRead>`.

**Callback data (all `cz:sb:` + …):** `o` open as a NEW message · `l:<page>` list · `mb` maybes · `hd` hidden · `d:<h>` detail · `r0|r1|r3|r7:<h>` remind · `h:<h>` hide (detail) · `hr:<h>` hide from a report (answers in a NEW message) · `hm:<h>` a maybe's No · `c:<h>` a maybe's Yes · `x:<h>` delete hand-added · `u:<h>` restore from Hidden · `uh:<h>` undo hide · `uc:<h>` undo confirm · `ux:<h>` undo delete · `un:<h>` undo rename · `ly:<h>`/`ln:<h>` link Yes/No (`<h>` = handle of `m:<manualId>`). Longest is 17 bytes.

- [ ] **Step 1: Write the failing tests**

Create `companion/src/subscriptions-menu.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { findingHandle } from '../../shared/findings.js';
import { editSubscriptionPrefs, emptySubscriptionPrefs, type SubscriptionPrefs } from '../../shared/subscription-prefs.js';
import { localIsoDay } from '../../shared/subscription-roster.js';
import { readSubscriptionRoster } from './subscription-data.js';
import {
  createSubscriptionsMenu, renderSubscriptionDetail, OPEN_SUBSCRIPTIONS, SUBSCRIPTIONS_GONE_ANSWER,
  SUBSCRIPTIONS_UNREACHABLE_REPLY, SUBSCRIPTIONS_UNREADABLE_REPLY, type SubscriptionsMenuDeps,
} from './subscriptions-menu.js';

const NOW = new Date(2026, 9, 12, 9, 0, 0);
const H = (key: string) => findingHandle(key);

/** report_cube exactly as the companion publishes it. */
const cubeJson = (subscriptions: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({
  version: 1, asOf: '2026-10-12T06:00:00.000Z', months: ['2026-09', '2026-10'], categories: [], accounts: [],
  spend: [[], []], uncategorized: [[], []], income: [[], []], budgets: [[], []], merchants: [[], []],
  feesInterest: [0, 0], netWorth: [null, null], liquid: [null, null], pool: null, subscriptions, ...extra,
});
const det = (name: string, over: Record<string, unknown> = {}) => ({
  name, monthlyCents: 1199, count: 5, lastDate: '2026-09-15', lastCents: 1199, prevCents: 1199, creep: false,
  kind: 'subscription', recent: [{ date: '2026-09-15', cents: 1199 }], ...over,
});
const doc = (over: Partial<SubscriptionPrefs> = {}) => JSON.stringify({ ...emptySubscriptionPrefs(), ...over });
const HULU = { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly' as const, nextDate: '2026-10-20' };

/** Real reader and writer over a Map; every tap builds a NEW menu, as after a restart. */
function harness(entries: Record<string, string>) {
  const secrets = new Map(Object.entries(entries));
  const get = vi.fn(async (k: string) => secrets.get(k) ?? null);
  const set = vi.fn(async (k: string, v: string) => { secrets.set(k, v); });
  const deps: SubscriptionsMenuDeps = {
    read: (now) => readSubscriptionRoster(get, localIsoDay(now)),
    edit: (edit, now) => editSubscriptionPrefs(get, set, edit, now),
    now: () => NOW,
    log: vi.fn(),
  };
  const ui = { edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) };
  const tap = (data: string) => createSubscriptionsMenu(deps).onCallback({ data, chatId: 1 }, ui);
  const stored = () => JSON.parse(secrets.get('subscription_prefs') ?? 'null');
  return { secrets, get, set, ui, tap, stored };
}
const datas = (kb: any): string[] => kb.inline_keyboard.flat().map((b: any) => b.callback_data);
const texts = (kb: any): string[] => kb.inline_keyboard.flat().map((b: any) => b.text);
const BASE = () => ({
  report_cube: cubeJson([det('SPOTIFY'), det('MYSTERY BOX', { kind: 'possible', monthlyCents: 1500, lastCents: 1500, count: 2 })]),
});

describe('subscriptions menu', () => {
  it('the report button sends the list as a NEW message — the report is never drawn over', async () => {
    const h = harness(BASE());
    await h.tap(OPEN_SUBSCRIPTIONS);
    expect(h.ui.edit).not.toHaveBeenCalled();
    const [text, kb] = h.ui.send.mock.calls[0] as unknown as [string, any];
    expect(text).toContain('💳 *Subscriptions* · $11.99/mo');
    expect(datas(kb)).toEqual([`cz:sb:d:${H('SPOTIFY')}`, 'cz:sb:mb', 'cz:ak:go:sub-add']);
    expect(texts(kb)).toEqual(['SPOTIFY', '❓ 1 maybe', '➕ Add']);
  });

  it('a row opens its detail: last charges, reminder choices, rename, hide, back', async () => {
    const h = harness(BASE());
    await h.tap(`cz:sb:d:${H('SPOTIFY')}`);
    const [text, kb] = h.ui.edit.mock.calls[0] as unknown as [string, any];
    expect(text).toBe([
      'SPOTIFY',
      '$11.99 a month · next Oct 15',
      'Last charges: Sep 15 $11.99',
      '🔔 Remind: off',
    ].join('\n'));
    expect(texts(kb)).toEqual(['1d', '3d', '7d', '✓ Off', '✏️ Rename', '🙈 Hide / I cancelled it', '‹ Back']);
    expect(datas(kb)).toContain(`cz:ak:go:sub-rename:${H('SPOTIFY')}`);
  });

  it('remind writes the document and marks the choice', async () => {
    const h = harness(BASE());
    await h.tap(`cz:sb:r3:${H('SPOTIFY')}`);
    expect(h.stored().remind).toEqual({ SPOTIFY: 3 });
    expect(texts((h.ui.edit.mock.calls[0] as unknown as [string, any])[1])).toContain('✓ 3d');
    expect(h.ui.answer).toHaveBeenCalledWith('Reminder: 3 days before');
    await h.tap(`cz:sb:r0:${H('SPOTIFY')}`);
    expect(h.stored().remind).toEqual({});
    expect(h.ui.answer).toHaveBeenLastCalledWith('Reminder off');
  });

  it('hide is instant, mirrored for older readers, and Undo puts it back', async () => {
    const h = harness(BASE());
    await h.tap(`cz:sb:h:${H('SPOTIFY')}`);
    expect(h.stored().hidden).toEqual(['SPOTIFY']);
    expect(h.secrets.get('hidden_subscriptions')).toBe('["SPOTIFY"]');
    const [text, kb] = h.ui.edit.mock.calls[0] as unknown as [string, any];
    expect(text).toBe("🙈 Hid SPOTIFY. It's out of every total and report — Undo puts it back.");
    expect(datas(kb)).toEqual([`cz:sb:uh:${H('SPOTIFY')}`, 'cz:sb:l:0']);
    await h.tap(`cz:sb:uh:${H('SPOTIFY')}`);
    expect(h.stored().hidden).toEqual([]);
    expect(h.ui.answer).toHaveBeenLastCalledWith('Undone');
  });

  it('a maybe answered Yes counts from then on; Undo takes it back', async () => {
    const h = harness(BASE());
    await h.tap('cz:sb:mb');
    const [question, qkb] = h.ui.edit.mock.calls[0] as unknown as [string, any];
    expect(question).toBe('❓ Is MYSTERY BOX a subscription?\n$15 a month · last charged Sep 15');
    expect(texts(qkb)).toEqual(["✅ Yes, it's a subscription", '🙈 No', '‹ Back']);
    await h.tap(`cz:sb:c:${H('MYSTERY BOX')}`);
    expect(h.stored().confirmed).toEqual(['MYSTERY BOX']);
    expect((h.ui.edit.mock.calls[1] as unknown as [string])[0]).toBe('✅ MYSTERY BOX now counts as a subscription.');
    await h.tap(`cz:sb:uc:${H('MYSTERY BOX')}`);
    expect(h.stored().confirmed).toEqual([]);
  });

  it('No on a maybe hides it; the Hidden screen restores it', async () => {
    const h = harness(BASE());
    await h.tap(`cz:sb:hm:${H('MYSTERY BOX')}`);
    expect(h.stored().hidden).toEqual(['MYSTERY BOX']);
    await h.tap('cz:sb:hd');
    expect(texts((h.ui.edit.mock.calls[1] as unknown as [string, any])[1])).toEqual(['↩ MYSTERY BOX', '‹ Back']);
    await h.tap(`cz:sb:u:${H('MYSTERY BOX')}`);
    expect(h.stored().hidden).toEqual([]);
    expect(h.ui.answer).toHaveBeenLastCalledWith('Restored MYSTERY BOX');
  });

  it('a hand-added entry is deleted, not hidden, and Undo restores it', async () => {
    const h = harness({ ...BASE(), subscription_prefs: doc({ manual: [HULU] }) });
    await h.tap(`cz:sb:d:${H('m:hulu0001')}`);
    const detail = texts((h.ui.edit.mock.calls[0] as unknown as [string, any])[1]);
    expect(detail).toContain('🗑 Delete');
    expect(detail).not.toContain('🙈 Hide / I cancelled it');
    await h.tap(`cz:sb:x:${H('m:hulu0001')}`);
    expect(h.stored().manual).toEqual([]);
    expect(h.stored().deleted).toEqual([{ ...HULU, deletedAt: NOW.toISOString() }]);
    await h.tap(`cz:sb:ux:${H('m:hulu0001')}`);
    expect(h.stored().manual).toEqual([HULU]);
  });

  it('Undo on a rename puts the old name back', async () => {
    const h = harness({ ...BASE(), subscription_prefs: doc({ names: { SPOTIFY: 'Spotify' }, prevNames: { SPOTIFY: null } }) });
    await h.tap(`cz:sb:un:${H('SPOTIFY')}`);
    expect(h.stored()).toMatchObject({ names: {}, prevNames: {} });
    expect(h.ui.answer).toHaveBeenLastCalledWith('Undone');
  });

  it('asks about a link suggestion above the list; Yes links, No sticks', async () => {
    const entries = {
      report_cube: cubeJson([det('SPOTIFY')], { subscriptionLinks: [{ manualId: 'hulu0001', merchant: 'HULU', date: '2026-09-19', cents: 999 }] }),
      subscription_prefs: doc({ manual: [HULU] }),
    };
    const yes = harness(entries);
    await yes.tap(OPEN_SUBSCRIPTIONS);
    const [text, kb] = yes.ui.send.mock.calls[0] as unknown as [string, any];
    expect(text.split('\n')[0]).toBe('Is HULU your Hulu? ($9.99 on Sep 19)');
    expect(datas(kb).slice(0, 2)).toEqual([`cz:sb:ly:${H('m:hulu0001')}`, `cz:sb:ln:${H('m:hulu0001')}`]);
    await yes.tap(`cz:sb:ly:${H('m:hulu0001')}`);
    expect(yes.stored().manual).toEqual([{ ...HULU, merchant: 'HULU', nextDate: '2026-10-19' }]);
    expect(yes.ui.answer).toHaveBeenLastCalledWith('Linked to Hulu');
    const no = harness(entries);
    await no.tap(`cz:sb:ln:${H('m:hulu0001')}`);
    expect(no.stored().declinedLinks).toEqual(['hulu0001|HULU']);
  });

  it('pages a long list', async () => {
    const h = harness({ report_cube: cubeJson(Array.from({ length: 12 }, (_, i) => det(`SUB ${String(i).padStart(2, '0')}`, { monthlyCents: 1000 + i }))) });
    await h.tap(OPEN_SUBSCRIPTIONS);
    expect(datas((h.ui.send.mock.calls[0] as unknown as [string, any])[1])).toContain('cz:sb:l:1');
    await h.tap('cz:sb:l:1');
    expect((h.ui.edit.mock.calls[0] as unknown as [string])[0]).toContain('_Page 2 of 2_');
  });

  it('a report Hide button hides and answers in a NEW message', async () => {
    const h = harness({ report_cube: cubeJson([det('NETFLIX', { lastDate: '2026-09-03' })]) });
    await h.tap(`cz:sb:hr:${H('NETFLIX')}`);
    expect(h.stored().hidden).toEqual(['NETFLIX']);
    expect(h.ui.edit).not.toHaveBeenCalled();
    expect((h.ui.send.mock.calls[0] as unknown as [string])[0]).toContain('🙈 Hid NETFLIX.');
  });

  // Review Focus: a report button tapped after the entry already left.
  it('a report button for an entry hidden since: "already sorted", the list as a NEW message, no write', async () => {
    const h = harness({
      report_cube: cubeJson([det('SPOTIFY'), det('NETFLIX', { lastDate: '2026-09-03' })]),
      subscription_prefs: doc({ hidden: ['NETFLIX'] }),
    });
    await h.tap(`cz:sb:hr:${H('NETFLIX')}`);
    expect(h.ui.answer).toHaveBeenCalledWith(SUBSCRIPTIONS_GONE_ANSWER);
    expect(h.ui.edit).not.toHaveBeenCalled();
    expect((h.ui.send.mock.calls[0] as unknown as [string])[0]).toContain('💳 *Subscriptions*');
    expect(h.set).not.toHaveBeenCalled();
  });

  // Review Focus: a corrupt document when a button is tapped.
  it('a corrupt document: the tap is refused, the stored text untouched, the list still honours the old hides', async () => {
    const h = harness({ ...BASE(), subscription_prefs: '{"v":1,"hidden":', hidden_subscriptions: '["MYSTERY BOX"]' });
    await h.tap(`cz:sb:h:${H('SPOTIFY')}`);
    expect(h.ui.answer).toHaveBeenCalledWith(SUBSCRIPTIONS_UNREADABLE_REPLY);
    expect(h.set).not.toHaveBeenCalled();
    expect(h.secrets.get('subscription_prefs')).toBe('{"v":1,"hidden":');
    await h.tap(OPEN_SUBSCRIPTIONS);
    const [text, kb] = h.ui.send.mock.calls[0] as unknown as [string, any];
    expect(text.split('\n')[0]).toContain("Couldn't read your subscription settings");
    expect(texts(kb)).toContain('🙈 1 hidden');
    expect(texts(kb)).not.toContain('❓ 1 maybe');
  });

  it('Wealthfolio unreachable: one answer, nothing sent or written', async () => {
    const h = harness(BASE());
    h.get.mockRejectedValue(new Error('ECONNREFUSED'));
    await h.tap(`cz:sb:h:${H('SPOTIFY')}`);
    expect(h.ui.answer).toHaveBeenCalledWith(SUBSCRIPTIONS_UNREACHABLE_REPLY);
    expect(h.ui.send).not.toHaveBeenCalled();
    expect(h.set).not.toHaveBeenCalled();
  });

  it('bank names are escaped and never bold', () => {
    const screen = renderSubscriptionDetail({
      key: 'SQ *COFFEE_CLUB', displayName: 'SQ *COFFEE_CLUB', group: 'subscription', source: 'detected',
      cents: 900, cadence: 'monthly', nextDate: '2026-10-15', recent: [], handle: H('SQ *COFFEE_CLUB'),
    });
    expect(screen.text.split('\n')[0]).toBe('SQ \\*COFFEE\\_CLUB');
  });

  it('ignores data it does not know', async () => {
    const h = harness(BASE());
    await h.tap('cz:sb:zz:nothex!');
    expect(h.ui.answer).toHaveBeenCalledWith();
    expect(h.ui.edit).not.toHaveBeenCalled();
  });
});
```

In `shared/telegram-commands.test.ts`, change the test `'keeps the other five working, listed under "More commands" in /help'` to:

```ts
  it('keeps the other six working, listed under "More commands" in /help', () => {
    expect(TELEGRAM_MORE_COMMANDS.map((c) => c.command))
      .toEqual(['afford', 'pool', 'recategorize', 'newrule', 'dismissed', 'subscriptions']);
    const help = formatHelpReply();
    const more = help.indexOf('*More commands*');
    expect(more).toBeGreaterThan(help.indexOf('/help'));
    for (const { command } of TELEGRAM_MORE_COMMANDS) {
      expect(help.indexOf(`/${command} `)).toBeGreaterThan(more);
    }
    // The optional query is invisible without an example.
    expect(help).toContain('/recategorize venmo');
  });
```

In `companion/src/index.test.ts`, add `import { findingHandle } from '../../shared/findings.js';` to the imports, and inside `describe('buildTelegramCommandHandler', …)` (it defines `clientFor` and `collector`), add:

```ts
  describe('/subscriptions (1.60)', () => {
    const cube = JSON.stringify({
      version: 1, asOf: '2026-10-12T06:00:00.000Z', months: ['2026-10'], categories: [], accounts: [],
      spend: [[]], uncategorized: [[]], income: [[]], budgets: [[]], merchants: [[]], feesInterest: [0],
      netWorth: [null], liquid: [null], pool: null,
      subscriptions: [{
        name: 'SPOTIFY', monthlyCents: 1199, count: 5, lastDate: '2026-09-15', lastCents: 1199, prevCents: 1199,
        creep: false, kind: 'subscription', recent: [{ date: '2026-09-15', cents: 1199 }],
      }],
    });

    it('replies with the list and one button per row', async () => {
      const { client } = clientFor([['report_cube', cube]]);
      const sent: Array<[string, any]> = [];
      await buildTelegramCommandHandler(client)({ command: 'subscriptions', args: '' }, async (t, k) => { sent.push([t, k]); });
      expect(sent[0][0]).toContain('💳 *Subscriptions* · $11.99/mo');
      expect(sent[0][1].inline_keyboard.flat().map((b: any) => b.callback_data)).toContain(`cz:sb:d:${findingHandle('SPOTIFY')}`);
    });

    it("says so when Wealthfolio can't be reached", async () => {
      const client = { getAddonSecret: vi.fn(async () => { throw new Error('ECONNREFUSED'); }), setAddonSecret: vi.fn() } as any;
      const { sent, reply } = collector();
      await buildTelegramCommandHandler(client)({ command: 'subscriptions', args: '' }, reply);
      expect(sent).toEqual(["Couldn't reach Wealthfolio — try again."]);
    });

    it('cz:sb: taps reach the subscriptions menu, not the transaction menu', async () => {
      const { client } = clientFor([['report_cube', cube]]);
      const deps = buildTelegramListenerDeps(client);
      const ui = { edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) };
      await deps.onMenuCallback!({ data: 'cz:sb:o', chatId: 1, messageId: 2 }, ui);
      expect((ui.send.mock.calls[0] as unknown as [string])[0]).toContain('💳 *Subscriptions*');
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix companion test -- src/subscriptions-menu.test.ts`
Expected: FAIL — `Failed to load url ./subscriptions-menu.js`.

Run: `npx vitest run shared/telegram-commands.test.ts`
Expected: FAIL — `subscriptions` missing from the list.

Run: `npm --prefix companion test -- src/index.test.ts -t "/subscriptions"`
Expected: FAIL — `/subscriptions` answers with the help text ("Unknown command").

- [ ] **Step 3: Implement the menu**

Create `companion/src/subscriptions-menu.ts`:

```ts
/**
 * companion/src/subscriptions-menu.ts
 *
 * `/subscriptions` and every button that leads into it: the list, one screen
 * per entry, the maybes, the hidden ones, and the writes — remind, hide,
 * confirm, delete, link — with ↩ Undo.
 *
 * STATELESS, like findings-menu.ts. Every tap re-reads the roster and finds
 * the tapped entry by the hash of its key, so a button from Monday's report
 * still works after a restart, and one whose entry has gone answers "That one
 * is already sorted" instead of acting on a stale snapshot.
 *
 * Writes go through `deps.edit` — `editSubscriptionPrefs` in production:
 * re-read, one pure edit, write, mirror the legacy lists. Instant, no confirm
 * screen; the screen after a write carries ↩ Undo.
 *
 * Names are escaped and never put inside bold: legacy Markdown ignores an
 * escape inside an entity, and a bank's `*` would cost the whole message.
 */
import { askStartData } from '../../shared/ask-flow.js';
import { MENU_CALLBACK_PREFIX } from '../../shared/categorize-menu.js';
import { findingHandle } from '../../shared/findings.js';
import {
  acceptLink, confirmKey, declineLink, deleteManual, hideKey, isUnreadablePrefsError, restoreDeleted, setRemind,
  unconfirmKey, undoRename, unhideKey, type RemindDays, type SubscriptionEdit, type SubscriptionPrefs,
} from '../../shared/subscription-prefs.js';
import {
  manualKey, rosterAmount, rosterMoney, rosterWhen, type Roster, type RosterEntry,
} from '../../shared/subscription-roster.js';
import {
  escapeMarkdown, formatSubscriptionList, shortDate, subscriptionListPage, type InlineKeyboard,
} from '../../shared/telegram.js';
import type { RosterRead } from './subscription-data.js';

export const SUBSCRIPTIONS_CALLBACK_PREFIX = `${MENU_CALLBACK_PREFIX}sb:`;
/** From a report: the list as a NEW message — editing would draw it over the
 *  report, the only copy of the morning's numbers in the chat. */
export const OPEN_SUBSCRIPTIONS = `${SUBSCRIPTIONS_CALLBACK_PREFIX}o`;
const LIST = `${SUBSCRIPTIONS_CALLBACK_PREFIX}l:`;
const MAYBES = `${SUBSCRIPTIONS_CALLBACK_PREFIX}mb`;
const HIDDEN = `${SUBSCRIPTIONS_CALLBACK_PREFIX}hd`;
const ACTION = /^([a-z]{1,2}|r[0137]):([0-9a-f]{8})$/;
const act = (action: string, handle: string) => `${SUBSCRIPTIONS_CALLBACK_PREFIX}${action}:${handle}`;

type Button = { text: string; callback_data: string };
export interface MenuScreen { text: string; keyboard: InlineKeyboard }

export const SUBSCRIPTIONS_BUTTON: Button = { text: '💳 Subscriptions', callback_data: OPEN_SUBSCRIPTIONS };
export const SEE_ALL_SUBSCRIPTIONS_BUTTON: Button = { text: 'See all', callback_data: OPEN_SUBSCRIPTIONS };
export const SUBSCRIPTIONS_GONE_ANSWER = 'That one is already sorted — refreshing.';
export const SUBSCRIPTIONS_UNREACHABLE_REPLY = "Couldn't reach Wealthfolio — try again.";
export const SUBSCRIPTIONS_UNREADABLE_REPLY = "Couldn't read your subscription settings — nothing was changed.";
export const SUBSCRIPTIONS_RENAME_GONE_REPLY = 'That one is gone now — send /subscriptions for the current list.';
const FAILED_ANSWER = 'Could not do that — check the companion logs.';

const BACK_TO_LIST: Button = { text: '‹ Subscriptions', callback_data: `${LIST}0` };
const BACK: Button = { text: '‹ Back', callback_data: `${LIST}0` };
/** Button labels are plain text (never parsed as Markdown), only shortened. */
const label = (name: string, max = 28) => (name.length > max ? `${name.slice(0, max - 1)}…` : name);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface SubscriptionsMenuUi {
  edit(text: string, keyboard?: InlineKeyboard): Promise<void>;
  answer(text?: string): Promise<void>;
  send(text: string, keyboard?: InlineKeyboard): Promise<void>;
}

export interface SubscriptionsMenuDeps {
  /** Re-read on every tap. Rejects when Wealthfolio cannot be reached. */
  read(now: Date): Promise<RosterRead>;
  /** editSubscriptionPrefs; rejects with SubscriptionPrefsUnreadableError on a corrupt document. */
  edit(edit: SubscriptionEdit, now: Date): Promise<SubscriptionPrefs>;
  now(): Date;
  log(msg: string): void;
}

export interface SubscriptionsMenu {
  handles(data: string): boolean;
  onCallback(cb: { data: string; chatId: number }, ui: SubscriptionsMenuUi): Promise<void>;
}

/** Under a "cancelled?" line in a report. */
export function hideFromReportButton(e: RosterEntry): Button {
  return { text: `🙈 Hide ${label(e.displayName, 24)}`, callback_data: act('hr', e.handle) };
}

/** Under the "Renamed …" message the rename question ends on. */
export function undoRenameButton(handle: string): Button {
  return { text: '↩ Undo', callback_data: act('un', handle) };
}

export function findRosterEntry(roster: Roster, handle: string): RosterEntry | undefined {
  return [...roster.subscriptions, ...roster.bills, ...roster.maybes, ...roster.hidden].find((e) => e.handle === handle);
}

export function renderSubscriptionList(read: RosterRead, page: number): MenuScreen {
  const { roster } = read;
  const { entries, page: p, pages } = subscriptionListPage(roster, page);
  const rows: Button[][] = [];
  const link = roster.linkSuggestions[0];
  if (link) {
    const h = findingHandle(manualKey(link.manualId));
    rows.push([{ text: 'Yes', callback_data: act('ly', h) }, { text: 'No', callback_data: act('ln', h) }]);
  }
  for (const e of entries) rows.push([{ text: label(e.displayName), callback_data: act('d', e.handle) }]);
  if (pages > 1) {
    const nav: Button[] = [];
    if (p > 0) nav.push({ text: '‹ Prev', callback_data: `${LIST}${p - 1}` });
    if (p < pages - 1) nav.push({ text: 'Next ›', callback_data: `${LIST}${p + 1}` });
    rows.push(nav);
  }
  const footer: Button[] = [];
  const maybes = roster.maybes.length;
  if (maybes > 0) footer.push({ text: `❓ ${maybes} ${maybes === 1 ? 'maybe' : 'maybes'}`, callback_data: MAYBES });
  if (roster.hidden.length > 0) footer.push({ text: `🙈 ${roster.hidden.length} hidden`, callback_data: HIDDEN });
  footer.push({ text: '➕ Add', callback_data: askStartData('sub-add') });
  rows.push(footer);
  return { text: formatSubscriptionList(roster, p, { unreadable: read.unreadable }), keyboard: { inline_keyboard: rows } };
}

export function renderSubscriptionDetail(e: RosterEntry): MenuScreen {
  const name = escapeMarkdown(e.displayName);
  const amount = rosterAmount(e);
  const lines = [e.bankName ? `${name} — on your statement as ${escapeMarkdown(e.bankName)}` : name];
  lines.push(`${amount}${e.cadence === 'monthly' && amount !== 'no price yet' ? ' a month' : ''} · ${rosterWhen(e)}`);
  if (e.recent.length > 0) {
    lines.push(`Last charges: ${e.recent.map((r) => `${shortDate(r.date)} ${rosterMoney(r.cents)}`).join(' · ')}`);
  } else if (e.source === 'manual') {
    lines.push('No charge matched to it yet.');
  }
  if (e.creep) lines.push(`⬆ Up from ${rosterMoney(e.creep.fromCents)} to ${rosterMoney(e.creep.toCents)} on ${shortDate(e.creep.chargedOn)}.`);
  if (e.source === 'manual') lines.push('✍️ Added by you.');
  if (e.source === 'watched') lines.push('👀 Watching — you said this one recurs.');
  lines.push(`🔔 Remind: ${e.remind ? `${e.remind} ${e.remind === 1 ? 'day' : 'days'} before` : 'off'}`);
  const current = e.remind ?? 0;
  const remindRow = ([1, 3, 7, 0] as const).map((n) => ({
    text: `${current === n ? '✓ ' : ''}${n === 0 ? 'Off' : `${n}d`}`,
    callback_data: act(`r${n}`, e.handle),
  }));
  return {
    text: lines.join('\n'),
    keyboard: {
      inline_keyboard: [
        remindRow,
        [{ text: '✏️ Rename', callback_data: askStartData('sub-rename', e.handle) }],
        [e.source === 'manual'
          ? { text: '🗑 Delete', callback_data: act('x', e.handle) }
          : { text: '🙈 Hide / I cancelled it', callback_data: act('h', e.handle) }],
        [BACK],
      ],
    },
  };
}

/** One maybe at a time, so each Yes/No pair has one subject. */
export function renderMaybe(roster: Roster): MenuScreen {
  const m = roster.maybes[0];
  if (!m) return { text: 'No maybes left — everything recurring is sorted.', keyboard: { inline_keyboard: [[BACK_TO_LIST]] } };
  const last = m.recent[0];
  const more = roster.maybes.length - 1;
  const lines = [
    `❓ Is ${escapeMarkdown(m.displayName)} a subscription?`,
    `${rosterAmount(m)} a month${last ? ` · last charged ${shortDate(last.date)}` : ''}`,
    ...(more > 0 ? [`_${more} more after this one._`] : []),
  ];
  return {
    text: lines.join('\n'),
    keyboard: {
      inline_keyboard: [
        [{ text: "✅ Yes, it's a subscription", callback_data: act('c', m.handle) }, { text: '🙈 No', callback_data: act('hm', m.handle) }],
        [BACK],
      ],
    },
  };
}

export function renderHidden(roster: Roster): MenuScreen {
  if (roster.hidden.length === 0) return { text: '🙈 Nothing is hidden.', keyboard: { inline_keyboard: [[BACK_TO_LIST]] } };
  const shown = roster.hidden.slice(0, 10);
  const lines = ['🙈 *Hidden* — tap one to put it back.', ...shown.map((e) => `${escapeMarkdown(e.displayName)} — ${rosterAmount(e)}`)];
  if (roster.hidden.length > shown.length) lines.push(`_${roster.hidden.length - shown.length} more — see the Subscriptions card in the app._`);
  return {
    text: lines.join('\n'),
    keyboard: { inline_keyboard: [...shown.map((e) => [{ text: `↩ ${label(e.displayName)}`, callback_data: act('u', e.handle) }]), [BACK]] },
  };
}

function doneScreen(text: string, undo: Button, extra: Button[] = []): MenuScreen {
  return { text, keyboard: { inline_keyboard: [[undo], [...extra, BACK_TO_LIST]] } };
}

export function createSubscriptionsMenu(deps: SubscriptionsMenuDeps): SubscriptionsMenu {
  return {
    handles(data) {
      return data.startsWith(SUBSCRIPTIONS_CALLBACK_PREFIX);
    },

    async onCallback(cb, ui) {
      try {
        const now = deps.now();
        let read: RosterRead;
        try {
          read = await deps.read(now);
        } catch (err) {
          deps.log(`Subscriptions menu: reading failed: ${message(err)}`);
          return void await ui.answer(SUBSCRIPTIONS_UNREACHABLE_REPLY);
        }
        const show = async (screen: MenuScreen, mode: 'edit' | 'send', toast?: string) => {
          if (mode === 'send') await ui.send(screen.text, screen.keyboard);
          else await ui.edit(screen.text, screen.keyboard);
          await ui.answer(toast);
        };
        const write = async (edit: SubscriptionEdit): Promise<boolean> => {
          try {
            await deps.edit(edit, now);
            return true;
          } catch (err) {
            if (isUnreadablePrefsError(err)) {
              await ui.answer(SUBSCRIPTIONS_UNREADABLE_REPLY);
            } else {
              deps.log(`Subscriptions menu: ${cb.data} write failed: ${message(err)}`);
              await ui.answer(SUBSCRIPTIONS_UNREACHABLE_REPLY);
            }
            return false;
          }
        };
        const freshList = async () => renderSubscriptionList(await deps.read(now), 0);

        if (cb.data === OPEN_SUBSCRIPTIONS) return void await show(renderSubscriptionList(read, 0), 'send');
        if (cb.data.startsWith(LIST)) return void await show(renderSubscriptionList(read, Number(cb.data.slice(LIST.length)) || 0), 'edit');
        if (cb.data === MAYBES) return void await show(renderMaybe(read.roster), 'edit');
        if (cb.data === HIDDEN) return void await show(renderHidden(read.roster), 'edit');

        const m = cb.data.slice(SUBSCRIPTIONS_CALLBACK_PREFIX.length).match(ACTION);
        if (!m) return void await ui.answer();
        const [, action, handle] = m;
        // A report's button: whatever it shows goes out as a NEW message.
        const mode = action === 'hr' ? 'send' : 'edit';
        const gone = () => show(renderSubscriptionList(read, 0), mode, SUBSCRIPTIONS_GONE_ANSWER);
        const { roster, prefs } = read;
        const active = [...roster.subscriptions, ...roster.bills].find((e) => e.handle === handle);
        const anywhere = findRosterEntry(roster, handle);

        switch (action) {
          case 'd':
            return void await (active ? show(renderSubscriptionDetail(active), 'edit') : gone());
          case 'r0': case 'r1': case 'r3': case 'r7': {
            if (!active) return void await gone();
            const days = Number(action.slice(1)) as 0 | RemindDays;
            if (!(await write((p) => setRemind(p, active.key, days === 0 ? null : days)))) return;
            const fresh = findRosterEntry((await deps.read(now)).roster, handle) ?? active;
            return void await show(renderSubscriptionDetail(fresh), 'edit',
              days === 0 ? 'Reminder off' : `Reminder: ${days} ${days === 1 ? 'day' : 'days'} before`);
          }
          case 'h': case 'hr': {
            if (!active || active.source === 'manual') return void await gone();
            if (!(await write((p) => hideKey(p, active.key)))) return;
            return void await show(doneScreen(
              `🙈 Hid ${escapeMarkdown(active.displayName)}. It's out of every total and report — Undo puts it back.`,
              { text: '↩ Undo', callback_data: act('uh', handle) },
            ), mode);
          }
          case 'c': case 'hm': {
            const maybe = roster.maybes.find((e) => e.handle === handle);
            if (!maybe) return void await gone();
            const yes = action === 'c';
            if (!(await write((p) => (yes ? confirmKey(p, maybe.key) : hideKey(p, maybe.key))))) return;
            const name = escapeMarkdown(maybe.displayName);
            return void await show(doneScreen(
              yes ? `✅ ${name} now counts as a subscription.` : `🙈 Okay — ${name} isn't a subscription.`,
              { text: '↩ Undo', callback_data: act(yes ? 'uc' : 'uh', handle) },
              roster.maybes.length > 1 ? [{ text: 'Next maybe ›', callback_data: MAYBES }] : [],
            ), 'edit');
          }
          case 'x': {
            if (!active || active.source !== 'manual') return void await gone();
            const id = active.key.slice(2);
            if (!(await write((p) => deleteManual(p, id, now)))) return;
            return void await show(doneScreen(`🗑 Deleted ${escapeMarkdown(active.displayName)}.`, { text: '↩ Undo', callback_data: act('ux', handle) }), 'edit');
          }
          case 'u': case 'uh': {
            const entry = roster.hidden.find((e) => e.handle === handle);
            if (!entry) return void await gone();
            if (!(await write((p) => unhideKey(p, entry.key)))) return;
            if (action === 'u') return void await show(renderHidden((await deps.read(now)).roster), 'edit', `Restored ${entry.displayName}`);
            return void await show(await freshList(), 'edit', 'Undone');
          }
          case 'uc': {
            if (!anywhere || !prefs.confirmed.includes(anywhere.key)) return void await gone();
            if (!(await write((p) => unconfirmKey(p, anywhere.key)))) return;
            return void await show(await freshList(), 'edit', 'Undone');
          }
          case 'un': {
            if (!anywhere || !(anywhere.key in prefs.prevNames)) return void await gone();
            if (!(await write((p) => undoRename(p, anywhere.key)))) return;
            return void await show(await freshList(), 'edit', 'Undone');
          }
          case 'ux': {
            const deleted = prefs.deleted.find((d) => findingHandle(manualKey(d.id)) === handle);
            if (!deleted) return void await gone();
            if (!(await write((p) => restoreDeleted(p, deleted.id)))) return;
            return void await show(await freshList(), 'edit', 'Undone');
          }
          case 'ly': case 'ln': {
            const s = roster.linkSuggestions.find((l) => findingHandle(manualKey(l.manualId)) === handle);
            if (!s) return void await gone();
            const yes = action === 'ly';
            if (!(await write((p) => (yes ? acceptLink(p, s) : declineLink(p, s.manualId, s.merchant))))) return;
            return void await show(await freshList(), 'edit', yes ? `Linked to ${s.manualName}` : "Okay — I won't suggest that one again");
          }
          default:
            return void await ui.answer();
        }
      } catch (err) {
        deps.log(`Subscriptions menu: ${cb.data} failed: ${message(err)}`);
        await ui.answer(FAILED_ANSWER).catch(() => {});
      }
    },
  };
}
```

- [ ] **Step 4: Implement the command, the help line and the wiring**

In `shared/telegram-commands.ts`, append to `TELEGRAM_MORE_COMMANDS` (after the `dismissed` entry):

```ts
  { command: 'subscriptions', description: 'Subscriptions and bills — remind, rename, hide, or add one' },
```

and add one sentence to the comment above it: "`/subscriptions` (1.60) takes no arguments; everything happens on its buttons."

In `companion/src/index.ts`:

1. Imports:
```ts
import { readSubscriptionRoster, type RosterRead } from './subscription-data.js';
import {
  createSubscriptionsMenu, renderSubscriptionList, SUBSCRIPTIONS_UNREACHABLE_REPLY, type SubscriptionsMenu,
} from './subscriptions-menu.js';
```
and extend the Task 3 import from `../../shared/subscription-prefs.js` with `editSubscriptionPrefs`.

2. Below `subscriptionSecrets`:
```ts
/** The roster as every Telegram surface sees it: cube + document, with
 *  "today" in the companion's TZ. Rejects when Wealthfolio cannot be read. */
async function readRosterFor(wfClient: WealthfolioClient, now: Date): Promise<RosterRead> {
  return readSubscriptionRoster(subscriptionSecrets(wfClient).get, toDateString(now));
}
```

3. In `buildTelegramCommandHandler`'s switch, before `case 'status':`:
```ts
      case 'subscriptions': {
        // Caught here, unlike most commands: "Couldn't reach Wealthfolio" is
        // the answer the design promises, not the listener's generic apology.
        let read: RosterRead;
        try {
          read = await readRosterFor(wfClient, new Date());
        } catch (err) {
          log(`/subscriptions: reading failed: ${formatError(err)}`);
          await reply(SUBSCRIPTIONS_UNREACHABLE_REPLY);
          return;
        }
        const screen = renderSubscriptionList(read, 0);
        await reply(screen.text, screen.keyboard);
        return;
      }
```

4. In `buildTelegramListenerDeps`, after the `const findings: FindingsMenu = createFindingsMenu({ … });` statement:
```ts
  // `/subscriptions` and the report buttons into it. Stateless like the
  // findings menu: every tap re-reads, so it survives restarts.
  const subscriptions: SubscriptionsMenu = createSubscriptionsMenu({
    read: (now) => readRosterFor(wfClient, now),
    edit: (edit, now) => {
      const { get, set } = subscriptionSecrets(wfClient);
      return editSubscriptionPrefs(get, set, edit, now);
    },
    now: () => new Date(),
    log,
  });
```

5. In `onMenuCallback`, directly after the `if (findings.handles(cb.data)) { … return; }` block:
```ts
      // `cz:sb:` before the transaction menu, which reads any `cz:` data it
      // does not know as an expired session.
      if (subscriptions.handles(cb.data)) {
        await subscriptions.onCallback(cb, ui);
        return;
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm --prefix companion test -- src/subscriptions-menu.test.ts`
Expected: PASS.

Run: `npx vitest run shared/telegram-commands.test.ts`
Expected: PASS (the `More commands wording (1.60)` test still passes: `subscriptions` is not one of the three it checks).

Run: `npm --prefix companion test`
Expected: PASS (whole companion suite).

Run: `npm --prefix companion run build && npm run type-check`
Expected: both succeed.

- [ ] **Step 6: Commit**

```bash
git add companion/src/subscriptions-menu.ts companion/src/subscriptions-menu.test.ts shared/telegram-commands.ts shared/telegram-commands.test.ts companion/src/index.ts companion/src/index.test.ts
git commit -m "Bot: /subscriptions — stateless list, detail, maybes, hidden, writes with Undo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 7: Add and rename by answering questions

**Files:**
- Modify: `shared/telegram-commands.ts` (below `nextOccurrence` ~line 677; one import at the top)
- Test: `shared/telegram-commands.test.ts`
- Modify: `shared/ask-flow.ts` (`askStartData` ~line 166)
- Test: `shared/ask-flow.test.ts`
- Modify: `companion/src/ask-flows.ts`
- Test: `companion/src/ask-flows.test.ts`
- Modify: `companion/src/index.ts` (imports; `writeSubscriptionPrefs` above `buildAskSessions` ~line 2806; two `asks.register` calls before `return asks;`)
- Test: `companion/src/index.test.ts` (inside `describe('buildTelegramCommandHandler', …)`)

**Interfaces:**
- Consumes: Task 1 (`addManual`, `setRemind`, `renameKey`, `newManualId`, `loadSubscriptionPrefs`, `editSubscriptionPrefs`, `isUnreadablePrefsError`, `ManualSubscription`, `RemindDays`, `SubscriptionEdit`, `rollForward`, `localIsoDay`, `manualKey`, `Cadence`), Task 2 (`rosterMoney`), Task 3 (`subscriptionSecrets`), Task 6 (`readRosterFor`, `findRosterEntry`, `undoRenameButton`, `SUBSCRIPTIONS_BUTTON`, `SUBSCRIPTIONS_UNREACHABLE_REPLY`, `SUBSCRIPTIONS_UNREADABLE_REPLY`, `SUBSCRIPTIONS_RENAME_GONE_REPLY`); existing `parseDateInput`, `parseAmountCents`, R1's ask engine and `buildAskSessions`.
- Produces:
  - `shared/telegram-commands.ts`:
    ```ts
    export const SUB_NAME_HINT = 'Type a name, up to 40 characters.';
    export const SUB_AMOUNT_HINT = "Couldn't read that as an amount — try 9.99.";
    export const SUB_DATE_HINT = "Couldn't read that date — try Oct 20 or 2026-10-20.";
    export function parseSubscriptionName(text: string): string | null;   // trimmed, inner spaces collapsed, 1–40 chars
    export function parseSubscriptionDate(text: string, now: Date, cadence: Cadence, today: string): string | null;
    ```
    `parseSubscriptionDate` reads with `parseDateInput`, lands a month-day "Feb 29" that does not exist this year on Feb 28 (R2-4), and rolls any past date forward by the cadence (`rollForward`). The app's add form (Task 13) uses the same two parsers and three hints.
  - `askStartData` throws `Error` when the data would exceed 64 bytes.
  - `companion/src/ask-flows.ts`: `export const SUB_REMIND_OPTIONS: AskOption[]` (`1d`→1, `3d`→3, `7d`→7, `No`→null); `export function buildSubAddFlow(now: Date): AskFlow` (id `sub-add`, command `subscriptions`, title `New subscription`; answers `{ name: string, amount: number /*cents*/, cadence: Cadence, nextDate: string, remind: RemindDays | null }`); `export function buildSubRenameFlow(currentName: string): AskFlow` (id `sub-rename`, command `subscriptions`, title `Rename`; answers `{ name: string }`).
  - In `index.ts` (module-private): `async function writeSubscriptionPrefs(wfClient: WealthfolioClient, edit: SubscriptionEdit): Promise<'ok' | 'unreadable' | 'unreachable'>`; flows `sub-add` and `sub-rename` registered (`sub-rename`'s arg is the entry handle).

- [ ] **Step 1: Write the failing tests**

Add to `shared/telegram-commands.test.ts` (extend the import list with `parseSubscriptionDate, parseSubscriptionName`):

```ts
describe('subscription answers (1.60)', () => {
  const now = new Date('2026-10-12T15:00:00Z');
  const today = '2026-10-12';

  it('reads a name: trimmed, inner spaces collapsed, 1–40 characters', () => {
    expect(parseSubscriptionName('  Hulu   Plus ')).toBe('Hulu Plus');
    expect(parseSubscriptionName('   ')).toBeNull();
    expect(parseSubscriptionName('x'.repeat(41))).toBeNull();
  });

  it.each([
    ['Oct 20', 'monthly', '2026-10-20'],
    ['Oct 3', 'monthly', '2026-11-03'],
    ['Oct 3', 'yearly', '2027-10-03'],
    ['2025-03-03', 'yearly', '2027-03-03'],
    ['Jan 31', 'monthly', '2026-10-31'],
    ['today', 'monthly', '2026-10-12'],
  ] as const)('%s (%s) means %s — a past date rolls forward', (input, cadence, want) => {
    expect(parseSubscriptionDate(input, now, cadence, today)).toBe(want);
  });

  // R2-4: Feb 29 typed in a year without one.
  it.each([
    ['Feb 29', 'yearly', '2027-02-28'],
    ['february 29th', 'monthly', '2026-10-28'],
  ] as const)('%s (%s) lands on %s', (input, cadence, want) => {
    expect(parseSubscriptionDate(input, now, cadence, today)).toBe(want);
  });

  it.each(['', 'soon', 'Feb 30', '2026-02-29'])('refuses %j', (input) => {
    expect(parseSubscriptionDate(input, now, 'monthly', today)).toBeNull();
  });
});
```

Add to `shared/ask-flow.test.ts`:

```ts
describe('askStartData size guard (1.60)', () => {
  it("refuses data over Telegram's 64-byte limit instead of minting a dead button", () => {
    expect(askStartData('sub-rename', 'a1b2c3d4')).toBe('cz:ak:go:sub-rename:a1b2c3d4');
    expect(() => askStartData('sub-rename', 'x'.repeat(60))).toThrow(/64 bytes/);
  });
});
```

Add to `companion/src/ask-flows.test.ts` (extend the `./ask-flows.js` import with `buildSubAddFlow, buildSubRenameFlow`):

```ts
describe('sub-add flow', () => {
  const NOW_LOCAL = new Date(2026, 9, 12, 9, 0, 0);
  const driveSub = (answers: string[]) => drive(buildSubAddFlow(NOW_LOCAL), answers);

  it('counts its five questions in the title', () => {
    expect(startAsk(buildSubAddFlow(NOW_LOCAL), 'k1').screen.text).toBe("*New subscription · 1 of 5*\nWhat's it called? (e.g. Hulu)");
  });

  it('asks name, amount, how often, next date, reminder — then a summary', () => {
    const out = driveSub(['Hulu', '9.99', 'Monthly', 'Oct 20', '3d']);
    if (out.kind !== 'screen') throw new Error(out.kind);
    expect(out.state.answers).toEqual({ name: 'Hulu', amount: 999, cadence: 'monthly', nextDate: '2026-10-20', remind: 3 });
    expect(out.screen.text).toBe('*New subscription*\nHulu — $9.99 a month, next charge *Oct 20*.\n🔔 Reminder 3 days before.');
  });

  it('rolls a past date forward by the cadence', () => {
    const monthly = driveSub(['Gym', '40', 'Monthly', 'Oct 3', 'No']);
    const yearly = driveSub(['Domain', '15', 'Yearly', 'Oct 3', 'No']);
    if (monthly.kind !== 'screen' || yearly.kind !== 'screen') throw new Error('not at the summary');
    expect(monthly.state.answers.nextDate).toBe('2026-11-03');
    expect(yearly.state.answers.nextDate).toBe('2027-10-03');
    expect(yearly.screen.text).toContain('No reminder.');
  });

  it('lands Feb 29 on Feb 28 in a year without one (R2-4)', () => {
    const out = driveSub(['Domain', '15', 'Yearly', 'Feb 29', 'No']);
    if (out.kind !== 'screen') throw new Error(out.kind);
    expect(out.state.answers.nextDate).toBe('2027-02-28');
  });

  it('re-asks an empty name, a bad amount and a bad date with the shared hints', () => {
    expect(driveSub(['   ']).kind).toBe('retry');
    const badAmount = driveSub(['Hulu', '9,99']);
    if (badAmount.kind !== 'retry') throw new Error(badAmount.kind);
    expect(badAmount.screen.text).toContain("Couldn't read that as an amount — try 9.99.");
    const badDate = driveSub(['Hulu', '9.99', 'Monthly', 'someday']);
    if (badDate.kind !== 'retry') throw new Error(badDate.kind);
    expect(badDate.screen.text).toContain("Couldn't read that date — try Oct 20 or 2026-10-20.");
  });

  it('escapes the name and keeps it out of bold', () => {
    const out = driveSub(['Max_Ultimate*', '20', 'Monthly', 'Oct 20', 'No']);
    if (out.kind !== 'screen') throw new Error(out.kind);
    expect(out.screen.text).toContain('\nMax\\_Ultimate\\* — $20 a month, next charge *Oct 20*.');
  });
});

describe('sub-rename flow', () => {
  it('asks once and re-asks an empty answer', () => {
    const flow = buildSubRenameFlow('SPOTIFY');
    const { state, screen } = startAsk(flow, 'k1');
    expect(screen.text).toBe('*Rename*\nNew name for SPOTIFY?');
    expect(answerText(flow, state, '   ').kind).toBe('retry');
    expect(answerText(flow, state, ' Spotify ')).toEqual({ kind: 'done', answers: { name: 'Spotify' } });
  });

  it('escapes the current name in the question', () => {
    expect(startAsk(buildSubRenameFlow('SQ *COFFEE_CLUB'), 'k1').screen.text).toBe('*Rename*\nNew name for SQ \\*COFFEE\\_CLUB?');
  });
});
```

Add to `companion/src/index.test.ts`, inside `describe('buildTelegramCommandHandler', …)`:

```ts
  describe('subscription questions (1.60)', () => {
    const SUB_CUBE = JSON.stringify({
      version: 1, asOf: '2026-10-12T06:00:00.000Z', months: ['2026-10'], categories: [], accounts: [],
      spend: [[]], uncategorized: [[]], income: [[]], budgets: [[]], merchants: [[]], feesInterest: [0],
      netWorth: [null], liquid: [null], pool: null,
      subscriptions: [{
        name: 'SPOTIFY', monthlyCents: 1199, count: 5, lastDate: '2026-09-15', lastCents: 1199, prevCents: 1199,
        creep: false, kind: 'subscription', recent: [{ date: '2026-09-15', cents: 1199 }],
      }],
    });
    const atMorning = async (fn: () => Promise<void>) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 9, 12, 9, 0, 0));
      try { await fn(); } finally { vi.useRealTimers(); }
    };

    it('adds a subscription through the questions, then offers the list', async () => {
      const { client, secrets } = clientFor([['report_cube', SUB_CUBE]]);
      await atMorning(async () => {
        const asks = buildAskSessions(client, buildCategorizeController(client));
        const sent: Array<[string, any]> = [];
        const send = async (t: string, k?: any) => { sent.push([t, k]); };
        await asks.start('sub-add', send);
        for (const answer of ['Hulu', '9.99', 'Monthly', 'Oct 20', '3d']) await asks.onText(answer, send);
        const save = sent[sent.length - 1][1].inline_keyboard.flat().find((b: any) => b.text === '✅ Save').callback_data;
        await asks.onCallback({ data: save }, { edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send });
        const doc = JSON.parse(secrets.get('subscription_prefs')!);
        expect(doc.manual).toEqual([{ id: expect.stringMatching(/^[0-9a-z]{8}$/), name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' }]);
        expect(doc.remind).toEqual({ [`m:${doc.manual[0].id}`]: 3 });
        expect(sent[sent.length - 1]).toEqual([
          '✍️ Added Hulu — $9.99 a month, next charge Oct 20.',
          { inline_keyboard: [[{ text: '💳 Subscriptions', callback_data: 'cz:sb:o' }]] },
        ]);
      });
    });

    it('renames from the detail button; the reply carries an Undo that puts the old name back', async () => {
      const { client, secrets } = clientFor([['report_cube', SUB_CUBE]]);
      await atMorning(async () => {
        const deps = buildTelegramListenerDeps(client);
        const sent: Array<[string, any]> = [];
        const reply = async (t: string, k?: any) => { sent.push([t, k]); };
        const ui = { edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: reply };
        await deps.onMenuCallback!({ data: `cz:ak:go:sub-rename:${findingHandle('SPOTIFY')}`, chatId: 1, messageId: 2 }, ui);
        expect(sent[0][0]).toBe('*Rename*\nNew name for SPOTIFY?');
        await deps.onText!('Spotify Premium', reply, { privateChat: true });
        expect(JSON.parse(secrets.get('subscription_prefs')!)).toMatchObject({ names: { SPOTIFY: 'Spotify Premium' }, prevNames: { SPOTIFY: null } });
        const [text, kb] = sent[sent.length - 1];
        expect(text).toBe('✏️ Renamed SPOTIFY to Spotify Premium.');
        const undo = kb.inline_keyboard.flat().find((b: any) => b.text === '↩ Undo').callback_data;
        expect(undo).toBe(`cz:sb:un:${findingHandle('SPOTIFY')}`);
        await deps.onMenuCallback!({ data: undo, chatId: 1, messageId: 3 }, ui);
        expect(JSON.parse(secrets.get('subscription_prefs')!).names).toEqual({});
      });
    });

    it('a rename button whose entry has gone says so instead of asking', async () => {
      const { client } = clientFor([['report_cube', SUB_CUBE]]);
      const deps = buildTelegramListenerDeps(client);
      const sent: string[] = [];
      const ui = { edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: async (t: string) => { sent.push(t); } };
      await deps.onMenuCallback!({ data: 'cz:ak:go:sub-rename:deadbeef', chatId: 1, messageId: 2 }, ui);
      expect(sent).toEqual(['That one is gone now — send /subscriptions for the current list.']);
    });

    it('a corrupt document stops the add before the first question', async () => {
      const { client } = clientFor([['subscription_prefs', '{"v":1,"hidden":']]);
      const asks = buildAskSessions(client, buildCategorizeController(client));
      const { sent, reply } = collector();
      await asks.start('sub-add', reply);
      expect(sent).toEqual(["Couldn't read your subscription settings — nothing was changed."]);
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run shared/telegram-commands.test.ts shared/ask-flow.test.ts`
Expected: FAIL — `parseSubscriptionDate is not a function`; `askStartData` does not throw.

Run: `npm --prefix companion test -- src/ask-flows.test.ts`
Expected: FAIL — `buildSubAddFlow is not a function`.

Run: `npm --prefix companion test -- src/index.test.ts -t "subscription questions"`
Expected: FAIL — `That button is no longer available.` (no such flow).

- [ ] **Step 3: Implement the parsers and the guard**

In `shared/telegram-commands.ts`, add to the imports:

```ts
import { rollForward, type Cadence } from './subscription-roster.js';
```

Below `nextOccurrence`, add:

```ts
/** Hints shared by the bot's add/rename questions and the app's add form,
 *  so the two refuse the same input with the same words. */
export const SUB_NAME_HINT = 'Type a name, up to 40 characters.';
export const SUB_AMOUNT_HINT = "Couldn't read that as an amount — try 9.99.";
export const SUB_DATE_HINT = "Couldn't read that date — try Oct 20 or 2026-10-20.";

/** A subscription's name: trimmed, inner runs of spaces collapsed, 1–40 characters. */
export function parseSubscriptionName(text: string): string | null {
  const name = (text ?? '').trim().replace(/\s+/g, ' ');
  return name.length >= 1 && name.length <= 40 ? name : null;
}

/**
 * A subscription's next charge date. A past date means its next occurrence
 * by the cadence (monthly rolls by months, yearly by years), counted from
 * what was typed so a 31st stays a 31st. "Feb 29" in a year without one is
 * Feb 28 (R2-4) — parseDateInput refuses it, so it is caught here.
 */
export function parseSubscriptionDate(text: string, now: Date, cadence: Cadence, today: string): string | null {
  let parsed = parseDateInput(text, now);
  if (parsed === null) {
    const md = (text ?? '').trim().toLowerCase().match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?$/);
    if (md && md[1].startsWith('feb') && Number(md[2]) === 29) {
      parsed = { iso: `${now.getUTCFullYear()}-02-28`, form: 'month-day' };
    }
  }
  return parsed === null ? null : rollForward(parsed.iso, cadence, today);
}
```

In `shared/ask-flow.ts`, replace `askStartData` with:

```ts
/** Telegram drops a button whose callback_data is over 64 bytes — fail loudly
 *  at render time instead of shipping a dead button. */
const MAX_CALLBACK_BYTES = 64;

export function askStartData(flowId: string, arg?: string): string {
  const data = `${START_PREFIX}${flowId}${arg !== undefined ? `:${arg}` : ''}`;
  if (new TextEncoder().encode(data).length > MAX_CALLBACK_BYTES) {
    throw new Error(`callback_data over Telegram's 64 bytes: ${data}`);
  }
  return data;
}
```

- [ ] **Step 4: Implement the flows**

In `companion/src/ask-flows.ts`, extend the imports:

```ts
import type { AskFlow, AskOption } from '../../shared/ask-flow.js';
import { localIsoDay, rosterMoney, type Cadence } from '../../shared/subscription-roster.js';
```
(replace the existing `import type { AskFlow } …` line) and add `parseSubscriptionDate, parseSubscriptionName, SUB_AMOUNT_HINT, SUB_DATE_HINT, SUB_NAME_HINT` to the existing `../../shared/telegram-commands.js` import. Then append:

```ts
/** `[1d] [3d] [7d] [No]` — days of warning before a charge. */
export const SUB_REMIND_OPTIONS: AskOption[] = [
  { label: '1d', value: 1 }, { label: '3d', value: 3 }, { label: '7d', value: 7 }, { label: 'No', value: null },
];

const subName = (input: string) => {
  const name = parseSubscriptionName(input);
  return name === null ? { ok: false as const, hint: SUB_NAME_HINT } : { ok: true as const, value: name };
};

/** ➕ Add on /subscriptions: name → amount → how often → next date → reminder → summary → Save. */
export function buildSubAddFlow(now: Date): AskFlow {
  const today = localIsoDay(now);
  return {
    id: 'sub-add',
    command: 'subscriptions',
    title: 'New subscription',
    steps: [
      { id: 'name', kind: 'text', prompt: () => "What's it called? (e.g. Hulu)", parse: subName },
      {
        id: 'amount',
        kind: 'text',
        prompt: (a) => `How much is each ${escapeMarkdown(a.name as string)} charge? (e.g. 9.99)`,
        parse: (input) => {
          const cents = parseAmountCents(input);
          return cents === null ? { ok: false, hint: SUB_AMOUNT_HINT } : { ok: true, value: cents };
        },
      },
      {
        id: 'cadence',
        kind: 'choice',
        prompt: () => 'How often does it charge?',
        options: () => [{ label: 'Monthly', value: 'monthly' }, { label: 'Yearly', value: 'yearly' }],
      },
      {
        id: 'nextDate',
        kind: 'text',
        prompt: () => 'When is the next charge? (e.g. Oct 20)',
        parse: (input, a) => {
          const date = parseSubscriptionDate(input, now, a.cadence as Cadence, today);
          return date === null ? { ok: false, hint: SUB_DATE_HINT } : { ok: true, value: date };
        },
      },
      { id: 'remind', kind: 'choice', prompt: () => 'Remind you before it charges?', options: () => SUB_REMIND_OPTIONS },
    ],
    // The name is user text: escaped, and kept out of the bold the date wears.
    summary: (a) => {
      const days = a.remind as number | null;
      return `${escapeMarkdown(a.name as string)} — ${rosterMoney(a.amount as number)} ${a.cadence === 'yearly' ? 'a year' : 'a month'}, `
        + `next charge *${shortDate(a.nextDate as string)}*.\n`
        + (days ? `🔔 Reminder ${days} ${days === 1 ? 'day' : 'days'} before.` : 'No reminder.');
    },
  };
}

/** ✏️ Rename on an entry's detail: one question, finished by the answer. */
export function buildSubRenameFlow(currentName: string): AskFlow {
  return {
    id: 'sub-rename',
    command: 'subscriptions',
    title: 'Rename',
    steps: [{ id: 'name', kind: 'text', prompt: () => `New name for ${escapeMarkdown(currentName)}?`, parse: subName }],
  };
}
```

- [ ] **Step 5: Register the flows**

In `companion/src/index.ts`:

1. Imports: extend `./ask-flows.js` with `buildSubAddFlow, buildSubRenameFlow`; extend `../../shared/subscription-prefs.js` with `addManual, isUnreadablePrefsError, newManualId, renameKey, setRemind, type ManualSubscription, type RemindDays, type SubscriptionEdit`; extend `./subscriptions-menu.js` with `findRosterEntry, SUBSCRIPTIONS_BUTTON, SUBSCRIPTIONS_RENAME_GONE_REPLY, SUBSCRIPTIONS_UNREADABLE_REPLY, undoRenameButton`; add
```ts
import { manualKey, rosterMoney, type Cadence } from '../../shared/subscription-roster.js';
```

2. Above `export function buildAskSessions`:
```ts
/** One subscription write for the question flows, reported as an outcome so
 *  each flow can answer with the matching sentence. */
async function writeSubscriptionPrefs(
  wfClient: WealthfolioClient,
  edit: SubscriptionEdit,
): Promise<'ok' | 'unreadable' | 'unreachable'> {
  const { get, set } = subscriptionSecrets(wfClient);
  try {
    await editSubscriptionPrefs(get, set, edit, new Date());
    return 'ok';
  } catch (err) {
    if (isUnreadablePrefsError(err)) return 'unreadable';
    log(`Subscription write failed: ${formatError(err)}`);
    return 'unreachable';
  }
}
```

3. In `buildAskSessions`, before `return asks;`:
```ts
  asks.register('sub-add', async (_arg, send) => {
    // Checked before the five questions, not after them: a document that
    // cannot be written must not cost the answers.
    const loaded = await loadSubscriptionPrefs(subscriptionSecrets(wfClient).get).catch(() => null);
    if (!loaded) {
      await send(SUBSCRIPTIONS_UNREACHABLE_REPLY);
      return null;
    }
    if (loaded.unreadable) {
      await send(SUBSCRIPTIONS_UNREADABLE_REPLY);
      return null;
    }
    return {
      flow: buildSubAddFlow(new Date()),
      onDone: async (a, reply) => {
        const entry: ManualSubscription = {
          id: newManualId(), name: a.name as string, cents: a.amount as number,
          cadence: a.cadence as Cadence, nextDate: a.nextDate as string,
        };
        const remind = (a.remind ?? null) as RemindDays | null;
        const outcome = await writeSubscriptionPrefs(wfClient, (p) => setRemind(addManual(p, entry), manualKey(entry.id), remind));
        if (outcome !== 'ok') {
          await reply(outcome === 'unreadable' ? SUBSCRIPTIONS_UNREADABLE_REPLY : SUBSCRIPTIONS_UNREACHABLE_REPLY);
          return;
        }
        await reply(
          `✍️ Added ${escapeMarkdown(entry.name)} — ${rosterMoney(entry.cents)} ${entry.cadence === 'yearly' ? 'a year' : 'a month'}, next charge ${shortDate(entry.nextDate)}.`,
          { inline_keyboard: [[SUBSCRIPTIONS_BUTTON]] },
        );
      },
    };
  });
  asks.register('sub-rename', async (arg, send) => {
    let read: RosterRead;
    try {
      read = await readRosterFor(wfClient, new Date());
    } catch (err) {
      log(`Ask flow sub-rename: reading failed: ${formatError(err)}`);
      await send(SUBSCRIPTIONS_UNREACHABLE_REPLY);
      return null;
    }
    if (read.unreadable) {
      await send(SUBSCRIPTIONS_UNREADABLE_REPLY);
      return null;
    }
    const entry = findRosterEntry(read.roster, arg ?? '');
    if (!entry) {
      await send(SUBSCRIPTIONS_RENAME_GONE_REPLY);
      return null;
    }
    return {
      flow: buildSubRenameFlow(entry.displayName),
      onDone: async (a, reply) => {
        const name = a.name as string;
        const outcome = await writeSubscriptionPrefs(wfClient, (p) => renameKey(p, entry.key, name));
        if (outcome !== 'ok') {
          await reply(outcome === 'unreadable' ? SUBSCRIPTIONS_UNREADABLE_REPLY : SUBSCRIPTIONS_UNREACHABLE_REPLY);
          return;
        }
        await reply(
          `✏️ Renamed ${escapeMarkdown(entry.displayName)} to ${escapeMarkdown(name)}.`,
          { inline_keyboard: [[undoRenameButton(entry.handle)], [SUBSCRIPTIONS_BUTTON]] },
        );
      },
    };
  });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run shared/telegram-commands.test.ts shared/ask-flow.test.ts`
Expected: PASS.

Run: `npm --prefix companion test`
Expected: PASS (whole companion suite, every R1 flow test unchanged).

Run: `npm run type-check && npm --prefix companion run build`
Expected: both succeed.

- [ ] **Step 7: Commit**

```bash
git add shared/telegram-commands.ts shared/telegram-commands.test.ts shared/ask-flow.ts shared/ask-flow.test.ts companion/src/ask-flows.ts companion/src/ask-flows.test.ts companion/src/index.ts companion/src/index.test.ts
git commit -m "Bot: add and rename subscriptions by answering questions; 64-byte guard on flow buttons

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The morning "Coming up" block and the weekly line

**Files:**
- Modify: `companion/src/index.ts` — `composeDailyDigest` (glyph read in the `formatDailySpendingDigest(` call ~line 1849; the creep loop ~line 1869-1881; the `return` ~line 1927-1932), `readCubeSubscriptions` and `CREEP_FRESH_DAYS` (~line 1966-1991, removed), `composeWeeklyReportMessage` (~line 2192-2241), `sendWeeklyTelegramReport` (~line 2243-2262), the import at ~line 96
- Test: `companion/src/index.test.ts` (`describe('subscriptions in the reports', …)` ~line 4769)

**Interfaces:**
- Consumes: Task 2 (`addDaysIso`, `dueWithin`, `formatRosterTotal`), Task 5 (`formatComingUpBlock`, `formatNextWeekLine`), Task 6 (`readRosterFor`, `SUBSCRIPTIONS_BUTTON`, `SEE_ALL_SUBSCRIPTIONS_BUTTON`, `hideFromReportButton`).
- Produces:
  - `export async function composeWeeklyReport(wfClient: WealthfolioClient, now: Date, tg: any): Promise<{ text: string; keyboard?: InlineKeyboard } | null>` — the weekly report plus its `[See all]` button (R2-7: a sibling; `composeWeeklyReportMessage` keeps returning `string | null` and `publishLiveReports` is unchanged).
  - `DailyDigest.keyboard` gains `[💳 Subscriptions]` and up to two `[🙈 Hide <name>]` buttons above `[🧹 Show what to fix]` when the block shows.
  - Removed: `readCubeSubscriptions`, the index.ts `CREEP_FRESH_DAYS`, and the import of `HIDDEN_SUBSCRIPTIONS_SECRET_KEY, CONFIRMED_SUBSCRIPTIONS_SECRET_KEY, parseHiddenSubscriptions`.

- [ ] **Step 1: Write the failing tests**

In `companion/src/index.test.ts`, `describe('subscriptions in the reports', …)`:

1. In `'a confirmed bill joins the weekly money total'`, change `'$1,250.00/mo across 1'` to `'$1,250/mo across 1'` (one money format for every subscription surface).

2. Add, inside the describe (after `clientWith`):

```ts
  /** DetectedSubscription exactly as a 1.60 companion publishes it. */
  const det = (name: string, over: Record<string, unknown> = {}) => ({
    name, monthlyCents: 1199, count: 5, lastDate: '2026-09-15', lastCents: 1199, prevCents: 1199, creep: false,
    kind: 'subscription', recent: [{ date: '2026-09-15', cents: 1199 }], ...over,
  });
  const cubeR2 = (subscriptions: unknown[]) => JSON.stringify({
    version: 1, asOf: '2026-10-12T06:00:00.000Z', months: ['2026-09', '2026-10'], categories: [], accounts: [],
    spend: [[], []], uncategorized: [[], []], income: [[], []], budgets: [[], []], merchants: [[], []],
    feesInterest: [0, 0], netWorth: [null, null], liquid: [null, null], pool: null, subscriptions,
  });
  /** Oct 12: SPOTIFY due in 3 days, RENT due in 4, a fresh price rise with a
   *  Markdown star in the bank's name, NETFLIX's Oct 3 charge missing. */
  const MORNING = () => cubeR2([
    det('SPOTIFY', { lastDate: '2026-09-15' }),
    det('RENT LLC', { kind: 'bill', monthlyCents: 80000, lastCents: 80000, lastDate: '2026-09-16' }),
    det('PAYPAL *HULU', { monthlyCents: 999, lastCents: 1099, creep: true, lastDate: '2026-10-10' }),
    det('NETFLIX', { monthlyCents: 1549, lastCents: 1549, lastDate: '2026-09-03' }),
  ]);
  const REMIND_SPOTIFY = JSON.stringify({ v: 1, remind: { SPOTIFY: 3 } });
  const at = async <T>(date: Date, fn: () => Promise<T>): Promise<T> => {
    vi.useFakeTimers();
    vi.setSystemTime(date);
    try { return await fn(); } finally { vi.useRealTimers(); }
  };
  const MORNING_8AM = new Date(2026, 9, 12, 8, 0, 0);

  it('the morning block sits after the spending summary: reminders, the week, the price rise, "cancelled?"', async () => {
    const client = clientWith([['report_cube', MORNING()], ['subscription_prefs', REMIND_SPOTIFY]]);
    const digest = (await at(MORNING_8AM, () => composeDailyDigest(client, { requireTelegram: false })))!;
    const block = [
      '*Coming up*',
      '🔔 SPOTIFY charges in 3 days · $11.99',
      'RENT LLC Oct 16 · about $800',
      '📈 PAYPAL \\*HULU charged $10.99 — up from its usual $9.99.',
      "✓ NETFLIX didn't charge Oct 3 — cancelled?",
    ].join('\n');
    expect(digest.text).toContain(block);
    expect(digest.text.indexOf('*Coming up*')).toBeGreaterThan(digest.text.indexOf('Daily Spending Check'));
    // The Reports tab and push carry the block too — as text, without buttons.
    expect(digest.archive).toContain(block);
    const rows = digest.keyboard!.inline_keyboard;
    expect(rows[0]).toEqual([{ text: '💳 Subscriptions', callback_data: 'cz:sb:o' }]);
    expect(rows[1]).toEqual([{ text: '🙈 Hide NETFLIX', callback_data: `cz:sb:hr:${findingHandle('NETFLIX')}` }]);
  });

  it('a Brief morning leaves out the week ahead', async () => {
    const client = clientWith([
      ['telegram_config', JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true, reportDetail: 'brief' })],
      ['report_cube', MORNING()], ['subscription_prefs', REMIND_SPOTIFY],
    ]);
    const text = (await at(MORNING_8AM, () => composeDailyDigestMessage(client)))!;
    expect(text).toContain('*Coming up*\n🔔 SPOTIFY charges in 3 days · $11.99\n📈');
    expect(text).not.toContain('RENT LLC Oct 16');
  });

  // Review Focus: a bank name with Markdown characters on the morning report.
  it('a bank name with * or _ is escaped and kept out of bold — Telegram would refuse the whole report', async () => {
    const client = clientWith([['report_cube', cubeR2([
      det('SQ *COFFEE_CLUB', { monthlyCents: 900, lastCents: 1000, creep: true, lastDate: '2026-10-11' }),
    ])]]);
    const text = (await at(MORNING_8AM, () => composeDailyDigestMessage(client)))!;
    expect(text).toContain('\n📈 SQ \\*COFFEE\\_CLUB charged $10.00 — up from its usual $9.00.');
    expect(text).not.toContain('SQ *COFFEE_CLUB');
  });

  it('nothing to say: no block and no subscription buttons', async () => {
    const client = clientWith([['report_cube', cubeR2([det('ADOBE', { monthlyCents: 5499, lastCents: 5499, lastDate: '2026-09-25' })])]]);
    const digest = (await at(MORNING_8AM, () => composeDailyDigest(client, { requireTelegram: false })))!;
    expect(digest.text).not.toContain('Coming up');
    expect(JSON.stringify(digest.keyboard ?? null)).not.toContain('cz:sb:');
  });

  it('weekly: the subscriptions line from the roster, next week under it, and See all', async () => {
    const client = clientWith([
      ['report_cube', cubeR2([
        det('SPOTIFY', { lastDate: '2026-09-15' }),
        det('RENT LLC', { kind: 'bill', monthlyCents: 80000, lastCents: 80000, lastDate: '2026-09-16' }),
        det('ADOBE', { monthlyCents: 5499, lastCents: 5499, lastDate: '2026-09-25' }),
      ])],
      ['subscription_prefs', JSON.stringify({ v: 1, names: { SPOTIFY: 'Spotify' } })],
    ]);
    const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    await at(new Date(2026, 9, 11, 20, 0, 0), () => sendWeeklyTelegramReport(client)); // Sunday 8pm
    const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
    expect(body.text).toContain('*Subscriptions* — $66.98/mo across 2\nNext week: 2 charges · $811.99');
    expect(body.reply_markup).toEqual({ inline_keyboard: [[{ text: 'See all', callback_data: 'cz:sb:o' }]] });
  });

  it("the Reports tab's weekly copy is the same text, still a plain string", async () => {
    const client = clientWith([['report_cube', cubeR2([det('SPOTIFY', { lastDate: '2026-09-15' })])]]);
    const text = await composeWeeklyReportMessage(client, new Date(2026, 9, 11, 20, 0, 0), {});
    expect(text).toContain('*Subscriptions* — $11.99/mo across 1\nNext week: 1 charge · $11.99');
  });
```

Add `findingHandle` (from Task 6) and `composeWeeklyReportMessage` to the test file's imports if they are not there yet (`composeWeeklyReportMessage` is exported from `./index.js`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix companion test -- src/index.test.ts -t "subscriptions in the reports"`
Expected: FAIL — no `*Coming up*` block, no `Next week:` line, `$1,250.00` still printed.

- [ ] **Step 3: Implement**

In `companion/src/index.ts`:

1. Imports: add `formatComingUpBlock, formatNextWeekLine` to the existing `../../shared/telegram.js` import; extend `./subscriptions-menu.js` with `hideFromReportButton, SEE_ALL_SUBSCRIPTIONS_BUTTON` (`SUBSCRIPTIONS_BUTTON` is there from Task 7); extend `../../shared/subscription-roster.js` with `addDaysIso, dueWithin, formatRosterTotal`. Delete the line `import { HIDDEN_SUBSCRIPTIONS_SECRET_KEY, CONFIRMED_SUBSCRIPTIONS_SECRET_KEY, parseHiddenSubscriptions } from '../../shared/subscriptions.js';`.

2. In `composeDailyDigest`, add `const glyphStyle = await readGlyphStyle(wfClient);` on the line before `let message = formatDailySpendingDigest(`, and in that call replace `categories, period, await readGlyphStyle(wfClient), subcategoryDisplay,` with `categories, period, glyphStyle, subcategoryDisplay,`.

3. Replace the creep comment and loop (from `// A price creep is one line for a couple of mornings, then silence:` through the closing `}` of the `for (const sub of await readCubeSubscriptions(wfClient))` loop) with:
```ts
  // "Coming up" (1.60): reminders, the week's charges (Full), the price-rise
  // line that used to stand alone here (same 3-day rule), and "cancelled?".
  // From the roster, so it says what the card and /subscriptions say.
  // Guarded to absence: it can cost itself, never the report.
  const roster = (await readRosterFor(wfClient, now).catch(() => null))?.roster ?? null;
  const comingUp = roster
    ? formatComingUpBlock(roster, toDateString(now), resolveReportDetail(tg), glyphStyle)
    : null;
  if (comingUp) message += `\n\n${comingUp.text}`;
```
It is appended to `message` before `let archive = message;`, so the archive carries it too.

4. Replace the final `return { … };` of `composeDailyDigest` with:
```ts
  const rows: InlineKeyboard['inline_keyboard'] = [];
  if (comingUp) {
    // Opens the list as a NEW message, like the 🧹 button below it.
    rows.push([SUBSCRIPTIONS_BUTTON]);
    const hides = comingUp.cancelled.slice(0, 2).map(hideFromReportButton);
    if (hides.length > 0) rows.push(hides);
  }
  // The 🧹 button only when something is actually folded behind it.
  if (folded > 0) rows.push([SHOW_FINDINGS_BUTTON]);
  return {
    text: message,
    archive,
    keyboard: rows.length > 0 ? { inline_keyboard: rows } : undefined,
  };
```

5. Delete `CREEP_FRESH_DAYS`, its doc comment, and `readCubeSubscriptions` with its doc comment (from `/** Days a crept charge still counts as news in the daily digest. */` through the closing `}` of `readCubeSubscriptions`). Keep the `/** The "update available" seam. … */` comment, which belongs to `updateCheckDeps` below.

6. Rename `export async function composeWeeklyReportMessage(` to `export async function composeWeeklyReport(` and change its return type to `Promise<{ text: string; keyboard?: InlineKeyboard } | null>`. Inside it: add `const glyphStyle = await readGlyphStyle(wfClient);` before `let message = formatMonthlyRemainingSummary(`, pass `glyphStyle,` in place of `await readGlyphStyle(wfClient),`, and replace everything from `const subs = full ? await readCubeSubscriptions(wfClient) : [];` to the final `return message;` with:
```ts
  let keyboard: InlineKeyboard | undefined;
  if (full) {
    // From the roster since 1.60: the card's names and totals, and what the
    // coming week will charge. Guarded: it can cost these lines, never the report.
    const read = await readRosterFor(wfClient, now).catch(() => null);
    if (read) {
      const { roster } = read;
      const lines: string[] = [];
      if (roster.subscriptions.length > 0) {
        lines.push(`*Subscriptions* — ${formatRosterTotal(roster)} across ${roster.subscriptions.length}`);
      }
      const nextWeek = formatNextWeekLine(dueWithin(roster, addDaysIso(toDateString(now), 1), 7), glyphStyle);
      if (nextWeek) lines.push(nextWeek);
      if (lines.length > 0) {
        message += `\n\n${lines.join('\n')}`;
        keyboard = { inline_keyboard: [[SEE_ALL_SUBSCRIPTIONS_BUTTON]] };
      }
    }
  }
  return { text: message, keyboard };
}

/** The weekly report's text alone — the Reports tab's live edition (R2-7:
 *  publishLiveReports keeps calling this, unchanged). */
export async function composeWeeklyReportMessage(
  wfClient: WealthfolioClient,
  now: Date,
  tg: any,
): Promise<string | null> {
  return (await composeWeeklyReport(wfClient, now, tg))?.text ?? null;
```
(The existing `return null;` for a missing database stays as is: `null` satisfies the new return type.)

7. In `sendWeeklyTelegramReport`, replace `const message = await composeWeeklyReportMessage(wfClient, now, tg ?? {});` and the following `if (message === null) return;` with:
```ts
  const report = await composeWeeklyReport(wfClient, now, tg ?? {});
  if (report === null) return;
  const message = report.text;
```
and pass `report.keyboard` as the last argument of its `sendReportWithRetry(…)` call (after `sleep`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix companion test -- src/index.test.ts`
Expected: PASS — including the existing creep, dismissed, confirmed-bill and Brief-weekly tests.

Run: `npm --prefix companion test && npm --prefix companion run build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add companion/src/index.ts companion/src/index.test.ts
git commit -m "Reports: Coming-up block in the morning report; weekly subscriptions from the roster with Next week and See all

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Reminders while the daily report is off

**Files:**
- Modify: `companion/src/index.ts` (new `sendSubscriptionNews` above `sendDailyTelegramReport` ~line 2146; the early return in `sendDailyTelegramReport` ~line 2160)
- Test: `companion/src/index.test.ts` (`describe('subscriptions in the reports', …)`, reusing Task 8's `det`, `cubeR2`, `MORNING`, `REMIND_SPOTIFY`, `at`, `MORNING_8AM`)

**Interfaces:**
- Consumes: Task 5 (`formatSubscriptionNews`, `parseNewsSent`, `pruneNewsSent`, `SUBSCRIPTION_NEWS_SECRET_KEY`), Task 6 (`readRosterFor`, `SUBSCRIPTIONS_BUTTON`), Task 8 (`hideFromReportButton` import); existing `sendTelegramMessage`, `readGlyphStyle`, `toDateString`.
- Produces: `export async function sendSubscriptionNews(wfClient: WealthfolioClient, tg: { botToken: string; chatId: string }, now: Date): Promise<void>` — called by `sendDailyTelegramReport` when Telegram is configured and `dailyReportEnabled === false` (R2-8).

- [ ] **Step 1: Write the failing tests**

Add inside `describe('subscriptions in the reports', …)`, after the Task 8 tests (add `sendDailyTelegramReport` to the imports if absent — it is already imported at the top of the file):

```ts
  describe('news while the daily report is off (1.60)', () => {
    const OFF = JSON.stringify({ botToken: 'tok', chatId: '1', enabled: true, dailyReportEnabled: false });
    const sends = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls
      .filter((c: any[]) => String(c[0]).includes('/sendMessage'))
      .map((c: any[]) => JSON.parse(c[1].body));
    const memo = async (client: any) => {
      const raw = await client.getAddonSecret('simplefin-sync', 'subscription_news_sent');
      return raw ? JSON.parse(raw) : null;
    };

    it('one message with every new line and its buttons', async () => {
      const client = clientWith([['telegram_config', OFF], ['report_cube', MORNING()], ['subscription_prefs', REMIND_SPOTIFY]]);
      const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
      vi.stubGlobal('fetch', fetchMock);
      await at(MORNING_8AM, () => sendDailyTelegramReport(client));
      const [body, ...more] = sends(fetchMock);
      expect(more).toEqual([]);
      expect(body.text).toBe([
        '*Coming up*',
        '🔔 SPOTIFY charges in 3 days · $11.99',
        '📈 PAYPAL \\*HULU charged $10.99 — up from its usual $9.99.',
        "✓ NETFLIX didn't charge Oct 3 — cancelled?",
      ].join('\n'));
      expect(body.reply_markup.inline_keyboard).toEqual([
        [{ text: '💳 Subscriptions', callback_data: 'cz:sb:o' }],
        [{ text: '🙈 Hide NETFLIX', callback_data: `cz:sb:hr:${findingHandle('NETFLIX')}` }],
      ]);
      expect(await memo(client)).toEqual({
        'SPOTIFY|remind|2026-10-15': '2026-10-12',
        'PAYPAL *HULU|creep|2026-10-10': '2026-10-12',
        'NETFLIX|cancel|2026-10-03': '2026-10-12',
      });
    });

    // Review Focus: daily report off, and the companion down on the reminder's first morning.
    it('a reminder goes out on the first morning inside its window that the companion runs — and only once', async () => {
      const client = clientWith([
        ['telegram_config', OFF],
        ['report_cube', cubeR2([det('SPOTIFY', { lastDate: '2026-09-15' })])],
        ['subscription_prefs', REMIND_SPOTIFY],
      ]);
      const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
      vi.stubGlobal('fetch', fetchMock);
      await at(new Date(2026, 9, 11, 8, 0, 0), () => sendDailyTelegramReport(client)); // 4 days out: too early
      expect(sends(fetchMock)).toEqual([]);
      // Oct 12: the companion was down. Oct 13: two days out, still inside the window.
      await at(new Date(2026, 9, 13, 8, 0, 0), () => sendDailyTelegramReport(client));
      expect(sends(fetchMock).map((b) => b.text)).toEqual(['*Coming up*\n🔔 SPOTIFY charges in 2 days · $11.99']);
      await at(new Date(2026, 9, 14, 8, 0, 0), () => sendDailyTelegramReport(client));
      expect(sends(fetchMock)).toHaveLength(1);
      expect(await memo(client)).toEqual({ 'SPOTIFY|remind|2026-10-15': '2026-10-13' });
    });

    it('a message Telegram refuses is not recorded, so the next morning tries again', async () => {
      const client = clientWith([
        ['telegram_config', OFF],
        ['report_cube', cubeR2([det('SPOTIFY', { lastDate: '2026-09-15' })])],
        ['subscription_prefs', REMIND_SPOTIFY],
      ]);
      const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: false, error_code: 400, description: 'Bad Request' }) }));
      vi.stubGlobal('fetch', fetchMock);
      await at(new Date(2026, 9, 13, 8, 0, 0), () => sendDailyTelegramReport(client));
      expect(await memo(client)).toBeNull();
      fetchMock.mockImplementation(async () => ({ json: async () => ({ ok: true }) }));
      await at(new Date(2026, 9, 14, 8, 0, 0), () => sendDailyTelegramReport(client));
      expect(sends(fetchMock).at(-1).text).toBe('*Coming up*\n🔔 SPOTIFY charges tomorrow · $11.99');
      expect(await memo(client)).toEqual({ 'SPOTIFY|remind|2026-10-15': '2026-10-14' });
    });

    it('with the daily report on, the block rides the report and nothing else is sent', async () => {
      const client = clientWith([['report_cube', MORNING()], ['subscription_prefs', REMIND_SPOTIFY]]);
      const fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
      vi.stubGlobal('fetch', fetchMock);
      await at(MORNING_8AM, () => sendDailyTelegramReport(client));
      const bodies = sends(fetchMock);
      expect(bodies).toHaveLength(1);
      expect(bodies[0].text).toContain('*Coming up*');
      expect(await memo(client)).toBeNull();
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm --prefix companion test -- src/index.test.ts -t "news while the daily report is off"`
Expected: FAIL — nothing is sent while the daily report is off.

- [ ] **Step 3: Implement**

In `companion/src/index.ts`:

1. Add `formatSubscriptionNews, parseNewsSent, pruneNewsSent, SUBSCRIPTION_NEWS_SECRET_KEY` to the `../../shared/telegram.js` import.

2. Above `export async function sendDailyTelegramReport(`:
```ts
/**
 * With the daily report switched off, the subscription lines still arrive:
 * the 🔔, 📈 and ✓ lines the report would have carried, as ONE short
 * message, each event at most once (ids in `subscription_news_sent`, pruned
 * after 60 days). Recorded only after Telegram accepted the message, so a
 * failed morning tries again the next — a reminder still inside its window
 * still goes.
 */
export async function sendSubscriptionNews(
  wfClient: WealthfolioClient,
  tg: { botToken: string; chatId: string },
  now: Date,
): Promise<void> {
  const today = toDateString(now);
  const read = await readRosterFor(wfClient, now).catch(() => null);
  if (!read) return;
  const sent = parseNewsSent(
    await wfClient.getAddonSecret('simplefin-sync', SUBSCRIPTION_NEWS_SECRET_KEY).catch(() => null),
  );
  const news = formatSubscriptionNews(read.roster, today, sent, await readGlyphStyle(wfClient));
  if (!news) return;
  const hides = news.cancelled.slice(0, 2).map(hideFromReportButton);
  const keyboard: InlineKeyboard = { inline_keyboard: [[SUBSCRIPTIONS_BUTTON], ...(hides.length > 0 ? [hides] : [])] };
  const result = await sendTelegramMessage(tg.botToken, tg.chatId, news.text, undefined, keyboard);
  if (!result.ok) {
    log(`Subscription news was not sent: ${result.description}`);
    return;
  }
  log('Subscription news sent (the daily report is off).');
  const next = pruneNewsSent({ ...sent, ...Object.fromEntries(news.events.map((id) => [id, today])) }, today);
  await wfClient.setAddonSecret('simplefin-sync', SUBSCRIPTION_NEWS_SECRET_KEY, JSON.stringify(next))
    .catch((err) => log(`Could not record the subscription news as sent: ${formatError(err)}`));
}
```

3. In `sendDailyTelegramReport`, replace
```ts
  if (!tg || !tg.botToken || !tg.chatId || tg.enabled === false || tg.dailyReportEnabled === false) return;
```
with
```ts
  if (!tg || !tg.botToken || !tg.chatId || tg.enabled === false) return;
  if (tg.dailyReportEnabled === false) {
    // The report is off, but a reminder was asked for: the lines go out on
    // their own — never both (v1.57's one-voice rule).
    await sendSubscriptionNews(wfClient, tg, new Date());
    return;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm --prefix companion test -- src/index.test.ts`
Expected: PASS.

Run: `npm --prefix companion test && npm --prefix companion run build`
Expected: both succeed.

- [ ] **Step 5: Commit**

```bash
git add companion/src/index.ts companion/src/index.test.ts
git commit -m "Reports: subscription reminders and news as one message while the daily report is off

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---
### Task 10: App data layer — one document, one edit path

**Files:**
- Modify: `src/utils/secrets.ts` (import ~line 24; `KEYS` ~line 140-145; the four list methods ~line 793-809)
- Test: `src/utils/secrets.test.ts`
- Modify: `src/pages/SyncPage.tsx` (the `Promise.all` in `refresh` ~line 228-251; the two list states ~line 275-284; the `<BudgetTab …>` props ~line 694-697)
- Modify: `src/tabs/BudgetTab.tsx` (`BudgetTabProps` ~line 47-51; destructuring ~line 80-85; `subsProps` ~line 197-217)
- Modify: `src/components/budget/ReportView.tsx` (`ReportView` props ~line 925-958; `case 'subscriptions':` ~line 984-996)
- Test: `src/tabs/BudgetTab.test.tsx` (`describe('subscription dismissals end to end', …)` ~line 581 and `describe('subscription confirmation end to end', …)` ~line 629)

**Why the transitional adapter:** the card itself is rewritten in Task 11. To keep this task reviewable and every gate green, `ReportView` accepts the new props here and feeds the EXISTING card from them; its old props stay one more task (unused by BudgetTab) so `ReportView.test.tsx` is untouched until Task 11 rewrites it.

**Interfaces:**
- Consumes: Task 1 (`loadSubscriptionPrefs`, `editSubscriptionPrefs`, `isUnreadablePrefsError`, `emptySubscriptionPrefs`, `hideKey`, `unhideKey`, `confirmKey`, `LoadedSubscriptionPrefs`, `SubscriptionEdit`, `SubscriptionPrefs`, `SUBSCRIPTION_PREFS_SECRET_KEY`), Task 5 (`SUBSCRIPTION_NEWS_SECRET_KEY`).
- Produces:
  - `SecretsStore.getSubscriptionPrefs(): Promise<LoadedSubscriptionPrefs | null>` (null when the host read throws) and `SecretsStore.editSubscriptionPrefs(edit: SubscriptionEdit): Promise<SubscriptionPrefs>` (rejects with `SubscriptionPrefsUnreadableError` on a corrupt document). `getHiddenSubscriptions`, `setHiddenSubscriptions`, `getConfirmedSubscriptions`, `setConfirmedSubscriptions` are REMOVED.
  - `KEYS.subscriptionPrefs = 'subscription_prefs'`, `KEYS.subscriptionNewsSent = 'subscription_news_sent'` (so Reset clears both).
  - `BudgetTabProps`: `subscriptionPrefs?: LoadedSubscriptionPrefs | null; onSubscriptionEdit?: (edit: SubscriptionEdit) => void;` REPLACE the four list props.
  - `ReportView` props gain `subscriptionPrefs?: LoadedSubscriptionPrefs | null; onSubscriptionEdit?: (edit: SubscriptionEdit) => void; companionStale?: boolean; onSetUpCompanion?: () => void;` (Task 11 removes the old six).

- [ ] **Step 1: Write the failing tests**

Add to `src/utils/secrets.test.ts` (add `import { hideKey, SubscriptionPrefsUnreadableError } from '../../shared/subscription-prefs';`):

```ts
describe('subscription prefs (1.60)', () => {
  it('reads the legacy lists while no document exists', async () => {
    const { ctx, data } = makeCtxWithData();
    data.hidden_subscriptions = JSON.stringify(['QR LIBRARY']);
    data.confirmed_subscriptions = JSON.stringify(['RENT LLC']);
    expect(await new SecretsStore(ctx).getSubscriptionPrefs()).toMatchObject({
      unreadable: false, prefs: { hidden: ['QR LIBRARY'], confirmed: ['RENT LLC'] },
    });
  });

  it('edits by re-reading the stored document — a hide made from Telegram since the page loaded is kept', async () => {
    const { ctx, data } = makeCtxWithData();
    data.subscription_prefs = JSON.stringify({ v: 1, hidden: ['NETFLIX'] });
    const written = await new SecretsStore(ctx).editSubscriptionPrefs((p) => hideKey(p, 'SPOTIFY'));
    expect(written.hidden).toEqual(['NETFLIX', 'SPOTIFY']);
    expect(JSON.parse(data.subscription_prefs).hidden).toEqual(['NETFLIX', 'SPOTIFY']);
    expect(JSON.parse(data.hidden_subscriptions)).toEqual(['NETFLIX', 'SPOTIFY']);
  });

  it('refuses to overwrite a corrupt document', async () => {
    const { ctx, data } = makeCtxWithData();
    data.subscription_prefs = '{"v":1,"hidden":';
    await expect(new SecretsStore(ctx).editSubscriptionPrefs((p) => hideKey(p, 'SPOTIFY')))
      .rejects.toBeInstanceOf(SubscriptionPrefsUnreadableError);
    expect(data.subscription_prefs).toBe('{"v":1,"hidden":');
  });

  it('reads null, not a guess, when the host read fails', async () => {
    const ctx = makeCtx();
    ctx.api.secrets.get.mockRejectedValue(new Error('host down'));
    expect(await new SecretsStore(ctx).getSubscriptionPrefs()).toBeNull();
  });

  it("clearAll deletes the subscription document and the companion's news memo", async () => {
    const { ctx, data } = makeCtxWithData();
    data.subscription_prefs = '{"v":1}';
    data.subscription_news_sent = '{}';
    await new SecretsStore(ctx).clearAll();
    expect(data.subscription_prefs).toBeUndefined();
    expect(data.subscription_news_sent).toBeUndefined();
  });
});
```

In `src/tabs/BudgetTab.test.tsx`, add `import { emptySubscriptionPrefs, hideKey, type SubscriptionEdit, type SubscriptionPrefs } from '../../shared/subscription-prefs';`, add this helper below `reportIds`:

```tsx
/** The store's subscription half over one in-memory document. The real
 *  re-read-before-write lives in SecretsStore (pinned in secrets.test.ts);
 *  `elsewhere` stands in for a write from Telegram after the page loaded. */
const subscriptionStore = (initial: Partial<SubscriptionPrefs> = {}) => {
  let doc: SubscriptionPrefs = { ...emptySubscriptionPrefs(), ...initial };
  return {
    getSubscriptionPrefs: vi.fn(async () => ({ prefs: doc, unreadable: false })),
    editSubscriptionPrefs: vi.fn(async (edit: SubscriptionEdit) => { doc = edit(doc); return doc; }),
    elsewhere: (edit: SubscriptionEdit) => { doc = edit(doc); },
    current: () => doc,
  };
};
const withSubscriptions = (props: ReturnType<typeof makeProps>, subs: ReturnType<typeof subscriptionStore>) =>
  Object.assign(props.store, { getSubscriptionPrefs: subs.getSubscriptionPrefs, editSubscriptionPrefs: subs.editSubscriptionPrefs });
```

and replace `describe('subscription dismissals end to end', …)` and `describe('subscription confirmation end to end', …)` with:

```tsx
describe('subscription dismissals end to end', () => {
  const SPOTIFY = { name: 'SPOTIFY', monthlyCents: 1099, count: 5, lastDate: '2026-08-20', lastCents: 1099, creep: false };
  const QR = { name: 'QR LIBRARY', monthlyCents: 999, count: 4, lastDate: '2026-08-22', lastCents: 999, creep: false };
  const NETFLIX = { name: 'NETFLIX', monthlyCents: 1549, count: 6, lastDate: '2026-08-25', lastCents: 1549, creep: false };
  const withCube = (props: ReturnType<typeof makeProps>, subscriptions: unknown[]) => {
    (props.store as any).getReportCube = vi.fn(async () => ({ ...CUBE, asOf: new Date().toISOString(), subscriptions }));
  };

  it('dismissing on the card is ONE edit through the store, and the row goes', async () => {
    const props = makeProps();
    const subs = subscriptionStore();
    withSubscriptions(props, subs);
    withCube(props, [SPOTIFY, QR]);
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss QR LIBRARY' }));
    expect(subs.editSubscriptionPrefs).toHaveBeenCalledTimes(1);
    expect(subs.current().hidden).toEqual(['QR LIBRARY']);
    await waitFor(() => expect(screen.queryByText('QR LIBRARY')).toBeNull());
    expect(screen.getByText('SPOTIFY')).toBeInTheDocument();
  });

  it('the card follows what was WRITTEN — a hide made from Telegram since the page loaded comes along', async () => {
    const props = makeProps();
    const subs = subscriptionStore();
    withSubscriptions(props, subs);
    withCube(props, [SPOTIFY, QR, NETFLIX]);
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));

    subs.elsewhere((p) => hideKey(p, 'NETFLIX'));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss QR LIBRARY' }));
    await waitFor(() => expect(screen.queryByText('NETFLIX')).toBeNull());
    expect(screen.queryByText('QR LIBRARY')).toBeNull();
  });
});

describe('subscription confirmation end to end', () => {
  it('answering Yes is ONE edit through the store and moves it into the roster', async () => {
    const props = makeProps();
    const subs = subscriptionStore();
    withSubscriptions(props, subs);
    (props.store as any).getReportCube = vi.fn(async () => ({
      ...CUBE,
      asOf: new Date().toISOString(),
      subscriptions: [
        { name: 'RENT LLC', monthlyCents: 90000, count: 6, lastDate: '2026-08-25', lastCents: 90000, creep: false, kind: 'bill' },
      ],
    }));
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));

    expect(screen.getByText(/is this a subscription\?/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, RENT LLC is a subscription' }));
    expect(subs.current().confirmed).toEqual(['RENT LLC']);
    await waitFor(() => expect(screen.queryByText(/is this a subscription\?/i)).toBeNull());
    expect(screen.getByText(/\$900\.00\/mo across 1/)).toBeInTheDocument();
  });
});
```

(These still drive the pre-1.60 card — `Dismiss …`, `$900.00` — through the adapter; Task 11 moves them to the new card.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/utils/secrets.test.ts src/tabs/BudgetTab.test.tsx`
Expected: FAIL — `getSubscriptionPrefs is not a function`; the card never calls `editSubscriptionPrefs`.

- [ ] **Step 3: Implement the store**

In `src/utils/secrets.ts`:

1. Replace the import at ~line 24 with:
```ts
import { HIDDEN_SUBSCRIPTIONS_SECRET_KEY, CONFIRMED_SUBSCRIPTIONS_SECRET_KEY } from '../../shared/subscriptions';
import {
  SUBSCRIPTION_PREFS_SECRET_KEY, editSubscriptionPrefs as editPrefsDocument, loadSubscriptionPrefs,
  type LoadedSubscriptionPrefs, type SubscriptionEdit, type SubscriptionPrefs,
} from '../../shared/subscription-prefs';
```
and add `SUBSCRIPTION_NEWS_SECRET_KEY` to the existing `import { LARGE_TX_OUTBOX_SECRET_KEY } from '../../shared/telegram';`.

2. In `KEYS`, after `confirmedSubscriptions: CONFIRMED_SUBSCRIPTIONS_SECRET_KEY,`:
```ts
  // The subscription document (1.60) has no plain setter — it is only ever
  // edited through editSubscriptionPrefs — and the companion writes the news
  // memo beside it. Both are the easy-to-forget shape; Reset must clear them.
  subscriptionPrefs: SUBSCRIPTION_PREFS_SECRET_KEY,
  subscriptionNewsSent: SUBSCRIPTION_NEWS_SECRET_KEY,
```

3. Replace the four methods `getHiddenSubscriptions` … `setConfirmedSubscriptions` (with their doc comments) by:
```ts
  /** The subscription document (shared/subscription-prefs.ts), or the legacy
   *  lists while none exists. Null when the host read itself fails: the card
   *  then starts from nothing hidden, and every edit still re-reads first. */
  async getSubscriptionPrefs(): Promise<LoadedSubscriptionPrefs | null> {
    try {
      return await loadSubscriptionPrefs((k) => this.ctx.api.secrets.get(k));
    } catch {
      return null;
    }
  }

  /** One edit, re-read immediately before the write so a change made from
   *  Telegram since this page loaded is kept; the legacy lists are mirrored.
   *  Rejects with SubscriptionPrefsUnreadableError, writing nothing, when the
   *  stored document is corrupt. */
  async editSubscriptionPrefs(edit: SubscriptionEdit): Promise<SubscriptionPrefs> {
    return editPrefsDocument(
      (k) => this.ctx.api.secrets.get(k),
      (k, v) => this.ctx.api.secrets.set(k, v),
      edit,
      new Date(),
    );
  }
```

- [ ] **Step 4: Implement the page, the tab and the adapter**

In `src/pages/SyncPage.tsx`:

1. Import:
```ts
import {
  emptySubscriptionPrefs, isUnreadablePrefsError, type LoadedSubscriptionPrefs, type SubscriptionEdit,
} from '../../shared/subscription-prefs';
```

2. In `refresh`'s `Promise.all([...])`, replace the two lines `store.getHiddenSubscriptions?.() ?? [],` and `store.getConfirmedSubscriptions?.() ?? [],` with `store.getSubscriptionPrefs?.() ?? null,`; change the destructuring to `([status, ledger, pool, cube, reports, layoutStored, subPrefs])`; replace the two `set…SubscriptionsState(…)` calls with `setSubscriptionPrefs(subPrefs ?? null);`.

3. Replace the two state blocks (`const [hiddenSubscriptions, …` through `onConfirmedSubscriptionsChange`'s closing `}, [store]);`) with:
```tsx
  const [subscriptionPrefs, setSubscriptionPrefs] = useState<LoadedSubscriptionPrefs | null>(null);
  /** One subscription edit. The store re-reads the stored document right
   *  before writing (a hide made from Telegram since this page loaded is
   *  kept), and the card then shows what was WRITTEN — never a local guess.
   *  A corrupt document refuses the write and the card says so; any other
   *  failure changes nothing, like every other setting on this page. */
  const onSubscriptionEdit = useCallback((edit: SubscriptionEdit) => {
    const pending = store.editSubscriptionPrefs?.(edit);
    if (!pending) return;
    pending
      .then((written) => setSubscriptionPrefs({ prefs: written, unreadable: false }))
      .catch((err) => {
        if (!isUnreadablePrefsError(err)) return;
        setSubscriptionPrefs((prev) => ({ prefs: prev?.prefs ?? emptySubscriptionPrefs(), unreadable: true }));
      });
  }, [store]);
```

4. On `<BudgetTab …>`, replace the four `hiddenSubscriptions…`/`confirmedSubscriptions…` props with:
```tsx
          subscriptionPrefs={subscriptionPrefs}
          onSubscriptionEdit={onSubscriptionEdit}
```

In `src/tabs/BudgetTab.tsx`:

1. Import `import type { LoadedSubscriptionPrefs, SubscriptionEdit } from '../../shared/subscription-prefs';`.

2. In `BudgetTabProps`, replace the comment `/** Subscription-card answers, owned by the page like layout is. */` and the four props under it with:
```ts
  /** The subscription document, owned by the page like layout is; null until loaded. */
  subscriptionPrefs?: LoadedSubscriptionPrefs | null;
  /** One edit to it. Absent → the card is read-only. */
  onSubscriptionEdit?: (edit: SubscriptionEdit) => void;
```

3. In the destructuring, replace `hiddenSubscriptions = [], onHiddenSubscriptionsChange,` and `confirmedSubscriptions = [], onConfirmedSubscriptionsChange,` with `subscriptionPrefs = null, onSubscriptionEdit,` (keep the other names).

4. In `subsProps`, replace the six subscription entries (`hiddenSubscriptions,` through `onRestoreSubscriptions: …,`) with:
```ts
    subscriptionPrefs,
    onSubscriptionEdit,
    // The Remind control's "reminders are sent by the companion" hint uses the
    // stale strip's own two-day test.
    companionStale: stale,
    onSetUpCompanion,
```

In `src/components/budget/ReportView.tsx`:

1. Import:
```ts
import {
  confirmKey, hideKey, unhideKey, type LoadedSubscriptionPrefs, type SubscriptionEdit,
} from '../../../shared/subscription-prefs';
```

2. Add to `ReportView`'s destructuring `subscriptionPrefs, onSubscriptionEdit, companionStale, onSetUpCompanion,` and to its props type:
```ts
  /** 1.60: the subscription document and its one edit path (Task 11 renders
   *  the new card from them; until then they feed the old one). */
  subscriptionPrefs?: LoadedSubscriptionPrefs | null;
  onSubscriptionEdit?: (edit: SubscriptionEdit) => void;
  /** The cube is over two days old (BudgetTab's STALE_MS). */
  companionStale?: boolean;
  onSetUpCompanion?: () => void;
```

3. Replace the `case 'subscriptions':` body with:
```tsx
      case 'subscriptions': {
        // Transitional: the document drives the pre-1.60 card until Task 11
        // replaces it. The old props remain only for ReportView.test.tsx.
        const prefs = subscriptionPrefs?.prefs;
        const edit = onSubscriptionEdit;
        body = (
          <Subscriptions
            cube={cube}
            full={hero}
            hidden={prefs ? prefs.hidden : hiddenSubscriptions}
            confirmed={prefs ? prefs.confirmed : confirmedSubscriptions}
            onHide={edit ? (name) => edit((p) => hideKey(p, name)) : onHideSubscription}
            onConfirm={edit ? (name) => edit((p) => confirmKey(p, name)) : onConfirmSubscription}
            onUnhide={edit ? (name) => edit((p) => unhideKey(p, name)) : onUnhideSubscription}
            onRestore={edit ? () => edit((p) => ({ ...p, hidden: [] })) : onRestoreSubscriptions}
          />
        );
        break;
      }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/utils/secrets.test.ts src/tabs/BudgetTab.test.tsx src/components/budget/ReportView.test.tsx src/pages`
Expected: PASS (`ReportView.test.tsx` and the SyncPage/copy-policy tests unchanged).

Run: `npm run type-check`
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/utils/secrets.ts src/utils/secrets.test.ts src/pages/SyncPage.tsx src/tabs/BudgetTab.tsx src/tabs/BudgetTab.test.tsx src/components/budget/ReportView.tsx
git commit -m "App: subscription choices are one re-read edit through the store, no snapshot writes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The card, from the roster — rows, groups, totals

**Files:**
- Create: `src/components/budget/SubscriptionsCard.tsx`
- Test: `src/components/budget/SubscriptionsCard.test.tsx` (create)
- Modify: `src/components/budget/ReportView.tsx` (delete the `Subscriptions` component ~line 352-566 and the Task 10 adapter; remove the six old props; drop `subscriptionSummary` from the `./report-data` import; drop the Task 10 `subscription-prefs` value imports)
- Test: `src/components/budget/ReportView.test.tsx` (replace the five subscription describes ~line 282-466 and `'subscription dismissal feels like a win (v1.43)'` ~line 537-547)
- Test: `src/tabs/BudgetTab.test.tsx` (replace Task 10's two subscription describes)
- Modify: `src/components/ui.tsx` (`ThemeStyles`, after the `.sfin-subs-celebrate` rule ~line 810)

**Why this split from Tasks 12–13:** the rows, groups and one-tap answers replace every pinned test of the old card at once; the inline controls (remind, rename, delete) and the hand-added form each bring their own UI and tests, and a reviewer can judge them separately.

**Interfaces:**
- Consumes: Task 1 (`acceptLink`, `declineLink`, `confirmKey`, `hideKey`, `unhideKey`, `emptySubscriptionPrefs`, `LoadedSubscriptionPrefs`, `SubscriptionEdit`), Task 2 (`buildRoster`, `formatRosterTotal`, `aboutDollars`, `rosterMoney`, `rosterPrice`, `rosterWhen`, `monthDay`, `localIsoDay`, `RosterEntry`), Task 10 (`ReportView`'s new props).
- Produces (`src/components/budget/SubscriptionsCard.tsx`):
  ```ts
  export interface SubscriptionsCardProps {
    cube: ReportCube; full?: boolean;
    subscriptionPrefs?: LoadedSubscriptionPrefs | null;
    onSubscriptionEdit?: (edit: SubscriptionEdit) => void;
    companionStale?: boolean; onSetUpCompanion?: () => void;
  }
  export const SUBSCRIPTIONS_UNREADABLE_NOTICE: string;
  export function rowMeta(e: RosterEntry): string;   // 'next Oct 15 · reminder 3d · added by you'
  export function SubscriptionsCard(props: SubscriptionsCardProps): React.JSX.Element;
  ```
  `ReportView`'s subscription props are now exactly `subscriptionPrefs`, `onSubscriptionEdit`, `companionStale`, `onSetUpCompanion`. With `subscriptionPrefs.unreadable` the card is read-only (no edit controls) under its notice; without `onSubscriptionEdit` it is read-only too.

**App copy (verbatim):** total `{formatRosterTotal} across {n}`; bills heading `Bills ≈ $61/mo`; maybes heading `Is this a subscription?`; hidden heading `Hidden` with `Restore`; grid card `{n} hidden — restore`; link row `Is HULU your Hulu?` with `Yes`/`No`; detail `On your statement as SPOTIFY`, `Last charges: Sep 15 $11.99 · …` or `No charge matched to it yet.`, button `Hide / I cancelled it` (aria-label `Hide <name>`); notice `Couldn't read your subscription settings, so changes are paused. This shows your earlier choices.`; empty states unchanged (`The companion looks for recurring charges after the next sync.`, `No monthly subscriptions detected — recurring monthly charges would show here.`).

- [ ] **Step 1: Write the failing tests**

Create `src/components/budget/SubscriptionsCard.test.tsx`:

```tsx
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SubscriptionsCard } from './SubscriptionsCard';
import { CUBE } from '../../../shared/report-cube.test';
import type { ReportCube } from '../../../shared/report-cube';
import type { DetectedSubscription } from '../../../shared/subscriptions';
import { emptySubscriptionPrefs, type SubscriptionEdit, type SubscriptionPrefs } from '../../../shared/subscription-prefs';

const NOW = new Date(2026, 9, 12, 9, 0, 0);
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

/** DetectedSubscription exactly as a 1.60 companion publishes it. */
const det = (name: string, over: Partial<DetectedSubscription> = {}): DetectedSubscription => ({
  name, monthlyCents: 1199, count: 4, lastDate: '2026-09-15', lastCents: over.monthlyCents ?? 1199, prevCents: 1199,
  creep: false, kind: 'subscription', recent: [{ date: '2026-09-15', cents: 1199 }], ...over,
});
const cubeWith = (subscriptions: DetectedSubscription[] | null, extra: Partial<ReportCube> = {}): ReportCube =>
  ({ ...CUBE, asOf: NOW.toISOString(), subscriptions, ...extra });
const loaded = (over: Partial<SubscriptionPrefs> = {}, unreadable = false) =>
  ({ prefs: { ...emptySubscriptionPrefs(), ...over }, unreadable });
/** Every edit the card handed up, applied in order to `base`. */
const applied = (spy: ReturnType<typeof vi.fn>, base: SubscriptionPrefs = emptySubscriptionPrefs()) =>
  spy.mock.calls.reduce((p: SubscriptionPrefs, call: unknown[]) => (call[0] as SubscriptionEdit)(p), base);
const HULU = { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly' as const, nextDate: '2026-10-20' };
const LINK = { manualId: 'hulu0001', merchant: 'HULU', date: '2026-09-19', cents: 999 };

describe('subscriptions card rows (1.60)', () => {
  it('rows carry the next date and, in words, the reminder and hand-added marks', () => {
    render(<SubscriptionsCard cube={cubeWith([det('SPOTIFY')])}
      subscriptionPrefs={loaded({ remind: { SPOTIFY: 3 }, manual: [HULU] })} onSubscriptionEdit={vi.fn()} />);
    expect(screen.getByText('next Oct 15 · reminder 3d')).toBeTruthy();
    expect(screen.getByText('next Oct 20 · added by you')).toBeTruthy();
    expect(screen.getByText('$11.99/mo')).toBeTruthy();
  });

  it('carries no emoji in its rows, headings and controls (app copy policy)', () => {
    const { container } = render(<SubscriptionsCard full
      cube={cubeWith(
        [det('SPOTIFY'), det('LG&E', { kind: 'bill', monthlyCents: 6149 }), det('MYSTERY BOX', { kind: 'possible', count: 2 }), det('QR LIBRARY', { monthlyCents: 499 })],
        { subscriptionLinks: [LINK] },
      )}
      subscriptionPrefs={loaded({ remind: { SPOTIFY: 3 }, manual: [HULU], hidden: ['QR LIBRARY'] })}
      onSubscriptionEdit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'SPOTIFY' }));
    const texts = Array.from(container.querySelectorAll(
      'button, label, .sfin-subs-meta, .sfin-subs-maybe-head, .sfin-subs-total, .sfin-subs-note, .sfin-subs-detail',
    )).map((el) => el.textContent ?? '');
    expect(texts.length).toBeGreaterThan(10);
    expect(texts.filter((t) => /\p{Extended_Pictographic}/u.test(t))).toEqual([]);
  });

  it('a row opens inline with its last three charges, and closes again', () => {
    const recent = [{ date: '2026-09-15', cents: 1199 }, { date: '2026-08-15', cents: 1199 }, { date: '2026-07-15', cents: 1199 }];
    render(<SubscriptionsCard cube={cubeWith([det('SPOTIFY', { recent })])} subscriptionPrefs={loaded()} onSubscriptionEdit={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: 'SPOTIFY' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Last charges: Sep 15 $11.99 · Aug 15 $11.99 · Jul 15 $11.99')).toBeTruthy();
    fireEvent.click(toggle);
    expect(screen.queryByText(/Last charges/)).toBeNull();
  });

  it('a renamed row says what the bank calls it', () => {
    render(<SubscriptionsCard cube={cubeWith([det('SPOTIFY')])} subscriptionPrefs={loaded({ names: { SPOTIFY: 'Spotify' } })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Spotify' }));
    expect(screen.getByText('On your statement as SPOTIFY')).toBeTruthy();
  });

  it('bills are their own group, out of the subscriptions total', () => {
    render(<SubscriptionsCard cube={cubeWith([det('SPOTIFY'), det('LG&E', { kind: 'bill', monthlyCents: 6149, lastDate: '2026-09-28' })])}
      subscriptionPrefs={loaded()} />);
    expect(screen.getByText('Bills ≈ $61/mo')).toBeTruthy();
    expect(screen.getByText('about $61/mo')).toBeTruthy();
    expect(screen.getByText('$11.99/mo across 1')).toBeTruthy();
  });

  it('a link suggestion row: Yes links it', () => {
    const onEdit = vi.fn();
    const base = loaded({ manual: [HULU] });
    render(<SubscriptionsCard cube={cubeWith([], { subscriptionLinks: [LINK] })} subscriptionPrefs={base} onSubscriptionEdit={onEdit} />);
    expect(screen.getByText('Is HULU your Hulu?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, HULU is Hulu' }));
    expect(applied(onEdit, base.prefs).manual[0]).toMatchObject({ merchant: 'HULU', nextDate: '2026-10-19' });
  });

  it('a link suggestion row: No sticks', () => {
    const onEdit = vi.fn();
    const base = loaded({ manual: [HULU] });
    render(<SubscriptionsCard cube={cubeWith([], { subscriptionLinks: [LINK] })} subscriptionPrefs={base} onSubscriptionEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: 'No, HULU is not Hulu' }));
    expect(applied(onEdit, base.prefs).declinedLinks).toEqual(['hulu0001|HULU']);
  });

  it('an unreadable document: a one-line notice, the earlier hides still applied, and no controls', () => {
    render(<SubscriptionsCard cube={cubeWith([det('SPOTIFY'), det('QR LIBRARY', { monthlyCents: 499 })])}
      subscriptionPrefs={loaded({ hidden: ['QR LIBRARY'] }, true)} onSubscriptionEdit={vi.fn()} />);
    expect(screen.getByText("Couldn't read your subscription settings, so changes are paused. This shows your earlier choices.")).toBeTruthy();
    expect(screen.queryByText('QR LIBRARY')).toBeNull();
    expect(screen.queryByRole('button', { name: /hidden — restore/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'SPOTIFY' }));
    expect(screen.queryByRole('button', { name: 'Hide SPOTIFY' })).toBeNull();
  });

  it('an older companion that could not look: hand-added rows still render, with the hint', () => {
    render(<SubscriptionsCard cube={cubeWith(null)} subscriptionPrefs={loaded({ manual: [HULU] })} onSubscriptionEdit={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Hulu' })).toBeTruthy();
    expect(screen.getByText('The companion looks for recurring charges after the next sync.')).toBeTruthy();
  });
});
```

In `src/components/budget/ReportView.test.tsx`: change the vitest import to `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';`, add

```ts
import type { DetectedSubscription } from '../../../shared/subscriptions';
import {
  emptySubscriptionPrefs, type LoadedSubscriptionPrefs, type SubscriptionEdit, type SubscriptionPrefs,
} from '../../../shared/subscription-prefs';
```

and replace the describes `'subscriptions card'`, `'subscriptions card: dismissals'`, `'subscriptions card: confirm/ignore (v1.37)'`, `'subscriptions card: watch + per-item restore (v1.38)'`, `'subscriptions card: recent months (v1.39)'` and `'subscription dismissal feels like a win (v1.43)'` with:

```tsx
// ── Subscriptions: since 1.60 rendered from the shared roster ─────────────
const SUB_NOW = new Date(2026, 9, 12, 9, 0, 0);
const useSubNow = () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(SUB_NOW); });
  afterEach(() => { vi.useRealTimers(); });
};
const prefsWith = (over: Partial<SubscriptionPrefs> = {}): LoadedSubscriptionPrefs =>
  ({ prefs: { ...emptySubscriptionPrefs(), ...over }, unreadable: false });
const applied = (spy: ReturnType<typeof vi.fn>, base: SubscriptionPrefs = emptySubscriptionPrefs()) =>
  spy.mock.calls.reduce((p: SubscriptionPrefs, call: unknown[]) => (call[0] as SubscriptionEdit)(p), base);
const sub = (over: Partial<DetectedSubscription> = {}): DetectedSubscription => ({
  name: 'SPOTIFY', monthlyCents: 1099, count: 5, lastDate: '2026-09-20', lastCents: 1099, creep: false,
  kind: 'subscription', ...over,
});

describe('subscriptions card', () => {
  useSubNow();

  it('waits politely while the companion has not looked yet', () => {
    view('subscriptions');
    expect(screen.getByText(/after the next sync/i)).toBeTruthy();
  });

  it('lists each subscription with its monthly price and totals them', () => {
    view('subscriptions', { ...fresh(), subscriptions: [sub(), sub({ name: 'ADOBE', monthlyCents: 5499, lastCents: 5499 })] });
    expect(screen.getByText('SPOTIFY')).toBeTruthy();
    expect(screen.getByText('ADOBE')).toBeTruthy();
    expect(screen.getByText(/\$65\.98\/mo across 2/)).toBeTruthy();
  });

  it('marks price creep with the old and new price', () => {
    view('subscriptions', { ...fresh(), subscriptions: [sub({ lastCents: 1199, creep: true })] });
    expect(screen.getByText('$11.99 ▲ was $10.99')).toBeTruthy();
  });

  it('an empty roster reads as a clean bill, not an error', () => {
    view('subscriptions', { ...fresh(), subscriptions: [] });
    expect(screen.getByText(/no monthly subscriptions detected/i)).toBeTruthy();
  });
});

describe('subscriptions card: hiding', () => {
  useSubNow();
  const QR = sub({ name: 'QR LIBRARY', monthlyCents: 999, lastCents: 999 });

  it('a row opens to Hide / I cancelled it, which hides it — and celebrates the money freed', () => {
    const onEdit = vi.fn();
    render(<ReportView id="subscriptions" cube={{ ...fresh(), subscriptions: [sub(), QR] }} customReports={[]}
      subscriptionPrefs={prefsWith()} onSubscriptionEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: 'QR LIBRARY' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide QR LIBRARY' }));
    expect(applied(onEdit).hidden).toEqual(['QR LIBRARY']);
    expect(screen.getByText(/\$9\.99\/mo back in your pocket/i)).toBeTruthy();
  });

  it('hidden names leave the roster and the total, with a way back', () => {
    const onEdit = vi.fn();
    const base = prefsWith({ hidden: ['QR LIBRARY'] });
    render(<ReportView id="subscriptions" cube={{ ...fresh(), subscriptions: [sub(), QR] }} customReports={[]}
      subscriptionPrefs={base} onSubscriptionEdit={onEdit} />);
    expect(screen.queryByText('QR LIBRARY')).toBeNull();
    expect(screen.getByText(/\$10\.99\/mo across 1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /1 hidden — restore/i }));
    expect(applied(onEdit, base.prefs).hidden).toEqual([]);
  });

  it('without an edit handler the card is read-only, as in older hosts', () => {
    render(<ReportView id="subscriptions" cube={{ ...fresh(), subscriptions: [sub()] }} customReports={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'SPOTIFY' }));
    expect(screen.queryByRole('button', { name: /hide/i })).toBeNull();
  });
});

describe('subscriptions card: bills and maybes (1.60)', () => {
  useSubNow();

  it('bills are their own group, out of the total; maybes are still a question', () => {
    const onEdit = vi.fn();
    render(<ReportView id="subscriptions" customReports={[]} cube={{ ...fresh(), subscriptions: [
      sub(),
      sub({ name: 'DUKE ENERGY', monthlyCents: 9900, lastCents: 9900, prevCents: 5420, kind: 'bill' }),
      sub({ name: 'MYSTERY BOX CLUB', monthlyCents: 1500, lastCents: 1500, prevCents: 1500, kind: 'possible' }),
    ] }} subscriptionPrefs={prefsWith()} onSubscriptionEdit={onEdit} />);
    expect(screen.getByText('Bills ≈ $99/mo')).toBeTruthy();
    expect(screen.getByText('about $99/mo')).toBeTruthy();
    expect(screen.getByText(/\$10\.99\/mo across 1/)).toBeTruthy();
    expect(screen.getByText(/is this a subscription\?/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, MYSTERY BOX CLUB is a subscription' }));
    fireEvent.click(screen.getByRole('button', { name: 'No, ignore MYSTERY BOX CLUB' }));
    expect(applied(onEdit)).toMatchObject({ confirmed: ['MYSTERY BOX CLUB'], hidden: ['MYSTERY BOX CLUB'] });
  });

  it('a confirmed candidate joins the roster and the total for good', () => {
    render(<ReportView id="subscriptions" customReports={[]} cube={{ ...fresh(), subscriptions: [
      sub(), sub({ name: 'DUKE ENERGY', monthlyCents: 9900, lastCents: 9900, kind: 'bill' }),
    ] }} subscriptionPrefs={prefsWith({ confirmed: ['DUKE ENERGY'] })} />);
    expect(screen.queryByText(/Bills ≈/)).toBeNull();
    expect(screen.getByText(/\$109\.99\/mo across 2/)).toBeTruthy();
  });

  it('rows without a kind (older companion) count as subscriptions', () => {
    render(<ReportView id="subscriptions" customReports={[]} cube={{ ...fresh(), subscriptions: [sub({ kind: undefined })] }} />);
    expect(screen.getByText(/\$10\.99\/mo across 1/)).toBeTruthy();
    expect(screen.queryByText(/is this a subscription\?/i)).toBeNull();
  });

  it('an unchanged bill shows one price — no arrow, no "varies"', () => {
    render(<ReportView id="subscriptions" customReports={[]} cube={{ ...fresh(), subscriptions: [
      sub({ name: 'RENT LLC', monthlyCents: 90000, count: 4, lastDate: '2026-09-25', lastCents: 90000, prevCents: 90000, kind: 'bill' }),
    ] }} subscriptionPrefs={prefsWith()} onSubscriptionEdit={vi.fn()} />);
    expect(screen.getByText('about $900/mo')).toBeTruthy();
    expect(screen.queryByText(/varies/)).toBeNull();
    expect(screen.queryByText(/→/)).toBeNull();
  });
});

describe('subscriptions card: watch + per-item restore', () => {
  useSubNow();
  const cubeWithMerchants = () => ({
    ...fresh(),
    subscriptions: [sub()],
    merchants: [[], [
      { name: 'ANTHROPIC* CLAUDE SUB', cents: 2000, count: 1 },
      { name: 'CHIPOTLE', cents: 4500, count: 3 },
    ]],
  });

  it('a confirmed name with no detection yet shows as watching, priced by its charges', () => {
    render(<ReportView id="subscriptions" customReports={[]} cube={cubeWithMerchants()}
      subscriptionPrefs={prefsWith({ confirmed: ['ANTHROPIC* CLAUDE SUB'] })} />);
    expect(screen.getByText('ANTHROPIC* CLAUDE SUB')).toBeTruthy();
    expect(screen.getByText('$20/mo')).toBeTruthy();
    expect(screen.getByText('watching')).toBeTruthy();
    expect(screen.getByText(/\$30\.99\/mo across 2/)).toBeTruthy();
  });

  it('the open view offers recent merchants to watch', () => {
    const onEdit = vi.fn();
    render(<ReportView id="subscriptions" customReports={[]} cube={cubeWithMerchants()} hero
      subscriptionPrefs={prefsWith()} onSubscriptionEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Watch ANTHROPIC* CLAUDE SUB' }));
    expect(applied(onEdit).confirmed).toEqual(['ANTHROPIC* CLAUDE SUB']);
  });

  it('the grid card does not carry the watch list — it is drill-in furniture', () => {
    render(<ReportView id="subscriptions" customReports={[]} cube={cubeWithMerchants()}
      subscriptionPrefs={prefsWith()} onSubscriptionEdit={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /watch anthropic/i })).toBeNull();
  });

  it('the open view restores hidden rows one at a time', () => {
    const onEdit = vi.fn();
    const base = prefsWith({ hidden: ['QR LIBRARY'] });
    render(<ReportView id="subscriptions" customReports={[]} hero
      cube={{ ...cubeWithMerchants(), subscriptions: [sub(), sub({ name: 'QR LIBRARY', monthlyCents: 999, lastCents: 999 })] }}
      subscriptionPrefs={base} onSubscriptionEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore QR LIBRARY' }));
    expect(applied(onEdit, base.prefs).hidden).toEqual([]);
  });

  it('watch list and watched pricing look back past the current month', () => {
    // Live miss: a mid-August charge was unwatchable on September 2nd because
    // only the newest month's merchants were offered.
    const cube = {
      ...fresh(),
      subscriptions: [],
      merchants: [
        [{ name: 'ANTHROPIC* CLAUDE SUB', cents: 2000, count: 1 }],
        [{ name: 'CHIPOTLE', cents: 4500, count: 3 }],
      ],
    };
    const onEdit = vi.fn();
    const { unmount } = render(<ReportView id="subscriptions" customReports={[]} cube={cube} hero
      subscriptionPrefs={prefsWith()} onSubscriptionEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Watch ANTHROPIC* CLAUDE SUB' }));
    expect(applied(onEdit).confirmed).toEqual(['ANTHROPIC* CLAUDE SUB']);
    unmount();
    render(<ReportView id="subscriptions" customReports={[]} cube={cube}
      subscriptionPrefs={prefsWith({ confirmed: ['ANTHROPIC* CLAUDE SUB'] })} />);
    expect(screen.getByText('$20/mo')).toBeTruthy();
  });
});
```

In `src/tabs/BudgetTab.test.tsx`, replace Task 10's `describe('subscription dismissals end to end', …)` and `describe('subscription confirmation end to end', …)` with:

```tsx
describe('subscription edits end to end', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 9, 12, 9, 0, 0)); });
  afterEach(() => { vi.useRealTimers(); });
  const det = (name: string, over: Record<string, unknown> = {}) => ({
    name, monthlyCents: 1099, count: 5, lastDate: '2026-09-20', lastCents: 1099, creep: false, kind: 'subscription', ...over,
  });
  const withCube = (props: ReturnType<typeof makeProps>, subscriptions: unknown[]) => {
    (props.store as any).getReportCube = vi.fn(async () => ({ ...CUBE, asOf: new Date().toISOString(), subscriptions }));
  };

  it('hiding on the card is ONE edit through the store, and the row goes', async () => {
    const props = makeProps();
    const subs = subscriptionStore();
    withSubscriptions(props, subs);
    withCube(props, [det('SPOTIFY'), det('QR LIBRARY', { monthlyCents: 999, lastCents: 999 })]);
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'QR LIBRARY' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide QR LIBRARY' }));
    expect(subs.editSubscriptionPrefs).toHaveBeenCalledTimes(1);
    expect(subs.current().hidden).toEqual(['QR LIBRARY']);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'QR LIBRARY' })).toBeNull());
    expect(screen.getByRole('button', { name: 'SPOTIFY' })).toBeInTheDocument();
  });

  it('the card follows what was WRITTEN — a hide made from Telegram since the page loaded comes along', async () => {
    const props = makeProps();
    const subs = subscriptionStore();
    withSubscriptions(props, subs);
    withCube(props, [det('SPOTIFY'), det('QR LIBRARY', { monthlyCents: 999, lastCents: 999 }), det('NETFLIX', { monthlyCents: 1549, lastCents: 1549 })]);
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));

    subs.elsewhere((p) => hideKey(p, 'NETFLIX'));
    fireEvent.click(screen.getByRole('button', { name: 'QR LIBRARY' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide QR LIBRARY' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'NETFLIX' })).toBeNull());
  });

  it('a maybe answered Yes joins the roster', async () => {
    const props = makeProps();
    const subs = subscriptionStore();
    withSubscriptions(props, subs);
    withCube(props, [det('MYSTERY BOX', { monthlyCents: 1500, lastCents: 1500, count: 2, kind: 'possible' })]);
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Yes, MYSTERY BOX is a subscription' }));
    expect(subs.current().confirmed).toEqual(['MYSTERY BOX']);
    await waitFor(() => expect(screen.queryByText(/is this a subscription\?/i)).toBeNull());
    expect(screen.getByText(/\$15\/mo across 1/)).toBeInTheDocument();
  });

  it('a document found corrupt on write: the card says so and stops offering changes', async () => {
    // Readable when the page loaded, corrupt by the time of the edit (another
    // writer, a partial write): SyncPage's refusal path, not the load path.
    const props = makeProps();
    Object.assign(props.store, {
      getSubscriptionPrefs: vi.fn(async () => ({ prefs: emptySubscriptionPrefs(), unreadable: false })),
      editSubscriptionPrefs: vi.fn(async () => { throw new SubscriptionPrefsUnreadableError(); }),
    });
    withCube(props, [det('SPOTIFY')]);
    render(<SyncPage {...props} />);
    await waitFor(() => expect(reportIds().length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'SPOTIFY' }));
    fireEvent.click(screen.getByRole('button', { name: 'Hide SPOTIFY' }));
    expect(await screen.findByText(/Couldn't read your subscription settings/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'SPOTIFY' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'SPOTIFY' }));
    expect(screen.queryByRole('button', { name: 'Hide SPOTIFY' })).toBeNull();
  });
});
```

(Extend this file's subscription-prefs import with `SubscriptionPrefsUnreadableError`, and its vitest import with `beforeEach, afterEach` if they are not already imported.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/budget/SubscriptionsCard.test.tsx src/components/budget/ReportView.test.tsx src/tabs/BudgetTab.test.tsx`
Expected: FAIL — `Failed to resolve import "./SubscriptionsCard"`, and the old card has no `Hide …` buttons or `Bills ≈` group.

- [ ] **Step 3: Implement the card**

Create `src/components/budget/SubscriptionsCard.tsx`:

```tsx
/**
 * src/components/budget/SubscriptionsCard.tsx
 *
 * The Subscriptions report, rendered from the shared roster
 * (shared/subscription-roster.ts) — the same names, prices and totals as the
 * bot's /subscriptions, because both render from one function. Every change is
 * ONE edit handed up (`onSubscriptionEdit`); the page applies it through the
 * store, which re-reads the stored document right before writing.
 *
 * App copy carries no emoji (src/pages/copy-policy.test.tsx): rows say
 * "reminder 3d" and "added by you" where Telegram shows 🔔 and ✍️. The 🎉
 * celebration line predates the rule and stays.
 */
import React from 'react';
import { Button } from '../ui';
import type { ReportCube } from '../../../shared/report-cube';
import {
  acceptLink, confirmKey, declineLink, emptySubscriptionPrefs, hideKey, unhideKey,
  type LoadedSubscriptionPrefs, type SubscriptionEdit,
} from '../../../shared/subscription-prefs';
import {
  aboutDollars, buildRoster, formatRosterTotal, localIsoDay, monthDay, rosterMoney, rosterPrice, rosterWhen,
  type RosterEntry,
} from '../../../shared/subscription-roster';

export interface SubscriptionsCardProps {
  cube: ReportCube;
  /** The open (full-screen) view: the hidden list and the watch list. */
  full?: boolean;
  subscriptionPrefs?: LoadedSubscriptionPrefs | null;
  /** Absent → read-only, as in older hosts. */
  onSubscriptionEdit?: (edit: SubscriptionEdit) => void;
  /** The cube is over two days old: reminders may not be going out. */
  companionStale?: boolean;
  /** Opens Settings on the background-sync card. */
  onSetUpCompanion?: () => void;
}

export const SUBSCRIPTIONS_UNREADABLE_NOTICE =
  "Couldn't read your subscription settings, so changes are paused. This shows your earlier choices.";
const NOT_LOOKED_YET = 'The companion looks for recurring charges after the next sync.';
const NOTHING_DETECTED = 'No monthly subscriptions detected — recurring monthly charges would show here.';

/** Row meta, in words: "next Oct 15 · reminder 3d · added by you". */
export function rowMeta(e: RosterEntry): string {
  return [rosterWhen(e), e.remind ? `reminder ${e.remind}d` : null, e.source === 'manual' ? 'added by you' : null]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

/** The newest three months' merchants, newest first, one per name — the
 *  watch list looks back past the current month (the v1.39 Anthropic miss). */
function recentMerchants(cube: ReportCube): Array<{ name: string; cents: number; count: number }> {
  const out: Array<{ name: string; cents: number; count: number }> = [];
  const seen = new Set<string>();
  for (const month of cube.merchants.slice(-3).reverse()) {
    for (const m of month) {
      if (seen.has(m.name)) continue;
      seen.add(m.name);
      out.push(m);
    }
  }
  return out;
}

export function SubscriptionsCard({
  cube, full = false, subscriptionPrefs, onSubscriptionEdit, companionStale = false, onSetUpCompanion,
}: SubscriptionsCardProps) {
  // A corrupt document refuses every write, so the card offers none: it is
  // read-only under the notice instead of celebrating a hide that never saved.
  const edit = subscriptionPrefs?.unreadable ? undefined : onSubscriptionEdit;
  // Hooks first: every early return below comes after them.
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const [celebrate, setCelebrate] = React.useState<{ name: string; price: string } | null>(null);
  const prefs = subscriptionPrefs?.prefs ?? null;
  const roster = React.useMemo(() => buildRoster({
    detected: cube.subscriptions ?? null,
    merchants: cube.merchants,
    links: cube.subscriptionLinks ?? [],
    prefs: prefs ?? emptySubscriptionPrefs(),
    today: localIsoDay(new Date()),
  }), [cube, prefs]);

  const listed = roster.subscriptions.length + roster.bills.length + roster.maybes.length;
  if (!full && listed === 0 && roster.linkSuggestions.length === 0) {
    if (!roster.detectionAvailable) return <div className="sfin-subtle">{NOT_LOOKED_YET}</div>;
    // The OPEN view keeps going: an empty roster is when "watch a merchant" is the point.
    if (roster.hidden.length === 0) return <div className="sfin-subtle">{NOTHING_DETECTED}</div>;
  }

  const hide = (e: RosterEntry) => {
    setCelebrate({ name: e.displayName, price: rosterPrice(e) });
    setOpenKey(null);
    edit?.((p) => hideKey(p, e.key));
  };

  const detail = (e: RosterEntry) => (
    <div className="sfin-subs-detail">
      {e.bankName && <div className="sfin-subtle">On your statement as {e.bankName}</div>}
      <div>
        {e.recent.length > 0
          ? `Last charges: ${e.recent.map((r) => `${monthDay(r.date)} ${rosterMoney(r.cents)}`).join(' · ')}`
          : 'No charge matched to it yet.'}
      </div>
      {edit && e.source !== 'manual' && (
        <div className="sfin-subs-actions">
          <Button variant="outline" aria-label={`Hide ${e.displayName}`} onClick={() => hide(e)}>Hide / I cancelled it</Button>
        </div>
      )}
    </div>
  );

  const row = (e: RosterEntry) => {
    const open = openKey === e.key;
    return (
      <div key={e.key} className="sfin-subs-item">
        <div className="sfin-subs-row">
          <span className="sfin-subs-label">
            <button type="button" className="sfin-subs-toggle" aria-expanded={open}
              onClick={() => setOpenKey(open ? null : e.key)}>
              {e.displayName}
            </button>
            <span className="sfin-subs-meta">{rowMeta(e)}</span>
          </span>
          <span className="sfin-subs-price">
            {e.creep
              ? <span className="sfin-subs-creep">{rosterMoney(e.creep.toCents)} ▲ was {rosterMoney(e.creep.fromCents)}</span>
              : rosterPrice(e)}
          </span>
        </div>
        {open && detail(e)}
      </div>
    );
  };

  return (
    <div className="sfin-subs">
      {subscriptionPrefs?.unreadable && <div className="sfin-subs-note">{SUBSCRIPTIONS_UNREADABLE_NOTICE}</div>}
      {roster.linkSuggestions.map((s) => (
        <div key={`${s.manualId}|${s.merchant}`} className="sfin-subs-row sfin-subs-link">
          <span className="sfin-subs-name">Is {s.merchant} your {s.manualName}?</span>
          <span className="sfin-subs-price">{rosterMoney(s.cents)} on {monthDay(s.date)}</span>
          {edit && (
            <>
              <button type="button" className="sfin-subs-answer" aria-label={`Yes, ${s.merchant} is ${s.manualName}`}
                onClick={() => edit((p) => acceptLink(p, s))}>Yes</button>
              <button type="button" className="sfin-subs-answer" aria-label={`No, ${s.merchant} is not ${s.manualName}`}
                onClick={() => edit((p) => declineLink(p, s.manualId, s.merchant))}>No</button>
            </>
          )}
        </div>
      ))}
      {!roster.detectionAvailable && <div className="sfin-subtle">{NOT_LOOKED_YET}</div>}
      {roster.subscriptions.map(row)}
      {celebrate && (
        <div className="sfin-subs-celebrate" role="status">
          🎉 {celebrate.name} cancelled — that&apos;s {celebrate.price} back in your pocket.
        </div>
      )}
      <div className="sfin-subs-total">{formatRosterTotal(roster)} across {roster.subscriptions.length}</div>
      {roster.bills.length > 0 && (
        <>
          <div className="sfin-subs-maybe-head">Bills ≈ {aboutDollars(roster.billsMonthlyCents)}/mo</div>
          {roster.bills.map(row)}
        </>
      )}
      {roster.maybes.length > 0 && (
        <>
          <div className="sfin-subs-maybe-head">Is this a subscription?</div>
          {roster.maybes.map((e) => (
            <div key={e.key} className="sfin-subs-row">
              <span className="sfin-subs-name">{e.displayName}</span>
              <span className="sfin-subs-price">{rosterPrice(e)}</span>
              {edit && (
                <>
                  <button type="button" className="sfin-subs-answer" aria-label={`Yes, ${e.displayName} is a subscription`}
                    title="Count it as a subscription" onClick={() => edit((p) => confirmKey(p, e.key))}>✓</button>
                  <button type="button" className="sfin-subs-answer" aria-label={`No, ignore ${e.displayName}`}
                    title="Never show this here" onClick={() => edit((p) => hideKey(p, e.key))}>✕</button>
                </>
              )}
            </div>
          ))}
        </>
      )}
      {!full && roster.hidden.length > 0 && edit && (
        <Button variant="ghost" onClick={() => edit((p) => roster.hidden.reduce((acc, e) => unhideKey(acc, e.key), p))}>
          {roster.hidden.length} hidden — restore
        </Button>
      )}
      {full && roster.hidden.length > 0 && (
        <>
          <div className="sfin-subs-maybe-head">Hidden</div>
          {roster.hidden.map((e) => (
            <div key={e.key} className="sfin-subs-row sfin-subs-row--muted">
              <span className="sfin-subs-name">{e.displayName}</span>
              <span className="sfin-subs-price">{rosterPrice(e)}</span>
              {edit && (
                <button type="button" className="sfin-subs-answer" aria-label={`Restore ${e.displayName}`}
                  onClick={() => edit((p) => unhideKey(p, e.key))}>Restore</button>
              )}
            </div>
          ))}
        </>
      )}
      {full && edit && (() => {
        const known = new Set<string>([
          ...(cube.subscriptions ?? []).map((s) => s.name),
          ...(prefs?.confirmed ?? []),
          ...(prefs?.hidden ?? []),
          ...(prefs?.manual ?? []).flatMap((m) => (m.merchant ? [m.merchant] : [])),
        ]);
        const watchable = recentMerchants(cube).filter((m) => !known.has(m.name)).slice(0, 12);
        if (watchable.length === 0) return null;
        return (
          <>
            <div className="sfin-subs-maybe-head">Watch a merchant</div>
            <div className="sfin-subtle">
              One charge so far, or something you know recurs — watching counts it here from now on.
            </div>
            {watchable.map((m) => (
              <div key={m.name} className="sfin-subs-row sfin-subs-row--muted">
                <span className="sfin-subs-name">{m.name}</span>
                <span className="sfin-subs-price">{rosterMoney(Math.round(m.cents / Math.max(1, m.count)))}</span>
                <button type="button" className="sfin-subs-answer" aria-label={`Watch ${m.name}`}
                  title="Treat as a subscription" onClick={() => edit((p) => confirmKey(p, m.name))}>+ Watch</button>
              </div>
            ))}
          </>
        );
      })()}
    </div>
  );
}
```

(`companionStale` and `onSetUpCompanion` are used from Task 12.)

In `src/components/budget/ReportView.tsx`:

1. Delete the whole `function Subscriptions(…) { … }` (from its signature to its closing brace, just above the `/** The drill-down: …` comment).
2. Remove `subscriptionSummary` from the `./report-data` import; replace the Task 10 import from `shared/subscription-prefs` with `import type { LoadedSubscriptionPrefs, SubscriptionEdit } from '../../../shared/subscription-prefs';` and add `import { SubscriptionsCard } from './SubscriptionsCard';`.
3. From `ReportView`'s destructuring and props type, remove `hiddenSubscriptions`, `confirmedSubscriptions`, `onHideSubscription`, `onConfirmSubscription`, `onUnhideSubscription`, `onRestoreSubscriptions` and the comment `/** Subscriptions-card answers; the card is read-only without handlers. */`. Update the Task 10 comment above `subscriptionPrefs?` to: `/** The subscription document and its one edit path; the card is read-only without the edit. */`.
4. Replace the `case 'subscriptions': { … }` block with:
```tsx
      case 'subscriptions':
        body = (
          <SubscriptionsCard
            cube={cube}
            full={hero}
            subscriptionPrefs={subscriptionPrefs}
            onSubscriptionEdit={onSubscriptionEdit}
            companionStale={companionStale}
            onSetUpCompanion={onSetUpCompanion}
          />
        );
        break;
```

In `src/components/ui.tsx`, in `ThemeStyles`, directly after the `.sfin-subs-celebrate { … }` line, add (each simple selector exactly once — `theme-styles.test.ts` enforces it):

```css
/* 1.60 roster card: a row's name opens it inline. */
.sfin-subs-item { display: flex; flex-direction: column; }
.sfin-subs-label { display: flex; flex-direction: column; min-width: 0; }
.sfin-subs-toggle { border: none; background: transparent; color: var(--foreground); padding: 0; font: inherit; text-align: left; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sfin-subs-toggle:hover { text-decoration: underline; text-underline-offset: 3px; }
.sfin-subs-meta { font-size: var(--sfin-sz-xs); color: var(--muted-foreground); }
.sfin-subs-detail { display: flex; flex-direction: column; gap: 8px; margin: 2px 0 8px; padding: 8px 0 8px 12px; border-left: 2px solid var(--border); font-size: var(--sfin-sz-sm); }
.sfin-subs-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.sfin-subs-note { font-size: var(--sfin-sz-sm); color: var(--sfin-warn); }
.sfin-subs-link { background: color-mix(in srgb, var(--sfin-s0) 8%, transparent); border-radius: var(--sfin-rad-xs); padding: 4px 6px; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/budget src/tabs/BudgetTab.test.tsx src/components/theme-styles.test.ts src/pages`
Expected: PASS.

Run: `npm run type-check`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/budget/SubscriptionsCard.tsx src/components/budget/SubscriptionsCard.test.tsx src/components/budget/ReportView.tsx src/components/budget/ReportView.test.tsx src/tabs/BudgetTab.test.tsx src/components/ui.tsx
git commit -m "App: Subscriptions card renders from the shared roster — bills group, link row, next dates

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The card's inline controls — remind, rename, delete

**Files:**
- Modify: `src/components/budget/SubscriptionsCard.tsx`
- Test: `src/components/budget/SubscriptionsCard.test.tsx` (append)
- Modify: `src/components/ui.tsx` (after the Task 11 rules)

**Interfaces:**
- Consumes: Task 1 (`setRemind`, `renameKey`, `deleteManual`, `restoreDeleted`, `RemindDays`), Task 7 (`parseSubscriptionName`, `SUB_NAME_HINT`), Task 11 (the card, `detail`, `hide`).
- Produces (module-private in `SubscriptionsCard.tsx`): `const REMIND_CHIPS: Array<{ label: 'Off' | '1d' | '3d' | '7d'; days: RemindDays | null }>` (reused by Task 13), `function RenameField(…)`.

**App copy (verbatim):** Remind group `Remind` with chips `Off`, `1d`, `3d`, `7d` (group aria-label `Remind before <name> charges`); stale hint `Reminders are sent by the background companion, and it hasn't published in over two days.` with button `Open background sync settings`; rename input aria-label `New name for <name>`, button `Save name`, error `Type a name, up to 40 characters.`; hand-added `Delete` (aria-label `Delete <name>`); after a delete, status `Deleted <name>.` with `Undo`.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/budget/SubscriptionsCard.test.tsx` (add `within` to the `@testing-library/react` import):

```tsx
describe('subscriptions card: reminders, rename, delete (1.60)', () => {
  it('the Remind control is Off · 1d · 3d · 7d, the current one pressed', () => {
    const onEdit = vi.fn();
    render(<SubscriptionsCard cube={cubeWith([det('SPOTIFY')])} subscriptionPrefs={loaded({ remind: { SPOTIFY: 7 } })} onSubscriptionEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: 'SPOTIFY' }));
    const group = screen.getByRole('group', { name: 'Remind before SPOTIFY charges' });
    expect(within(group).getAllByRole('button').map((b) => [b.textContent, b.getAttribute('aria-pressed')])).toEqual([
      ['Off', 'false'], ['1d', 'false'], ['3d', 'false'], ['7d', 'true'],
    ]);
    fireEvent.click(within(group).getByRole('button', { name: '3d' }));
    expect(applied(onEdit).remind).toEqual({ SPOTIFY: 3 });
  });

  it('says reminders need the companion when it has gone quiet, with the way to its settings', () => {
    const onSetUp = vi.fn();
    const { unmount } = render(<SubscriptionsCard cube={cubeWith([det('SPOTIFY')])} subscriptionPrefs={loaded()}
      onSubscriptionEdit={vi.fn()} companionStale onSetUpCompanion={onSetUp} />);
    fireEvent.click(screen.getByRole('button', { name: 'SPOTIFY' }));
    expect(screen.getByText(/Reminders are sent by the background companion/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open background sync settings' }));
    expect(onSetUp).toHaveBeenCalled();
    unmount();
    render(<SubscriptionsCard cube={cubeWith([det('SPOTIFY')])} subscriptionPrefs={loaded()} onSubscriptionEdit={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'SPOTIFY' }));
    expect(screen.queryByText(/Reminders are sent by the background companion/)).toBeNull();
  });

  it('renames inline; a blank name is refused with the hint the bot gives', () => {
    const onEdit = vi.fn();
    render(<SubscriptionsCard cube={cubeWith([det('SPOTIFY')])} subscriptionPrefs={loaded()} onSubscriptionEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: 'SPOTIFY' }));
    const field = screen.getByLabelText('New name for SPOTIFY');
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(screen.getByRole('alert').textContent).toBe('Type a name, up to 40 characters.');
    expect(onEdit).not.toHaveBeenCalled();
    fireEvent.change(field, { target: { value: ' Spotify Duo ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    expect(applied(onEdit).names).toEqual({ SPOTIFY: 'Spotify Duo' });
  });

  it('a hand-added entry is deleted, not hidden — with Undo', () => {
    const onEdit = vi.fn();
    const base = loaded({ manual: [HULU] });
    render(<SubscriptionsCard cube={cubeWith([])} subscriptionPrefs={base} onSubscriptionEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hulu' }));
    expect(screen.queryByRole('button', { name: /^Hide/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Hulu' }));
    expect(applied(onEdit, base.prefs).manual).toEqual([]);
    expect(screen.getByRole('status').textContent).toContain('Deleted Hulu.');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(applied(onEdit, base.prefs).manual).toEqual([HULU]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/budget/SubscriptionsCard.test.tsx`
Expected: FAIL — no `Remind before SPOTIFY charges` group.

- [ ] **Step 3: Implement**

In `src/components/budget/SubscriptionsCard.tsx`:

1. Imports: `import { Button, Input } from '../ui';`; add `deleteManual, renameKey, restoreDeleted, setRemind, type RemindDays` to the `shared/subscription-prefs` import; add `import { parseSubscriptionName, SUB_NAME_HINT } from '../../../shared/telegram-commands';`.

2. Above `export function SubscriptionsCard`, add:
```tsx
const REMIND_CHIPS: Array<{ label: 'Off' | '1d' | '3d' | '7d'; days: RemindDays | null }> = [
  { label: 'Off', days: null }, { label: '1d', days: 1 }, { label: '3d', days: 3 }, { label: '7d', days: 7 },
];

/** Inline rename, validated with the bot's own parser and hint. */
function RenameField({ entry, onRename }: { entry: RosterEntry; onRename: (name: string) => void }) {
  const [draft, setDraft] = React.useState(entry.displayName);
  const [error, setError] = React.useState<string | null>(null);
  return (
    <form
      className="sfin-subs-rename"
      onSubmit={(ev) => {
        ev.preventDefault();
        const name = parseSubscriptionName(draft);
        if (name === null) {
          setError(SUB_NAME_HINT);
          return;
        }
        setError(null);
        onRename(name);
      }}
    >
      <Input aria-label={`New name for ${entry.displayName}`} value={draft} onChange={(ev) => setDraft(ev.target.value)} />
      <Button type="submit" variant="outline">Save name</Button>
      {error && <div className="sfin-subs-error" role="alert">{error}</div>}
    </form>
  );
}
```

3. With the other hooks at the top of `SubscriptionsCard`, add:
```tsx
  const [deleted, setDeleted] = React.useState<{ id: string; name: string } | null>(null);
```
and below `hide`:
```tsx
  const remove = (e: RosterEntry) => {
    const id = e.key.slice(2); // 'm:<id>'
    setDeleted({ id, name: e.displayName });
    setOpenKey(null);
    edit?.((p) => deleteManual(p, id, new Date()));
  };
```

4. Replace the `detail` function with:
```tsx
  const detail = (e: RosterEntry) => (
    <div className="sfin-subs-detail">
      {e.bankName && <div className="sfin-subtle">On your statement as {e.bankName}</div>}
      <div>
        {e.recent.length > 0
          ? `Last charges: ${e.recent.map((r) => `${monthDay(r.date)} ${rosterMoney(r.cents)}`).join(' · ')}`
          : 'No charge matched to it yet.'}
      </div>
      {edit && (
        <>
          <div className="sfin-subs-remind">
            <span>Remind</span>
            <div className="sfin-range-chips" role="group" aria-label={`Remind before ${e.displayName} charges`}>
              {REMIND_CHIPS.map((c) => {
                const on = (e.remind ?? null) === c.days;
                return (
                  <Button key={c.label} variant={on ? undefined : 'ghost'} aria-pressed={on}
                    onClick={() => edit((p) => setRemind(p, e.key, c.days))}>
                    {c.label}
                  </Button>
                );
              })}
            </div>
          </div>
          {companionStale && (
            <div className="sfin-subtle">
              Reminders are sent by the background companion, and it hasn&apos;t published in over two days.
              {onSetUpCompanion && (
                <> <Button variant="ghost" onClick={onSetUpCompanion}>Open background sync settings</Button></>
              )}
            </div>
          )}
          <RenameField key={e.key} entry={e} onRename={(name) => edit((p) => renameKey(p, e.key, name))} />
          <div className="sfin-subs-actions">
            {e.source === 'manual'
              ? <Button variant="outline" aria-label={`Delete ${e.displayName}`} onClick={() => remove(e)}>Delete</Button>
              : <Button variant="outline" aria-label={`Hide ${e.displayName}`} onClick={() => hide(e)}>Hide / I cancelled it</Button>}
          </div>
        </>
      )}
    </div>
  );
```

5. In the returned JSX, directly after the `{celebrate && (…)}` block:
```tsx
      {deleted && edit && (
        <div className="sfin-subs-actions" role="status">
          Deleted {deleted.name}.
          <Button variant="ghost" onClick={() => { edit((p) => restoreDeleted(p, deleted.id)); setDeleted(null); }}>Undo</Button>
        </div>
      )}
```

In `src/components/ui.tsx`, after the Task 11 rules:
```css
.sfin-subs-remind { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.sfin-subs-remind .sfin-range-chips { margin: 0; }
.sfin-subs-rename { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.sfin-subs-error { color: var(--sfin-bad); font-size: var(--sfin-sz-sm); }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/budget src/components/theme-styles.test.ts src/tabs/BudgetTab.test.tsx`
Expected: PASS (Task 11's no-emoji test now also covers the new controls).

Run: `npm run type-check`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/budget/SubscriptionsCard.tsx src/components/budget/SubscriptionsCard.test.tsx src/components/ui.tsx
git commit -m "App: remind, rename and delete inline on the Subscriptions card

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: The card's add form, and editing a hand-added entry

**Files:**
- Modify: `src/components/budget/SubscriptionsCard.tsx`
- Test: `src/components/budget/SubscriptionsCard.test.tsx` (append)
- Modify: `src/components/ui.tsx` (after the Task 12 rules)

**Interfaces:**
- Consumes: Task 1 (`addManual`, `updateManual`, `setRemind`, `newManualId`, `manualKey`, `Cadence`), Task 7 (`parseSubscriptionName`, `parseSubscriptionDate`, `SUB_NAME_HINT`, `SUB_AMOUNT_HINT`, `SUB_DATE_HINT`), existing `parseAmountCents`, Task 12 (`REMIND_CHIPS`).
- Produces (module-private): `function ManualForm({ mode, initial, onSave, onCancel })` with `interface ManualDraft { name: string; amount: string; cadence: Cadence; date: string; remind: RemindDays | null }`.

**App copy (verbatim):** button `+ Add subscription`; form aria-labels `Add a subscription` / `Edit subscription`; fields `Name` (placeholder `Hulu`), `Amount` (placeholder `9.99`), cadence group `How often` with `Monthly` / `Yearly`, `Next charge` (placeholder `Oct 20`), remind group `Remind before it charges` (add only); buttons `Save` / `Save changes` and `Cancel`; a hand-added entry's detail gets `Edit` (aria-label `Edit <name>`). Errors are the three shared hints.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/budget/SubscriptionsCard.test.tsx`:

```tsx
describe('subscriptions card: adding and editing by hand (1.60)', () => {
  const openAdd = () => fireEvent.click(screen.getByRole('button', { name: '+ Add subscription' }));

  it('offers + Add subscription on an empty card too', () => {
    render(<SubscriptionsCard cube={cubeWith([])} subscriptionPrefs={loaded()} onSubscriptionEdit={vi.fn()} />);
    expect(screen.getByText(/no monthly subscriptions detected/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: '+ Add subscription' })).toBeTruthy();
  });

  it('refuses what the bot refuses, with the same words', () => {
    const onEdit = vi.fn();
    render(<SubscriptionsCard cube={cubeWith([det('SPOTIFY')])} subscriptionPrefs={loaded()} onSubscriptionEdit={onEdit} />);
    openAdd();
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '9,99' } });
    fireEvent.change(screen.getByLabelText('Next charge'), { target: { value: 'someday' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toEqual([
      'Type a name, up to 40 characters.',
      "Couldn't read that as an amount — try 9.99.",
      "Couldn't read that date — try Oct 20 or 2026-10-20.",
    ]);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('saves a hand-added subscription with its reminder, then closes the form', () => {
    const onEdit = vi.fn();
    render(<SubscriptionsCard cube={cubeWith([det('SPOTIFY')])} subscriptionPrefs={loaded()} onSubscriptionEdit={onEdit} />);
    openAdd();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Hulu' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '9.99' } });
    fireEvent.change(screen.getByLabelText('Next charge'), { target: { value: 'Oct 20' } });
    fireEvent.click(within(screen.getByRole('group', { name: 'Remind before it charges' })).getByRole('button', { name: '3d' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const after = applied(onEdit);
    expect(after.manual).toEqual([{ id: expect.stringMatching(/^[0-9a-z]{8}$/), name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' }]);
    expect(after.remind).toEqual({ [`m:${after.manual[0].id}`]: 3 });
    expect(screen.queryByRole('form', { name: 'Add a subscription' })).toBeNull();
  });

  it.each([
    ['Yearly', 'Feb 29', '2027-02-28'], // R2-4: 2027 has no Feb 29
    ['Monthly', 'Oct 3', '2026-11-03'], // a past date rolls forward
  ])('%s, "%s" is stored as %s', (cadence, typed, want) => {
    const onEdit = vi.fn();
    render(<SubscriptionsCard cube={cubeWith([])} subscriptionPrefs={loaded()} onSubscriptionEdit={onEdit} />);
    openAdd();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Domain' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '15' } });
    fireEvent.click(within(screen.getByRole('group', { name: 'How often' })).getByRole('button', { name: cadence }));
    fireEvent.change(screen.getByLabelText('Next charge'), { target: { value: typed } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(applied(onEdit).manual[0].nextDate).toBe(want);
  });

  it('a hand-added entry edits its amount, cadence and date', () => {
    const onEdit = vi.fn();
    const base = loaded({ manual: [HULU] });
    render(<SubscriptionsCard cube={cubeWith([])} subscriptionPrefs={base} onSubscriptionEdit={onEdit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hulu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit Hulu' }));
    const form = screen.getByRole('form', { name: 'Edit subscription' });
    expect((within(form).getByLabelText('Amount') as HTMLInputElement).value).toBe('9.99');
    fireEvent.change(within(form).getByLabelText('Amount'), { target: { value: '10.99' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Yearly' }));
    fireEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(applied(onEdit, base.prefs).manual).toEqual([{ ...HULU, cents: 1099, cadence: 'yearly', nextDate: '2026-10-20' }]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/budget/SubscriptionsCard.test.tsx`
Expected: FAIL — no `+ Add subscription` button.

- [ ] **Step 3: Implement**

In `src/components/budget/SubscriptionsCard.tsx`:

1. Imports: add `addManual, newManualId, updateManual` to the `shared/subscription-prefs` import; add `manualKey, type Cadence` to the `shared/subscription-roster` import; extend the `shared/telegram-commands` import to `parseAmountCents, parseSubscriptionDate, parseSubscriptionName, SUB_AMOUNT_HINT, SUB_DATE_HINT, SUB_NAME_HINT`.

2. Below `RenameField`, add:
```tsx
interface ManualDraft { name: string; amount: string; cadence: Cadence; date: string; remind: RemindDays | null }
const BLANK_DRAFT: ManualDraft = { name: '', amount: '', cadence: 'monthly', date: '', remind: null };

/** The add form and a hand-added entry's Edit form — validated with the bot's
 *  own parsers and hints, so the two can never accept different input. */
function ManualForm({ mode, initial, onSave, onCancel }: {
  mode: 'add' | 'edit';
  initial: ManualDraft;
  onSave: (value: { name: string; cents: number; cadence: Cadence; nextDate: string; remind: RemindDays | null }) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = React.useState<ManualDraft>(initial);
  const [errors, setErrors] = React.useState<{ name?: string; amount?: string; date?: string }>({});
  const set = <K extends keyof ManualDraft>(key: K, value: ManualDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    const now = new Date();
    const name = parseSubscriptionName(draft.name);
    const cents = parseAmountCents(draft.amount);
    const nextDate = parseSubscriptionDate(draft.date, now, draft.cadence, localIsoDay(now));
    setErrors({
      ...(name === null ? { name: SUB_NAME_HINT } : {}),
      ...(cents === null ? { amount: SUB_AMOUNT_HINT } : {}),
      ...(nextDate === null ? { date: SUB_DATE_HINT } : {}),
    });
    if (name === null || cents === null || nextDate === null) return;
    onSave({ name, cents, cadence: draft.cadence, nextDate, remind: draft.remind });
  };
  return (
    <form className="sfin-subs-form" aria-label={mode === 'add' ? 'Add a subscription' : 'Edit subscription'} onSubmit={submit}>
      {mode === 'add' && (
        <>
          <label>Name<Input value={draft.name} placeholder="Hulu" onChange={(ev) => set('name', ev.target.value)} /></label>
          {errors.name && <div className="sfin-subs-error" role="alert">{errors.name}</div>}
        </>
      )}
      <label>Amount<Input value={draft.amount} placeholder="9.99" inputMode="decimal" onChange={(ev) => set('amount', ev.target.value)} /></label>
      {errors.amount && <div className="sfin-subs-error" role="alert">{errors.amount}</div>}
      <div className="sfin-range-chips" role="group" aria-label="How often">
        {(['monthly', 'yearly'] as const).map((c) => (
          <Button key={c} variant={draft.cadence === c ? undefined : 'ghost'} aria-pressed={draft.cadence === c} onClick={() => set('cadence', c)}>
            {c === 'monthly' ? 'Monthly' : 'Yearly'}
          </Button>
        ))}
      </div>
      <label>Next charge<Input value={draft.date} placeholder="Oct 20" onChange={(ev) => set('date', ev.target.value)} /></label>
      {errors.date && <div className="sfin-subs-error" role="alert">{errors.date}</div>}
      {mode === 'add' && (
        <div className="sfin-range-chips" role="group" aria-label="Remind before it charges">
          {REMIND_CHIPS.map((c) => (
            <Button key={c.label} variant={draft.remind === c.days ? undefined : 'ghost'} aria-pressed={draft.remind === c.days}
              onClick={() => set('remind', c.days)}>
              {c.label}
            </Button>
          ))}
        </div>
      )}
      <div className="sfin-subs-actions">
        <Button type="submit">{mode === 'add' ? 'Save' : 'Save changes'}</Button>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
```

3. With the other hooks, add:
```tsx
  const [adding, setAdding] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
```

4. Directly after the `roster` memo (before `const listed = …`), add:
```tsx
  const addControl = !edit ? null : adding ? (
    <ManualForm
      mode="add"
      initial={BLANK_DRAFT}
      onCancel={() => setAdding(false)}
      onSave={(v) => {
        const id = newManualId();
        edit((p) => setRemind(addManual(p, { id, name: v.name, cents: v.cents, cadence: v.cadence, nextDate: v.nextDate }), manualKey(id), v.remind));
        setAdding(false);
      }}
    />
  ) : (
    <Button variant="outline" onClick={() => setAdding(true)}>+ Add subscription</Button>
  );
```

5. Replace the two early returns with versions that keep the add control:
```tsx
  if (!full && listed === 0 && roster.linkSuggestions.length === 0) {
    if (!roster.detectionAvailable) return <div className="sfin-subs"><div className="sfin-subtle">{NOT_LOOKED_YET}</div>{addControl}</div>;
    // The OPEN view keeps going: an empty roster is when "watch a merchant" is the point.
    if (roster.hidden.length === 0) return <div className="sfin-subs"><div className="sfin-subtle">{NOTHING_DETECTED}</div>{addControl}</div>;
  }
```

6. In the returned JSX, add `{addControl}` directly after the `<div className="sfin-subs-total">…</div>` line.

7. In `detail`, replace the `<div className="sfin-subs-actions">…</div>` block (Task 12) with:
```tsx
          <div className="sfin-subs-actions">
            {e.source === 'manual' ? (
              <>
                <Button variant="outline" aria-label={`Edit ${e.displayName}`} onClick={() => setEditingId(e.key.slice(2))}>Edit</Button>
                <Button variant="outline" aria-label={`Delete ${e.displayName}`} onClick={() => remove(e)}>Delete</Button>
              </>
            ) : (
              <Button variant="outline" aria-label={`Hide ${e.displayName}`} onClick={() => hide(e)}>Hide / I cancelled it</Button>
            )}
          </div>
          {e.source === 'manual' && editingId === e.key.slice(2) && (() => {
            // The STORED entry, not the row: a linked row shows detection's price.
            const stored = prefs?.manual.find((m) => m.id === editingId);
            if (!stored) return null;
            return (
              <ManualForm
                mode="edit"
                initial={{ name: stored.name, amount: (stored.cents / 100).toFixed(2), cadence: stored.cadence, date: stored.nextDate, remind: null }}
                onCancel={() => setEditingId(null)}
                onSave={(v) => {
                  edit((p) => updateManual(p, stored.id, { cents: v.cents, cadence: v.cadence, nextDate: v.nextDate }));
                  setEditingId(null);
                }}
              />
            );
          })()}
```

In `src/components/ui.tsx`, after the Task 12 rules:
```css
.sfin-subs-form { display: flex; flex-direction: column; gap: 8px; padding: 8px 0; }
.sfin-subs-form label { display: flex; flex-direction: column; gap: 3px; font-size: var(--sfin-sz-sm); }
.sfin-subs-form .sfin-range-chips { margin: 0; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/budget src/components/theme-styles.test.ts src/tabs/BudgetTab.test.tsx src/pages`
Expected: PASS.

Run: `npm run type-check`
Expected: succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/components/budget/SubscriptionsCard.tsx src/components/budget/SubscriptionsCard.test.tsx src/components/ui.tsx
git commit -m "App: add a subscription by hand, and edit a hand-added one, on the card

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Parity, docs, follow-ups, every gate

**Files:**
- Create: `src/components/budget/subscriptions-parity.test.tsx`
- Modify: `README.md` (the **Telegram bot** bullet ~line 50-55, and the Budget-tab bullet that lists "subscriptions" ~line 37)
- Modify: `CHANGELOG.md` (`## [Unreleased]`)
- Modify: `docs/superpowers/follow-ups.md` (new section 7 before `## Reference: …`; the "Last updated" paragraph)

**Interfaces:**
- Consumes: Task 2 (`buildRoster`, `formatRosterTotal`, `rosterAmount`, `aboutDollars`, `localIsoDay`), Task 5 (`formatSubscriptionList`, `escapeMarkdown`), Task 11–13 (`SubscriptionsCard`).
- Produces: the parity test (R2-14) and documentation only.

- [ ] **Step 1: Write the parity test**

Create `src/components/budget/subscriptions-parity.test.tsx`:

```tsx
import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SubscriptionsCard } from './SubscriptionsCard';
import { CUBE } from '../../../shared/report-cube.test';
import type { ReportCube } from '../../../shared/report-cube';
import { emptySubscriptionPrefs, type SubscriptionPrefs } from '../../../shared/subscription-prefs';
import { aboutDollars, buildRoster, formatRosterTotal, localIsoDay, rosterAmount } from '../../../shared/subscription-roster';
import { escapeMarkdown, formatSubscriptionList } from '../../../shared/telegram';

/**
 * R2-14: the app card and the bot's /subscriptions render from one roster, so
 * they must show the same names, amounts and totals in the same order. One
 * fixture, both surfaces.
 */
const NOW = new Date(2026, 9, 12, 9, 0, 0);
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });

const det = (name: string, over: Record<string, unknown> = {}) => ({
  name, monthlyCents: 1199, count: 5, lastDate: '2026-09-15', lastCents: 1199, prevCents: 1199, creep: false,
  kind: 'subscription', recent: [{ date: '2026-09-15', cents: 1199 }], ...over,
});
const cube = {
  ...CUBE,
  asOf: NOW.toISOString(),
  subscriptions: [
    det('SPOTIFY'),
    det('NETFLIX', { monthlyCents: 1549, lastCents: 1799, creep: true, lastDate: '2026-09-22' }),
    det('LG&E', { kind: 'bill', monthlyCents: 6149, lastCents: 6149, lastDate: '2026-09-28' }),
    det('QR LIBRARY', { monthlyCents: 499, lastCents: 499 }),
  ],
  merchants: [[], [{ name: 'ANTHROPIC* CLAUDE SUB', cents: 2000, count: 1 }]],
} as ReportCube;
const prefs: SubscriptionPrefs = {
  ...emptySubscriptionPrefs(),
  names: { SPOTIFY: 'Spotify' },
  remind: { SPOTIFY: 3 },
  hidden: ['QR LIBRARY'],
  confirmed: ['ANTHROPIC* CLAUDE SUB'],
  manual: [
    { id: 'hulu0001', name: 'Hulu', cents: 999, cadence: 'monthly', nextDate: '2026-10-20' },
    { id: 'dom00001', name: 'Domain', cents: 9900, cadence: 'yearly', nextDate: '2027-03-03' },
  ],
};

describe('app card and /subscriptions agree', () => {
  it('show the same names, amounts and totals, in the same order, and hide the same rows', () => {
    const roster = buildRoster({
      detected: cube.subscriptions, merchants: cube.merchants, links: [], prefs, today: localIsoDay(NOW),
    });
    const telegram = formatSubscriptionList(roster, 0);
    const { container } = render(<SubscriptionsCard cube={cube} subscriptionPrefs={{ prefs, unreadable: false }} onSubscriptionEdit={vi.fn()} />);
    const app = container.textContent ?? '';

    const rows = [...roster.subscriptions, ...roster.bills];
    expect(rows.length).toBe(6);
    for (const e of rows) {
      expect(telegram).toContain(escapeMarkdown(e.displayName));
      expect(app).toContain(e.displayName);
      expect(telegram).toContain(rosterAmount(e));
      expect(app).toContain(rosterAmount(e));
    }
    expect(telegram).toContain(formatRosterTotal(roster));
    expect(app).toContain(`${formatRosterTotal(roster)} across ${roster.subscriptions.length}`);
    expect(telegram).toContain(`about ${aboutDollars(roster.billsMonthlyCents)}/mo`);
    expect(app).toContain(`Bills ≈ ${aboutDollars(roster.billsMonthlyCents)}/mo`);

    const appOrder = Array.from(container.querySelectorAll('.sfin-subs-toggle')).map((b) => b.textContent);
    expect(appOrder).toEqual(rows.map((e) => e.displayName));
    expect(telegram).not.toContain('QR LIBRARY');
    expect(app).not.toContain('QR LIBRARY');
  });
});
```

Run: `npx vitest run src/components/budget/subscriptions-parity.test.tsx`
Expected: PASS (it pins what Tasks 2, 5 and 11 already built; a FAIL here is a real divergence to fix in the card or the formatter, not in this test).

- [ ] **Step 2: Docs**

`README.md` — in the **Telegram bot** bullet, after "Bare `/pool` shows the pool with Set and Clear buttons.", add:

```
  `/subscriptions` lists your subscriptions and bills — set a reminder before
  a charge, rename one, hide one you cancelled, or add an annual plan by hand —
  and the daily report's "Coming up" lines say what charges soon.
```

and in the Budget-tab bullet, change `subscriptions` to `subscriptions & bills (remind, rename, hide, add by hand)`.

`CHANGELOG.md`, under `## [Unreleased]`, append to `### Added`:

```markdown
- **Subscriptions & bills, in the app and the bot.** One list both edit:
  hide one you cancelled, confirm a maybe, set a reminder 1, 3 or 7 days
  before a charge, rename it, or add one the bank data can't show (an annual
  plan) by hand. Every entry shows its next charge date. `/subscriptions` in
  Telegram does all of it with buttons and ↩ Undo; adding and renaming ask one
  question at a time.
- **"Coming up" in the daily report:** reminders, the week's charges (Full
  detail), a price rise, and "didn't charge — cancelled?" with a Hide button.
  With the daily report off, the reminders and news still arrive, as one short
  message, each said once.
- The weekly report adds `Next week: N charges · $X` and a **See all** button.
- When a charge looks like one you added by hand, the card and the bot ask
  "Is HULU your Hulu?" — Yes merges them into one row.
```

and to `### Changed`:

```markdown
- Bills (monthly, varying amount) now have their own group with an "about"
  subtotal, instead of being asked about one by one; they stay out of the
  subscriptions total.
- The mini app's Subscriptions section shows the same names and totals as the
  card. Subscription amounts drop a trailing `.00` everywhere (`$20/mo`).
- Your subscription choices are stored as one document, written by re-reading
  first, so a change made in Telegram is never overwritten by an open app tab.
```

and to `### Fixed`:

```markdown
- A bank name with `*` or `_` in the daily report's price-rise line no longer
  stops the whole report from being delivered.
```

`docs/superpowers/follow-ups.md` — replace the "Last updated" paragraph's first sentence with `Last updated: 2026-10-12, after the subscriptions & bills plan (new section 7).` and insert before `## Reference: name mismatches …`:

```markdown
## 7. Subscriptions & bills (2026-10-12, plan `2026-10-12-subscriptions.md`)

- **Remove the legacy-list mirror one release after 1.60.** `editSubscriptionPrefs`
  writes `hidden_subscriptions` and `confirmed_subscriptions` after every edit
  so an older companion or a stale tab reads correct lists mid-upgrade. Once
  1.61 has shipped: drop the mirror and `legacySubscriptionPrefs`'s writers'
  dependence on it, keep the two keys in `KEYS` (Reset must still clear what
  older versions wrote), and keep the read-side import from them for one more
  release so a never-edited install still imports its old choices.
- **No no-companion mode in the app.** Without a cube the Budget board is an
  empty state, so hand-added entries are only reachable from Telegram there.
  `buildRoster` already supports `detectionAvailable: false`.
- **A bill cannot be moved into Subscriptions from the UI** (only an old
  `confirmed_subscriptions` entry does that). Add a "Count it as a
  subscription" action to the bill detail if anyone asks.
- **Hidden names the detector has dropped vanish from the Hidden list** (they
  are no longer roster entries). Harmless — they come back hidden if the
  merchant recurs — but they cannot be restored ahead of time.
- **`today` is the local day, cube dates are UTC `date()` strings.** A charge
  posted in the evening west of UTC can land a day "late" on the late/overdue
  windows. Pre-existing seam (see the R2 facts); not worth a migration.
- **Weekly-cadence subscriptions and annual detection** stay out of scope
  (spec, "Out of scope").
```

- [ ] **Step 3: Run every gate**

```bash
npm test
npm --prefix companion test
npm run type-check
npm --prefix companion run build
```
Expected: all four succeed. If `npm --prefix companion run build` writes into `companion/dist`, do not commit build output unless `companion/dist` is already tracked (check `git status`).

- [ ] **Step 4: Commit**

```bash
git add src/components/budget/subscriptions-parity.test.tsx README.md CHANGELOG.md docs/superpowers/follow-ups.md
git commit -m "Subscriptions: app/bot parity test; docs and follow-ups

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
