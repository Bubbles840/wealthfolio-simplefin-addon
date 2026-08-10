# Telegram Commands Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Six slash commands (`/report`, `/left`, `/afford`, `/status`, `/sync`, `/help`) answered in seconds by an always-on long-poll listener inside the companion daemon.

**Architecture:** A new `companion/src/telegram-listener.ts` long-polls `getUpdates` and becomes the bot's ONLY update consumer — it takes over the import notice's dismiss buttons and owns the `telegram_update_offset` secret. Parsing and reply formatting are pure functions in a new `shared/telegram-commands.ts`. Handlers reuse the existing digest builder, `weeklyEnvelope`, and native budget/spend queries; `/sync` shares one in-process mutex with the scheduled sync.

**Tech Stack:** TypeScript (NodeNext in companion — `.js` import extensions), vitest, node-cron (existing), Telegram Bot API (`getUpdates` long-poll, `setMyCommands`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-09-telegram-commands-design.md`. Ships as **v1.11.0**.
- Baselines (must never drop): root `npx vitest run` **674**, `cd companion && npx vitest run` **173**. Where this plan MOVES behavior (the import-notice poll), the tests move with it — same assertions, new home — never silently vanish.
- Import extensions: `shared/` and `companion/src/` use `.js` extensions (NodeNext); `src/**` is Vite and extensionless. Both are correct; never "fix" either.
- Frozen strings (data contracts — never edit): every existing secret key (`telegram_config`, `telegram_update_offset`, `uncategorized_dismissals`, `sync_health`, …), stored comment markers (`Starting balance · `, ` · pending`, `· Amazon: <label> ·`, …), log tags `duplicate-refused` / `duplicate-prune`.
- Only messages from the configured `chatId` are honored; everything else advances the offset and is dropped.
- Dismissal-ledger writes go through `mergeDismissals(persisted, base, next)` from `shared/uncategorized.js` — never a whole-object overwrite.
- The listener must be un-killable by a handler: every command reply path is caught; the loop restarts with capped backoff.
- No emoji **in new copy beyond the existing glyph conventions**: state glyphs (🟢/⚠️/🚨) follow the digest's `GlyphStyle` rules; decorative header glyphs go through `headerGlyph`-style clean-mode stripping like every existing formatter.
- `shared/*` stays host-agnostic: no Node imports, no fetch, no Date.now() defaults that spread hidden state — formatters take data in, return strings.

## File Structure

- **Create** `shared/telegram-commands.ts` — `parseCommand`, `TELEGRAM_COMMAND_MENU`, `resolveCategoryQuery`, `parseAffordArgs`, and the reply formatters (`formatHelpReply`, `formatLeftReply`, `formatAffordReply`, `formatStatusReply`, `formatReportFooter`, `formatSyncReply`). Pure.
- **Create** `shared/telegram-commands.test.ts`.
- **Create** `companion/src/telegram-listener.ts` — the long-poll loop: offset ownership, chat authorization, dismiss callbacks, command dispatch, `setMyCommands`, backoff, 60s config re-read. All I/O injected.
- **Create** `companion/src/telegram-listener.test.ts`.
- **Modify** `companion/src/index.ts` — extract `readBudgetSnapshot` + `composeDailyDigestMessage` out of `sendDailyTelegramReport`; add the sync mutex `runCompanionSyncExclusive`; build the listener's deps and start it in `main`; delete the poll from `sendImportNotice`.
- **Modify** `companion/src/dismissals.ts` — `pollTelegramDismissals` is deleted (the listener replaces it); `pruneDismissals`/`mergeDismissals`/`DismissalLedger` re-exports stay (the Telegram-transport half moves, the ledger half was always `shared/`).
- **Modify** `companion/src/index.test.ts` — `sendImportNotice` tests updated: no poll, ledger still filters the notice.
- **Modify (Task 7)** `manifest.json`, `package.json`, `shared/version.ts`, `CHANGELOG.md`.

---

### Task 1: `parseCommand`, the menu, `/help`

**Files:**
- Create: `shared/telegram-commands.ts`, `shared/telegram-commands.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (later tasks and the listener rely on these EXACT names):
  ```ts
  export interface ParsedCommand { command: string; args: string }
  export function parseCommand(text: string | null | undefined, botName?: string): ParsedCommand | null
  export const TELEGRAM_COMMAND_MENU: ReadonlyArray<{ command: string; description: string }>
  export function formatHelpReply(unknownCommand?: string): string
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// shared/telegram-commands.test.ts
import { describe, it, expect } from 'vitest';
import { parseCommand, formatHelpReply, TELEGRAM_COMMAND_MENU } from './telegram-commands';

describe('parseCommand', () => {
  it('parses a bare command', () => {
    expect(parseCommand('/report')).toEqual({ command: 'report', args: '' });
  });
  it('parses arguments as one trimmed string', () => {
    expect(parseCommand('/afford  20 shopping ')).toEqual({ command: 'afford', args: '20 shopping' });
  });
  it('strips an @BotName suffix, which Telegram appends in groups', () => {
    expect(parseCommand('/left@SimplefinSyncBot groceries')).toEqual({ command: 'left', args: 'groceries' });
  });
  it('lowercases the command but never the arguments', () => {
    expect(parseCommand('/LEFT Groceries')).toEqual({ command: 'left', args: 'Groceries' });
  });
  it('returns null for plain text, empty, and null', () => {
    expect(parseCommand('what is left?')).toBeNull();
    expect(parseCommand('')).toBeNull();
    expect(parseCommand(null)).toBeNull();
  });
  it('returns null for a lone slash', () => {
    expect(parseCommand('/')).toBeNull();
  });
});

describe('formatHelpReply', () => {
  it('lists every command in the menu, one line each', () => {
    const help = formatHelpReply();
    for (const { command } of TELEGRAM_COMMAND_MENU) {
      expect(help).toContain(`/${command}`);
    }
  });
  it('menu covers exactly the six shipped commands', () => {
    expect(TELEGRAM_COMMAND_MENU.map((c) => c.command).sort())
      .toEqual(['afford', 'help', 'left', 'report', 'status', 'sync']);
  });
  it('prefixes with Unknown command when asked about junk', () => {
    const help = formatHelpReply('bogus');
    expect(help).toMatch(/^Unknown command/);
    expect(help).toContain('/bogus');
  });
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run shared/telegram-commands.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// shared/telegram-commands.ts
/**
 * shared/telegram-commands.ts
 *
 * Parsing and reply formatting for the bot's slash commands. Pure functions —
 * data in, string out — beside the report formatters in ./telegram.ts and for
 * the same reason: the companion owns transport and storage, and everything
 * testable without a network lives here.
 */

export interface ParsedCommand {
  /** Lowercased, without the slash: 'report', 'left', … */
  command: string;
  /** Everything after the command, trimmed. Case preserved — category names matter. */
  args: string;
}

/** `/cmd`, `/cmd args`, `/cmd@BotName args` — Telegram appends the bot name in groups. */
export function parseCommand(text: string | null | undefined, botName?: string): ParsedCommand | null {
  const t = (text ?? '').trim();
  if (!t.startsWith('/') || t.length < 2) return null;
  const [head, ...rest] = t.split(/\s+/);
  let name = head.slice(1);
  const at = name.indexOf('@');
  if (at !== -1) {
    // Addressed to a specific bot. If it names a DIFFERENT bot, this message is
    // not for us — treat as non-command rather than answering someone else's mail.
    const addressed = name.slice(at + 1);
    if (botName && addressed.toLowerCase() !== botName.toLowerCase()) return null;
    name = name.slice(0, at);
  }
  if (!name) return null;
  return { command: name.toLowerCase(), args: rest.join(' ').trim() };
}

/** Registered via setMyCommands so Telegram's ☰ menu lists them. Order is display order. */
export const TELEGRAM_COMMAND_MENU = [
  { command: 'report', description: "Today's spending digest, fresh from the database" },
  { command: 'left', description: "What's left per category — /left groceries narrows it" },
  { command: 'afford', description: 'Can I afford it? — /afford 20 shopping' },
  { command: 'status', description: 'Last sync, balances, what needs attention' },
  { command: 'sync', description: 'Pull new bank transactions now' },
  { command: 'help', description: 'This list' },
] as const;

export function formatHelpReply(unknownCommand?: string): string {
  const lines = TELEGRAM_COMMAND_MENU.map((c) => `/${c.command} — ${c.description}`);
  const head = unknownCommand ? `Unknown command: /${unknownCommand}\n\n` : '';
  return `${head}${lines.join('\n')}`;
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run shared/telegram-commands.test.ts` → PASS. Then `npx tsc --noEmit -p .` and `npx tsc --noEmit -p companion` (shared compiles under both).
- [ ] **Step 5: Commit** — `git add shared/telegram-commands.ts shared/telegram-commands.test.ts && git commit -m "Parse bot commands and format /help"`

---

### Task 2: `/left` and `/afford` formatters

**Files:**
- Modify: `shared/telegram-commands.ts`, `shared/telegram-commands.test.ts`

**Interfaces:**
- Consumes: `weeklyEnvelope`, `moneyWhole`, `escapeMarkdown`, `GlyphStyle`, `DEFAULT_GLYPH_STYLE` from `./telegram` (extensionless inside shared — it compiles under both tsconfigs because sibling imports in `shared/` DO use `.js`: check the neighbors — `shared/sync-core.ts` imports `./telegram.js`. USE `./telegram.js`.)
- Produces:
  ```ts
  export interface CategoryBudgetSnapshot { name: string; budget: number; monthSpent: number; weekSpent: number }
  export interface BudgetPeriod { daysFromWeekStartToMonthEnd: number; daysLeftInMonthInclusive: number }
  export type CategoryQueryResult =
    | { kind: 'one'; category: CategoryBudgetSnapshot }
    | { kind: 'ambiguous'; names: string[] }
    | { kind: 'none' };
  export function resolveCategoryQuery(cats: CategoryBudgetSnapshot[], query: string): CategoryQueryResult
  export function parseAffordArgs(args: string): { amount: number; query: string } | null
  export function formatLeftReply(cats: CategoryBudgetSnapshot[], period: BudgetPeriod, style: GlyphStyle, query?: string): string
  export function formatAffordReply(cats: CategoryBudgetSnapshot[], period: BudgetPeriod, style: GlyphStyle, amount: number, query: string): string
  ```

**Semantics locked by the spec:**
- `resolveCategoryQuery`: case-insensitive PREFIX match on `name`. Exact match wins outright even when it prefixes others (`Home` vs `Home Improvement`). Several prefix matches → `ambiguous` with the names. None → `none`.
- Bare `/left`: one line per category **with a budget** (`budget > 0`), each `glyph Name — $X left this week · $Y left this month` using `weeklyEnvelope({budget, monthSpent, weekSpent}, …)`; over-month → 🚨 and "over by $N this month"; over-week-within-month → ⚠️ and "week allowance spent"; else 🟢. Categories without budgets are omitted from the bare listing (the digest's own rule).
- `/left <query>`: resolves; a no-budget category replies its month spend and `No budget set for <name> — nothing to be over.`; ambiguous lists matches (`Which one? Home, Home Improvement`); none replies `No category starts with "<query>". /left lists them all.`
- `parseAffordArgs('20 shopping')` → `{ amount: 20, query: 'shopping' }`; accepts `$20`, `20.50`; rejects missing amount, missing query, amount ≤ 0, NaN → `null` (handler sends the usage line `Usage: /afford 20 shopping`).
- `formatAffordReply`: resolves the query the same way; with a budget, computes `weeklyEnvelope` before and after (`weekSpent + amount`, `monthSpent + amount`), replies three lines — `This week: $A left → $B left`, `This month: $C left → $D left`, verdict — verdicts: after-week ≥ 0 → `🟢 Fits this week's allowance.`; after-week < 0 but after-month ≥ 0 → `⚠️ Blows this week's allowance but fits the month.`; after-month < 0 → `🚨 Over the month's budget by $N.` No budget → the month spend and the same no-budget sentence as `/left`.

- [ ] **Step 1: Write the failing tests** — cover: prefix vs exact-beats-prefix vs ambiguous vs none; bare `/left` omits budget-less categories and renders all three glyph states from crafted inputs (`budget:100, monthSpent:110` → 🚨; `budget:100, monthSpent:50, weekSpent:40` with a 7-day horizon such that the envelope is exceeded → ⚠️); `/left groceries` single-category reply; no-budget sentence; `parseAffordArgs` accepted and rejected forms (`'20 shopping'`, `'$20 shopping'`, `'20.50 x'`, `''`, `'shopping 20'`, `'0 shopping'`, `'-5 x'`); each `/afford` verdict at its boundary (after-week exactly 0 → fits). Use fixed `period` values (e.g. `{ daysFromWeekStartToMonthEnd: 14, daysLeftInMonthInclusive: 10 }`) so envelope math is deterministic. Assert glyphs and the money strings (`moneyWhole` output), not whole-message snapshots.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** in `shared/telegram-commands.ts`, importing from `./telegram.js`. Respect `GlyphStyle` clean mode exactly as `formatDailySpendingDigest` does: state glyphs (🟢/⚠️/🚨) always render; anything decorative goes through the same stripping convention (crib from `headerGlyph` usage at `shared/telegram.ts:126` — state glyphs are exempt from clean mode by that comment's rule).
- [ ] **Step 4: Run** shared tests + both tsc configs.
- [ ] **Step 5: Commit** — `git commit -m "Format /left and /afford replies from budget snapshots"`

---

### Task 3: `/status`, the report footer, the sync replies

**Files:**
- Modify: `shared/telegram-commands.ts`, `shared/telegram-commands.test.ts`

**Interfaces:**
- Consumes: `moneyWhole`, `escapeMarkdown` from `./telegram.js`.
- Produces:
  ```ts
  export interface StatusReplyInput {
    version: string;
    lastSyncAt: string | null;          // ISO; null = never synced
    lastSyncSummary: string | null;     // e.g. '0 imported, 105 skipped'
    accounts: Array<{ name: string; balance: number; currency: string; drift: number | null; measured: boolean }>;
    uncategorizedCount: number | null;  // null = companion never published it
    amazonUnparsed: number | null;
  }
  export function formatStatusReply(input: StatusReplyInput, now: Date): string
  export function formatReportFooter(lastSyncAt: string | null, now: Date): string
  export function formatSyncReply(r: { imported: number; skipped: number; driftAlerts: number; errors: string[] }): string
  export function formatAgo(iso: string, now: Date): string   // '2h ago', '3m ago', 'just now'
  ```

**Semantics:**
- `formatAgo`: < 90s → `just now`; < 90min → `Nm ago`; < 36h → `Nh ago`; else `Nd ago`. (One definition — `formatReportFooter` and `formatStatusReply` both use it.)
- `formatStatusReply`: header `*SimpleFin Sync* — companion v<version>`; `Last sync: <ago> — <summary>` (or `Last sync: never`); one line per account `Name: $balance · in sync|$N off|not checked` — `in sync` ONLY when `measured && drift === null` is false semantics… **exactly the addon's rule**: `measured === true && drift === null` → `in sync`; `drift !== null` → `$<abs drift> off`; otherwise → `not checked`; then `Needs a category: N` when `uncategorizedCount` is non-null and > 0; then `⚠️ N Amazon email(s) unread — format may have changed` when `amazonUnparsed` > 0. Null inputs simply omit their line — a companion that never published a signal must not read as "0 problems".
- `formatReportFooter(lastSyncAt, now)`: `Data as of last sync, 2h ago — /sync to pull new charges.`; null → `No sync has run yet — /sync to pull transactions.`
- `formatSyncReply`: success → `Synced: N imported, M skipped.` plus `⚠️ K account(s) showed drift — check /status.` when `driftAlerts > 0`; with `errors.length > 0` → `Sync finished with errors: <first error>` (first only — Telegram is not a log file).

- [ ] **Step 1: failing tests** — `formatAgo` at each boundary (89s, 91s, 89min, 91min, 35h, 37h); a full status render with one of each account state asserting the three chip words; null `uncategorizedCount` produces NO needs-a-category line while `0` also produces none and `7` does; footer both branches; sync reply all three shapes.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** shared tests + both tsc configs.
- [ ] **Step 5: Commit** — `git commit -m "Format /status, the report footer, and /sync replies"`

---

### Task 4: Companion data seams — budget snapshot, digest reuse, sync mutex

**Files:**
- Modify: `companion/src/index.ts`, Test: `companion/src/index.test.ts`

**Interfaces:**
- Consumes: everything already in `index.ts` (`getNativeWealthfolioSpending`, `getNativeWealthfolioBudgets`, `getNativeWealthfolioSpendingBetween`, `weekStartDate`, `toDateString`, `lastDayOfMonth`, `daysLeftInMonthInclusive`, `runCompanionSync`).
- Produces (Task 6 wires these into handlers):
  ```ts
  export function readBudgetSnapshot(dbPath: string, now: Date): {
    categories: CategoryBudgetSnapshot[];   // EVERY category seen in spend or budget maps
    period: BudgetPeriod;
  }
  export async function composeDailyDigestMessage(wfClient: WealthfolioClient): Promise<string | null>
  export function runCompanionSyncExclusive(): { started: boolean; result: Promise<SyncResult> }
  ```

**What each is:**
- `readBudgetSnapshot` — pure extraction of the assembly already inside `sendDailyTelegramReport` (`companion/src/index.ts:958-996`): month spend map, budget map, week-spend map with the SAME `nextMonthStart` upper bound (keep the existing comment — it explains why the bound is not "today"), zipped over `unionCategoryNames(spentMap, budgetMap)` into `CategoryBudgetSnapshot[]`, plus the period `{ daysFromWeekStartToMonthEnd: lastDayOfMonth(now) - weekStart.getDate() + 1, daysLeftInMonthInclusive: daysLeftInMonthInclusive(now) }`. NOT filtered by `dailyReportCategories` — that filter is the DIGEST's presentation choice and stays in the digest path; `/left` deliberately sees everything.
- `composeDailyDigestMessage` — `sendDailyTelegramReport` minus the send: returns the digest message string including the health footer, or `null` when unconfigured/db missing. `sendDailyTelegramReport` becomes compose-then-send with behavior byte-identical (its existing tests must pass unchanged).
- `runCompanionSyncExclusive` — module-level `let syncInFlight: Promise<SyncResult> | null`. If null: start `runCompanionSync()`, store it, clear in `.finally`, return `{ started: true, result }`. If non-null: `{ started: false, result: syncInFlight }`. The cron callback at `index.ts:1190` switches to it, so `/sync` and the schedule genuinely share the one lock.

- [ ] **Step 1: failing tests** — follow `index.test.ts`'s existing harness for db-backed tests (it already builds fixture SQLite databases for the digest tests — reuse that helper): `readBudgetSnapshot` returns a category present only in budgets (spend 0), one present only in spend (budget 0), and the week/month numbers for a known fixture; `runCompanionSyncExclusive` — stub `runCompanionSync` (vi.mock or dependency seam consistent with existing tests) with a deferred promise: two calls while pending → second `{started:false}` and SAME promise identity; after resolution a third call starts fresh; `composeDailyDigestMessage` returns the same string `sendDailyTelegramReport` sends (capture via the existing sendTelegramMessage mock).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** — extraction refactor; `sendDailyTelegramReport`'s existing tests are the no-regression net.
- [ ] **Step 4: Run** — `cd companion && npx vitest run` (173 baseline + new), `npx tsc --noEmit -p companion`.
- [ ] **Step 5: Commit** — `git commit -m "Expose budget snapshot, digest composition, and an exclusive sync entry"`

---

### Task 5: The listener

**Files:**
- Create: `companion/src/telegram-listener.ts`, `companion/src/telegram-listener.test.ts`

**Interfaces:**
- Consumes: `parseCommand`, `TELEGRAM_COMMAND_MENU` from `../../shared/telegram-commands.js`.
- Produces (Task 6 constructs the deps):
  ```ts
  export interface TelegramListenerDeps {
    fetchImpl: typeof fetch;
    log: (msg: string) => void;
    /** Re-read every idle cycle so addon-side config changes land within ~a minute. */
    readConfig: () => Promise<{ botToken: string; chatId: string; botName?: string } | null>;
    readOffset: () => Promise<number | null>;
    writeOffset: (n: number) => Promise<void>;
    /** A dismiss-button tap. Implementations MUST merge, not overwrite. */
    applyDismissal: (activityId: string) => Promise<void>;
    onCommand: (cmd: ParsedCommand, reply: (text: string) => Promise<void>) => Promise<void>;
    sleep: (ms: number) => Promise<void>;
  }
  export function startTelegramListener(deps: TelegramListenerDeps): { stop: () => Promise<void> }
  ```

**Behavior (each bullet is a test):**
1. No config → sleeps 60s (via injected `sleep`), re-reads, never calls fetch.
2. With config: `getUpdates` with `timeout=50`, `allowed_updates=["message","callback_query"]`, and the stored offset; on updates, processes each then `writeOffset(maxUpdateId + 1)` — including for messages it DROPS. Foreign chat (`chat.id !== Number(chatId)`) → dropped, offset still advances, logged once per chat id per process, not per message.
3. A `message` from the configured chat that parses as a command → `onCommand(parsed, reply)`; `reply` posts `sendMessage` to the configured chat via `fetchImpl`. Non-command text → dropped (offset advances).
4. A `callback_query` whose data is a dismiss payload → `applyDismissal(activityId)` + `answerCallbackQuery`. Copy the payload format EXACTLY from what `buildDismissKeyboard` (shared/telegram.ts:514) emits and what the old `pollTelegramDismissals` matched — read both before writing this, and port `pollTelegramDismissals`'s tests for payload parsing into this file so the format stays pinned by tests.
5. `onCommand` throwing → `reply` is attempted with `Something went wrong running that command — check the companion logs.`, the error is logged, the loop CONTINUES (next iteration still fires).
6. Transport error (fetch rejects) → logged, capped exponential backoff via `sleep` (1s, 2s, 4s… cap 60s), then resumes; a subsequent success resets the backoff.
7. HTTP 409 (`json.error_code === 409`) → logged with the words `another getUpdates consumer` so "the bot ignores me" is diagnosable, then backoff as above.
8. On config (re)load with a token it hasn't registered yet this process: POST `setMyCommands` with `TELEGRAM_COMMAND_MENU`; failure is logged and non-fatal; not re-sent unless the token changes.
9. `stop()` resolves after the in-flight iteration finishes; no further fetches.

Test harness: `fetchImpl` = `vi.fn()` returning queued JSON responses (follow `companion/src/dismissals.test.ts`'s existing fake-fetch pattern before deleting that file's poll tests — Task 6 does the deletion); `sleep` = instantly-resolving spy whose call args prove cadence and backoff; drive the loop deterministically by awaiting a `sleep` call count rather than real timers.

- [ ] **Step 1: failing tests** (all nine behaviors). **Step 2: verify failure.** **Step 3: implement.** **Step 4: run companion suite + tsc.** **Step 5: commit** — `git commit -m "Always-on Telegram listener: long-poll, auth, dismissals, backoff"`

---

### Task 6: Wire the handlers; the listener takes over from the sync-time poll

**Files:**
- Modify: `companion/src/index.ts`, `companion/src/dismissals.ts`, `companion/src/index.test.ts`, `companion/src/dismissals.test.ts`

**Interfaces:**
- Consumes: everything Tasks 1-5 produced, exact names as declared there.
- Produces: `buildTelegramCommandHandler(wfClient): TelegramListenerDeps['onCommand']` (exported from `index.ts` for tests), and the listener started in `main`.

**The handler dispatch (in `index.ts`):**
- `/help` and unknown → `formatHelpReply(...)`.
- `/report` → `composeDailyDigestMessage(wfClient)`; append `formatReportFooter(lastSyncAt, new Date())` reading `last_sync_at` the way the rest of `index.ts` does; `null` digest → `Telegram reports are not configured — check budgets and the addon's Notifications tab.`
- `/left` → `readBudgetSnapshot(dbPath, new Date())` → `formatLeftReply(categories, period, style, args || undefined)` with the glyph style read via the existing `readGlyphStyle(wfClient)`.
- `/afford` → `parseAffordArgs(args)`; null → `Usage: /afford 20 shopping`; else `formatAffordReply(...)`.
- `/status` → assemble `StatusReplyInput`: version from `SIMPLEFIN_SYNC_VERSION`; last sync + summary from the `sync_health` secret (parse with `parseSecretJson<SyncHealth>` — see `index.ts:1005-1008`); accounts from the `account_balances` + `account_names` secrets (same states the addon renders: `measured`/`drift`); uncategorized count from `uncategorized_status`; amazon from `amazon_mail_status`. Every read individually `.catch(() => null)` — a missing signal omits its line, never fails the command.
- `/sync` → `runCompanionSyncExclusive()`; `started === false` → reply `Already syncing — hang on.` and ALSO await the shared result and send the summary when it lands; `started === true` → reply `Syncing…` immediately, then `formatSyncReply` on completion (errors caught → the error shape of `formatSyncReply`).
- All replies sent with `sendTelegramMessage` (existing Markdown conventions; run names through `escapeMarkdown` where the formatters don't already).

**The takeover (same commit, because the system is only correct with both halves):**
- `sendImportNotice` (`index.ts:757-791`): DELETE the poll block — `pollTelegramDismissals` call, offset read/write, the poll-derived `ledgerChanged` bookkeeping. KEEP: the ledger read (it still filters the notice), the prune-on-write with `mergeDismissals` (pruning still has to happen somewhere on the sync path), and the dismiss keyboard on the outbound notice.
- `companion/src/dismissals.ts`: delete `pollTelegramDismissals`; keep the re-exports (`pruneDismissals`, `mergeDismissals`, `DismissalLedger`) and the module doc comment updated to say the LISTENER is now the transport.
- `dismissals.test.ts`: the payload-parsing assertions were PORTED to `telegram-listener.test.ts` in Task 5 — verify they exist there, then delete only the transport tests here; ledger tests stay.
- `index.test.ts` around line 1608: the import-notice tests drop their poll stubs; the assertion that a dismissed activity is excluded from the notice REMAINS (fed by a pre-seeded ledger secret instead of a poll response).
- `main`: construct `TelegramListenerDeps` (readConfig reads `telegram_config` + parses; offset via `telegram_update_offset`; `applyDismissal` = read-merge-prune-write via `mergeDismissals`, `base` = the freshly-read ledger, `next` = base + new id; `onCommand` = `buildTelegramCommandHandler(wfClient)`; real `fetch`; `sleep` = `setTimeout` promise; `log`) and `startTelegramListener` beside the cron registrations at `index.ts:1190`.

- [ ] **Step 1: failing tests** — handler-level, with mocked stores/fetch per `index.test.ts` conventions: each command produces its formatter's output (one happy case each — deep formatting is already covered in shared tests); `/sync` while running replies `Already syncing` and later the shared summary; `/status` with every secret read failing still replies (version + `Last sync: never`); import notice with pre-seeded dismissal in the ledger still excludes the row WITHOUT any poll.
- [ ] **Step 2: verify failure.** **Step 3: implement.** **Step 4:** full verification — root vitest, companion vitest, both tsc, `npm run build`, `cd companion && npm run build`. Confirm no test count went DOWN net of the documented moves (poll tests → listener tests).
- [ ] **Step 5: Commit** — `git commit -m "Answer commands from the listener and retire the sync-time poll"`

---

### Task 7: v1.11.0, changelog, full verification

**Files:**
- Modify: `manifest.json`, `package.json`, `shared/version.ts` (all → `1.11.0`), `CHANGELOG.md`

- [ ] **Step 1:** Bump all three carriers (`shared/version.test.ts` pins them together).
- [ ] **Step 2:** CHANGELOG under `## [Unreleased]`:

```markdown
## [1.11.0] - <today's date>

### Added

- **The Telegram bot now answers.** Six commands, listed in Telegram's ☰ menu:
  /report (today's digest, fresh from the database), /left (what's left per
  category — /left groceries narrows it), /afford 20 shopping (before/after for
  the week and month, with a verdict), /status (last sync, balances, what needs
  attention), /sync (pull new transactions now), /help. Commands work only from
  your configured chat and answer in a second or two.

### Changed

- **Dismiss buttons act immediately.** The companion now listens to Telegram
  continuously instead of collecting button presses at the next sync, so
  dismissing an uncategorized transaction takes effect within a second instead
  of within six hours. Same ledger, same rules — just no waiting.
```

- [ ] **Step 3:** Full verification — root vitest, companion vitest, `npx tsc --noEmit -p .`, `npx tsc --noEmit -p companion`, `npm run build`, `npm run package` (zip must be `dist/simplefin-sync-1.11.0.zip`), `cd companion && npm run build`.
- [ ] **Step 4:** Commit — `git commit -m "Bump to 1.11.0 with the Telegram commands changelog"`

(Release — tag, GitHub release, store files, rsync + rebuild — is Nick's flow after live testing; not part of this plan.)

## Plan Self-Review (performed)

- **Spec coverage:** six commands (T1-T3 formatters, T6 wiring), listener + single-consumer takeover (T5, T6), setMyCommands (T5), authorization (T5), 60s config re-read (T5), backoff + 409 (T5), sync mutex (T4, T6), instant /report with footer (T3, T6), /sync as separate command (T6), version/changelog (T7). Gap check: none found.
- **Placeholder scan:** clean.
- **Type consistency:** `CategoryBudgetSnapshot`/`BudgetPeriod` defined in T2, consumed in T4/T6; `ParsedCommand` in T1, consumed in T5/T6; `TelegramListenerDeps` in T5, constructed in T6; `runCompanionSyncExclusive` return shape identical in T4 and T6.
