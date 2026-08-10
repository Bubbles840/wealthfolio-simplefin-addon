# /categorize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/categorize` in Telegram: a tappable, in-place-editing menu that lists uncategorized transactions, files one under a category/subcategory via Wealthfolio's spending API, can dismiss instead, offers "make this a rule", and republishes the uncategorized status so the addon updates in seconds.

**Architecture:** A pure menu state machine in `shared/categorize-menu.ts` (screens in, `{text, keyboard, actions}` out); the companion holds a per-chat session, executes actions against three new `WealthfolioClient` REST methods, and republishes `uncategorized_status` after every write. The listener gains one optional dep that routes `cz:`-prefixed callbacks and an in-place-edit UI wrapper with the same never-reject guarantee as `reply`.

**Tech Stack:** TypeScript (companion NodeNext — `.js` imports), vitest, Telegram Bot API (`editMessageText`, inline keyboards), Wealthfolio server REST (`/api/v1/spending/*`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-10-telegram-categorize-design.md`. Ships as **v1.12.0**, functionally companion-only.
- Baselines (must never drop): root `npx vitest run` **740**, `cd companion && npx vitest run` **238**.
- **Verified API contract (upstream `apps/server/src/api/spending.rs`, source-read 2026-08-10 — do not re-derive):**
  - `PUT /api/v1/spending/activities/{activityId}/assignments` body `{"taxonomyId": string, "categoryId": string}` → 200 with the assignment row.
  - `DELETE /api/v1/spending/activities/{activityId}/assignments/{taxonomyId}` → 200, empty.
  - `POST /api/v1/spending/rules` body camelCase `{"name": string, "pattern": string, "matchType": "contains", "taxonomyId": string, "categoryId": string, "priority": 50, "isGlobal": true}` (omit every preset field — upstream doc: "user-facing rule creation leaves these None"). `matchType` values are snake_case strings: `contains` | `starts_with` | `exact` | `regex`. **Side effect (verified):** creation triggers `rerun_all(accounts, only_uncategorized: true)` — existing UNCATEGORIZED rows get filed; categorized rows are never touched. The confirmation copy must disclose this.
- The spending taxonomy id is the literal **`'spending_categories'`** (already hardcoded in `getNativeCategoryCatalog`'s query, `companion/src/sqlite-native.ts:465`).
- **Telegram caps `callback_data` at 64 bytes.** Menu callbacks carry `cz:<token>` where the token indexes the session's current screen — never a raw id. A missing/stale session answers "That menu expired — send /categorize again." and never writes.
- **One `getUpdates` consumer** — the existing listener. This plan adds routing inside it, never a second consumer.
- **The listener must remain unable to die**: `deps.log`/`deps.sleep` stay referenced only in `safeLog`/`pause`; every new UI callback (`edit`, `answer`) gets the same never-reject treatment as `reply`; no new unhandled-rejection path (one kills the daemon and stops bank syncing).
- **Dismissals merge, never overwrite**: any dismissal write goes through read-fresh → `mergeDismissals(persisted, base, next)` → `pruneDismissals` → write (the `applyTelegramDismissal` pattern, `companion/src/index.ts`). Undo removes the id via the same merge path.
- **One definition of "needs a category"**: the menu's list is `getNativeUncategorizedSpending` rows filtered through `visibleUncategorized(rows, ledger)` from `shared/uncategorized.js`. Descriptions display via `descriptionFromComment` with raw-notes fallback (the `uncategorized-status.ts` pattern) — never leak a ` · TRN-…` suffix.
- After EVERY successful assign / unassign / dismiss / undismiss from the menu, republish via `publishUncategorizedStatusForDbPath` (already exported from `companion/src/uncategorized-status.ts`; call it exactly as the sync path does).
- Frozen strings (never edited): every existing secret key, stored comment markers (`Starting balance · `, ` · pending`, `· Amazon: <label> ·`, …), log tags `duplicate-refused`/`duplicate-prune`, and `Dismissed — dropped from future notices`.
- `shared/*.ts` stays host-agnostic: no Node imports, no fetch, no filesystem, no hidden `new Date()` — `now` is a parameter where needed.
- Import extensions: `shared/` ↔ `companion/src/` use `.js`; `src/**` extensionless. Both correct; never "fix" either.
- Only the configured chat is honored; the listener's existing authorization covers callbacks — the new routing must not weaken it.
- **Never `git add -A` / `git add .`** — stage files by name.

## File Structure

- **Create** `shared/categorize-menu.ts` + test — the pure state machine: session/screen types, screen renderers returning `{ text, keyboard }`, `tapToken` codec, `applyTap(session, token) → MenuAction`, all button labels/copy.
- **Modify** `companion/src/sqlite-native.ts` + test — `getNativeSpendingCategories` (categories WITH ids/parent ids).
- **Modify** `companion/src/wealthfolio.ts` + `companion/src/wealthfolio.test.ts` (create if absent; check first) — the three REST methods.
- **Modify** `companion/src/telegram-listener.ts` + test — `cz:` routing to an optional `onMenuCallback` dep; `reply` gains an optional keyboard; `edit`/`answer` wrappers.
- **Create** `companion/src/categorize.ts` + test — the controller: session store, fresh reads, action execution, republish, expired-session handling.
- **Modify** `companion/src/index.ts` + test — `/categorize` command entry, `onMenuCallback` dep construction, import-notice `Categorize` button.
- **Modify (last task)** `manifest.json`, `package.json`, `shared/version.ts`, `CHANGELOG.md`.

---

### Task 1: The menu state machine (`shared/categorize-menu.ts`)

**Files:**
- Create: `shared/categorize-menu.ts`, `shared/categorize-menu.test.ts`

**Interfaces:**
- Consumes: `InlineKeyboard` from `./telegram.js`; `moneyWhole`, `escapeMarkdown` from `./telegram.js`.
- Produces (later tasks import these EXACT names):

```ts
export interface CategorizeTxn {
  activityId: string;
  date: string;           // YYYY-MM-DD
  amountCents: number;
  description: string;    // already cleaned via descriptionFromComment
  accountName: string;
}
export interface SpendingCategory {
  id: string;
  name: string;
  parentId: string | null;
  parentName: string | null;
}
export type MenuScreen =
  | { kind: 'list'; page: number }
  | { kind: 'txn'; activityId: string }
  | { kind: 'subcats'; activityId: string; parentId: string }
  | { kind: 'filed'; activityId: string; categoryId: string; undone: boolean }
  | { kind: 'dismissed'; activityId: string; undone: boolean }
  | { kind: 'rulePreview'; activityId: string; categoryId: string }
  | { kind: 'freeRulePreview'; pattern: string; categoryId: string }
  | { kind: 'ruleCreated'; activityId: string | null; categoryId: string }
  | { kind: 'closed' };
export interface MenuSession {
  txns: CategorizeTxn[];        // fresh read, already ledger-filtered
  categories: SpendingCategory[];
  screen: MenuScreen;
  /** Buttons rendered LAST for this session, by token index. applyTap resolves
   *  tokens against this, so a tap on an outdated message can never act on the
   *  wrong row. */
  buttons: MenuAction[];
}
export type MenuAction =
  | { kind: 'goto'; screen: MenuScreen }
  | { kind: 'assign'; activityId: string; categoryId: string }
  | { kind: 'unassign'; activityId: string; categoryId: string }
  | { kind: 'dismiss'; activityId: string }
  | { kind: 'undismiss'; activityId: string }
  | { kind: 'createRule'; activityId: string; categoryId: string }
  | { kind: 'createFreeRule'; pattern: string; categoryId: string }
  | { kind: 'refresh' }
  | { kind: 'close' };
export function parseNewRuleArgs(args: string):
  | { pattern: string; categoryQuery: string }
  | null;   // null → the handler sends: Usage: /newrule trader joes = groceries
export const MENU_PAGE_SIZE = 8;
export const MENU_CALLBACK_PREFIX = 'cz:';
export function renderScreen(session: MenuSession): {
  text: string;
  keyboard: InlineKeyboard;
  buttons: MenuAction[];   // caller stores these back onto the session
};
export function applyTap(session: MenuSession, callbackData: string):
  | { ok: true; action: MenuAction }
  | { ok: false; reason: 'expired' | 'unknown' };
```

**Semantics locked by the spec (each is a test):**
- `list`: up to `MENU_PAGE_SIZE` rows as buttons `Aug 8 · BOOK STORES · $4.23` (date short-formatted from the YYYY-MM-DD string — no `new Date()`), `More »`/`« Prev` paging buttons only when applicable, `Done` always. Empty list → text `Nothing needs a category right now.`, keyboard only `Done`.
- `txn`: description, amount, date, account in the text; parent categories (`parentId === null`) as buttons, two per row; `Keep uncategorized`; `« Back`.
- Tapping a parent WITH children → `goto subcats`; a parent with NO children → `assign` directly.
- `subcats`: the parent's children plus `Just ⟨parent⟩ itself` (assigns the parent), `« Back` to the txn screen.
- `filed`: `Filed BOOK STORES → Groceries.` with `Undo`, `Make this a rule`, `Next transaction` (goto list), `Done`. After `undone: true`: text says `Filing undone — BOOK STORES is uncategorized again.`, buttons only `Back to list`/`Done`.
- `dismissed`: `BOOK STORES will stay uncategorized.` with `Undo`/`Back to list`/`Done`; undone mirrors `filed`.
- `rulePreview`: EXACT copy: `Create this rule?\nDescriptions containing "⟨description⟩" → ⟨category⟩\nIt will also file any other uncategorized transactions that match, now and on every future import. Already-categorized transactions are never touched.` Buttons `Create rule` / `« Back`.
- `freeRulePreview`: same copy with the typed pattern in place of the description; buttons `Create rule` / `Cancel` (no Back — there is no prior screen). Tapping `Create rule` yields `createFreeRule`.
- `parseNewRuleArgs`: splits on the FIRST `=` or `→`, trims both sides; either side empty → `null`; the pattern keeps its inner characters verbatim (test with `*`, `(`, and an `=` inside the category side is impossible by first-split rule — test that too).
- `ruleCreated`: confirms, offers `Back to list`/`Done` (`activityId: null` — the /newrule path — offers only `Done`).
- Token codec: `callback_data` is `cz:<index>`; `applyTap` resolves the index against `session.buttons`; out-of-range or non-`cz:` → `{ok: false}` with the right reason. **Test the 64-byte invariant**: for a session with 50 fake txns and 60 categories with long names, EVERY emitted `callback_data` byte-length ≤ 64.
- A txn/category id referenced by a screen but absent from the session's fresh data (row categorized elsewhere mid-flow) → `renderScreen` falls back to the list with a first line `That transaction is no longer uncategorized.` — never a crash.
- All interpolated user data (`description`, category names, account names) through `escapeMarkdown`.

Steps: **(1)** write the failing tests (each semantic above; follow `shared/telegram-commands.test.ts` style — assert lines/labels, not whole-message snapshots except the locked `rulePreview` copy); **(2)** run `npx vitest run shared/categorize-menu.test.ts` → FAIL module-not-found; **(3)** implement; **(4)** `npx vitest run shared/categorize-menu.test.ts` → PASS, then root `npx vitest run`, `npx tsc --noEmit -p .`, `npx tsc --noEmit -p companion`; **(5)** commit `git add shared/categorize-menu.ts shared/categorize-menu.test.ts && git commit -m "Categorize menu: pure screens, tokens, and actions"`.

---

### Task 2: Category ids + the three REST methods

**Files:**
- Modify: `companion/src/sqlite-native.ts`, its tests (find where `getNativeCategoryCatalog` is tested and add beside)
- Modify: `companion/src/wealthfolio.ts`; Test: `companion/src/wealthfolio.test.ts` (CHECK whether it exists first; if the client is only tested via `index.test.ts` mocks, create the file using an injected/fake `fetch` — the client uses global `fetch`, so stub `globalThis.fetch` with `vi.stubGlobal` and restore in `afterEach`)

**Interfaces:**
- Produces:

```ts
// sqlite-native.ts
export function getNativeSpendingCategories(dbPath: string): Array<{
  id: string; name: string; parentId: string | null; parentName: string | null;
}>;
// wealthfolio.ts (on WealthfolioClient)
async assignActivityCategory(activityId: string, taxonomyId: string, categoryId: string): Promise<void>
async unassignActivityCategory(activityId: string, taxonomyId: string): Promise<void>
async createCategorizationRule(rule: {
  name: string; pattern: string; categoryId: string; taxonomyId: string; priority: number;
}): Promise<void>
```

- `getNativeSpendingCategories`: `SELECT tc.id, tc.name, tc.parent_id, parent.name FROM taxonomy_categories tc LEFT JOIN taxonomy_categories parent ON tc.parent_id = parent.id WHERE tc.taxonomy_id = 'spending_categories' ORDER BY COALESCE(parent.name, tc.name), tc.parent_id IS NOT NULL, tc.sort_order, tc.name;` — same read-only connection helper (`queryNativeDb`) and ordering conventions as the neighbors. Empty/missing db → `[]` (match the existing readers' failure posture).
- REST methods follow the file's existing shape exactly (`this.authHeaders()`, `httpError('assignActivityCategory', res)`): `PUT {base}/api/v1/spending/activities/${encodeURIComponent(activityId)}/assignments` with JSON `{taxonomyId, categoryId}`; `DELETE …/assignments/${encodeURIComponent(taxonomyId)}`; `POST {base}/api/v1/spending/rules` with `{name: rule.name, pattern: rule.pattern, matchType: 'contains', taxonomyId: rule.taxonomyId, categoryId: rule.categoryId, priority: rule.priority, isGlobal: true}` — preset fields OMITTED entirely.
- Tests pin the exact method, path, and body per call (capture `fetch` args), plus non-2xx → thrown `httpError`. For the native query: drive the existing fixture approach used around `getNativeCategoryCatalog`'s tests (real temp SQLite via `node:sqlite` if that is what neighbors do — READ the existing tests first and copy their harness).

Steps: (1) failing tests → (2) RED → (3) implement → (4) `cd companion && npx vitest run` + root suite + both tsc → (5) commit `git commit -m "Spending category ids and the three spending-API calls"` (staged by name).

---

### Task 3: Listener routing for menu callbacks

**Files:**
- Modify: `companion/src/telegram-listener.ts`, `companion/src/telegram-listener.test.ts`

**Interfaces:**
- Produces (Task 5 constructs it):

```ts
// added to TelegramListenerDeps:
  /**
   * Menu-button taps (callback_data starting with 'cz:'). OPTIONAL: absent
   * means such callbacks are answered with a generic expiry notice. `ui`
   * mirrors `reply`'s guarantee: NONE of its methods ever reject — transport
   * failures are logged in the listener — because a rejecting UI callback in a
   * fire-and-forget position is an unhandled rejection, which kills the daemon.
   */
  onMenuCallback?: (
    cb: { data: string; chatId: number; messageId: number },
    ui: {
      edit: (text: string, keyboard?: InlineKeyboard) => Promise<void>;
      answer: (text?: string) => Promise<void>;
      send: (text: string, keyboard?: InlineKeyboard) => Promise<void>;
    },
  ) => Promise<void>;
```

- Also: `reply` (handed to `onCommand`) gains an optional second parameter `keyboard?: InlineKeyboard`, threaded into the existing `sendMessage` body as `reply_markup` when present. Existing handlers compile unchanged.
- Routing in the callback branch: `d:` → `applyDismissal` exactly as today (byte-identical behavior, including the answer text); `cz:` → `onMenuCallback` when present, wrapped like `onCommand` (errors caught, logged via `safeLog`, loop continues), else `answer('That menu expired — send /categorize again.')`; anything else → current drop-and-advance behavior.
- `edit` = `editMessageText` (`chat_id`, `message_id`, `text`, `parse_mode: 'Markdown'`, `reply_markup`); `answer` = `answerCallbackQuery` (needs the callback query id — capture it in the closure, do not expose it); `send` mirrors `reply`. Every one catches + `safeLog`s its own failure — Telegram answers 400 "message is not modified" on a no-op edit; that must be swallowed like any other transport failure, not special-cased.
- The authorization rule is unchanged: `cz:` callbacks from a foreign chat are dropped (offset still advances) exactly as foreign messages are — add a test proving a foreign-chat `cz:` callback never reaches `onMenuCallback`.

**Tests (each a bullet):** `cz:` routes to the dep with the right `{data, chatId, messageId}`; absent dep → expiry answer, offset advances; dep throwing → logged, loop survives (later iteration polls); `ui.edit`/`ui.answer`/`ui.send` never reject when transport rejects (fire-and-forget safe — the Task 5 pattern); `d:` behavior byte-identical (existing tests keep passing); foreign-chat `cz:` dropped; `reply` with a keyboard sends `reply_markup`, without one omits it. Existing 9 behaviors' tests must pass unchanged.

Steps: (1) failing tests → (2) RED → (3) implement → (4) `cd companion && npx vitest run` + root + both tsc → (5) commit `git commit -m "Route cz: menu callbacks with a never-rejecting edit/answer UI"`.

---

### Task 4: The controller (`companion/src/categorize.ts`)

**Files:**
- Create: `companion/src/categorize.ts`, `companion/src/categorize.test.ts`

**Interfaces:**
- Consumes: Task 1's machine (`../../shared/categorize-menu.js`), Task 2's methods, `visibleUncategorized`/`mergeDismissals`/`pruneDismissals` from `../../shared/uncategorized.js`, `descriptionFromComment` from `../../shared/sync-core.js`, `uncategorizedWindow` + `publishUncategorizedStatusForDbPath` from `./uncategorized-status.js`.
- Produces (Task 5 wires it):

```ts
export interface CategorizeController {
  /** /categorize entry: builds a fresh session, sends the list screen. */
  open(send: (text: string, keyboard?: InlineKeyboard) => Promise<void>): Promise<void>;
  /** A cz: tap. */
  onCallback(
    cb: { data: string; chatId: number; messageId: number },
    ui: { edit: (t: string, k?: InlineKeyboard) => Promise<void>; answer: (t?: string) => Promise<void>; send: (t: string, k?: InlineKeyboard) => Promise<void> },
  ): Promise<void>;
}
export function createCategorizeController(deps: {
  dbPath: () => string | null;                     // null → "companion has no database access" reply
  readLedger: () => Promise<DismissalLedger>;
  writeLedgerMerged: (base: DismissalLedger, next: DismissalLedger) => Promise<void>; // read-fresh+merge+prune+write inside
  assign: (activityId: string, categoryId: string) => Promise<void>;   // taxonomyId applied inside (constant)
  unassign: (activityId: string) => Promise<void>;
  createRule: (r: { name: string; pattern: string; categoryId: string }) => Promise<void>; // priority 50 + taxonomy inside
  republish: () => Promise<void>;                  // never throws (wrap inside)
  log: (msg: string) => void;
}): CategorizeController;
export const SPENDING_TAXONOMY_ID = 'spending_categories';
```

**Behavior (each a test):**
1. `open`: reads db rows (`getNativeUncategorizedSpending` over `uncategorizedWindow(new Date())` — injected as data through `dbPath`+readers per the deps above), cleans descriptions (`descriptionFromComment(notes) || notes`), filters through `visibleUncategorized` with a fresh ledger read, reads categories, stores ONE session per chat (a `Map<number, MenuSession>` — sessions are per chat id), renders the list, `send`s it.
2. A tap: resolve via `applyTap` against the stored session. Missing session or `{ok: false, reason: 'expired'}` → `ui.answer('That menu expired — send /categorize again.')`, nothing else. `unknown` → answer `That button is stale — refreshing.` then re-render current screen from FRESH reads.
3. `assign` action: `deps.assign` → on success `deps.republish()` → rebuild session from fresh reads → render `filed` screen via `ui.edit`. On a THROWN assign: `ui.edit` an error screen (`Couldn't file that — Wealthfolio said: ⟨message⟩` + `« Back`/`Done`), log, session keeps its previous screen for Back. Nothing is retried automatically — a second tap is the retry.
4. `dismiss`: through `writeLedgerMerged` (which does read-fresh + `mergeDismissals` + prune + write), then republish, then the `dismissed` screen. `undismiss` removes the id the same merged way. `unassign` mirrors assign.
5. `createRule`: name = `Telegram: ⟨description⟩` truncated to 60 chars; pattern = the cleaned description VERBATIM (contains-match, no escaping — pin with a test containing `*` and `(`); after success → `ruleCreated` screen. The rulePreview screen's disclosure copy comes from Task 1 verbatim.
6. Every screen transition triggered by a tap re-reads rows + ledger + categories BEFORE rendering (the freshness rule); prove with a test that a row categorized externally between taps disappears from the next list render.
7. `republish` failures never break the flow (wrapped, logged); `ui.*` never rejects by contract, so no `.catch` needed on sends — but every `deps.*` call that CAN throw is caught and rendered, never escaping to the listener.
8. Concurrency: a second `/categorize` replaces the chat's session (old message's buttons hit the stale-token path). Test: tap from the OLD message after reopen → expired/stale answer, no write.

Steps: (1) failing tests (fake deps, fixture rows/categories) → (2) RED → (3) implement → (4) companion suite + root + both tsc → (5) commit `git commit -m "Categorize controller: sessions, fresh reads, writes, republish"`.

---

### Task 5: Wire it: /categorize command, dep construction, import-notice button

**Files:**
- Modify: `companion/src/index.ts`, `companion/src/index.test.ts`
- Modify: `shared/telegram.ts` (ONLY `formatImportNotice`/its keyboard builder), `shared/telegram.test.ts`

**Interfaces:**
- Consumes: everything above, exact names as declared.
- Produces: `/categorize` in `TELEGRAM_COMMAND_MENU` (`shared/telegram-commands.ts`: add `{ command: 'categorize', description: 'File uncategorized transactions, right from here' }` — `/help` and `setMyCommands` pick it up automatically; update the Task-1-era test that pins the exact command set, and ONLY that test).
- Wiring in `index.ts`: construct the controller once beside `buildTelegramListenerDeps` — `dbPath` from the existing `WEALTHFOLIO_DB_PATH` + `existsSync` guards; `readLedger`/`writeLedgerMerged` reusing the `applyTelegramDismissal` machinery (extract its read-merge-write core if sharing needs it — the merge invariant must remain in ONE place); `assign`/`unassign`/`createRule` binding the Task 2 client methods with `SPENDING_TAXONOMY_ID` and priority 50; `republish` calling `publishUncategorizedStatusForDbPath` exactly as the sync path does, wrapped never-throw.
- `onCommand` dispatch gains `case 'categorize': await controller.open((text, kb) => reply(text, kb));` — note `reply`'s new optional keyboard from Task 3.
- `/newrule` dispatch: `parseNewRuleArgs(args)`; `null` → `Usage: /newrule trader joes = groceries`; else resolve the category query against `getNativeSpendingCategories` names (parents AND children) with the same prefix semantics `/left` uses (`resolveCategoryQuery`'s phrasing family for ambiguous/none, adapted to category names with ids); on a unique match, open a session at `freeRulePreview` and `reply` it with its keyboard. The controller gains `openRulePreview(pattern: string, categoryId: string, send): Promise<void>` (add to the `CategorizeController` interface and `categorize.test.ts` — the `createFreeRule` action flows through the same `deps.createRule` with the same name-truncation and disclosure copy). Add `{ command: 'newrule', description: 'Always file a match — /newrule trader joes = groceries' }` to `TELEGRAM_COMMAND_MENU` alongside `categorize`, and adapt the set-pinning test for BOTH new commands at once.
- `onMenuCallback: (cb, ui) => controller.onCallback(cb, ui)` in `buildTelegramListenerDeps`.
- Import notice: in `shared/telegram.ts`, the dismiss keyboard builder gains one final full-width row `[{ text: 'Categorize these', callback_data: 'cz:open' }]` WHEN rows exist. In the controller, `cz:open` is special-cased in `onCallback` BEFORE session lookup: it behaves as `open` but renders via `ui.send` (a fresh message — the notice itself is not the menu). Add this to Task 4's controller if building strictly in order; the plan places the token here because the button ships here — implement `cz:open` handling in `categorize.ts` in THIS task, with its test in `categorize.test.ts`.
- The frozen dismiss button text/payloads are untouched; only a row is APPENDED.

**Tests:** `/categorize` from the configured chat opens the list (integration through `buildTelegramCommandHandler`); the command appears in `TELEGRAM_COMMAND_MENU` (adapt the set-pinning test); `cz:open` from the import notice opens a fresh menu; a dismissed row (pre-seeded ledger) never appears in the list; assign flows end-to-end against mocked client + mocked native readers, and `uncategorized_status` is republished (assert the secret write); notice keyboard shows `Categorize these` only when it lists rows.

Steps: (1) failing tests → (2) RED → (3) implement → (4) **full verification**: companion suite, root suite, both tsc, both builds → (5) commit `git commit -m "Wire /categorize: command, menu callbacks, import-notice entry"`.

---

### Task 6: v1.12.0, changelog, full verification

**Files:** `manifest.json`, `package.json`, `shared/version.ts` (all `1.11.0` → `1.12.0`), `CHANGELOG.md`

- [ ] Bump all three carriers (`shared/version.test.ts` pins them together).
- [ ] CHANGELOG between `## [Unreleased]` and the 1.11.0 entry, dated with the real date:

```markdown
## [1.12.0] - <real date>

### Added

- **/categorize — file transactions without leaving Telegram.** The bot lists
  what needs a category as tappable buttons; tap a transaction, tap a category
  (subcategories included), done — one message that edits itself in place,
  with Back buttons all the way down. You can dismiss ("keep uncategorized")
  from the same menu, and both paths offer Undo. Every write goes through
  Wealthfolio's own spending API — the companion's database access stays
  read-only.
- **Make it a rule, from the confirmation — or from thin air.** After filing
  something, one tap previews and creates a categorization rule (priority 50,
  below your hand-made rules). Or type one directly: `/newrule trader joes =
  groceries` — plain text matching, no patterns to learn, same
  preview-before-create. Either way Wealthfolio then also files any other
  *uncategorized* matches — it never touches transactions that already have a
  category.
- The import notice's needs-a-category list now ends with a **Categorize
  these** button that opens the same menu.

### Changed

- Categorizing or dismissing from Telegram updates the addon's "Needs a
  category" tile within about a minute, instead of at the next sync.

Needs the companion rebuild; the addon zip is unchanged apart from the
version string.
```

- [ ] Full verification: root vitest, companion vitest, `npx tsc --noEmit -p .`, `npx tsc --noEmit -p companion`, `npm run build`, `npm run package` (zip must be `dist/simplefin-sync-1.12.0.zip`), `cd companion && npm run build`.
- [ ] Commit `git commit -m "Bump to 1.12.0 with the /categorize changelog"` (files staged by name).

(Release — push, tags, GitHub release, store files, rsync + rebuild — stays Nick's flow after live testing.)

## Plan Self-Review (performed)

- **Spec coverage:** menus/back/paging (T1), one-definition-of-uncategorized + descriptions (T1/T4), dismiss-in-menu with merge + undo (T4), assign/unassign via REST (T2/T4), rule button + verified body + disclosure of the uncategorized-only sweep (T1 copy, T2 call, T4 action), typed `/newrule` with preview-before-create (T1 parse+screen, T5 dispatch), instant republish (T4/T5), import-notice entry (T5), 64-byte tokens + stale-tap safety (T1/T4), listener single-consumer + never-die (T3), version/changelog (T6). Gaps: none found.
- **Placeholder scan:** clean — the one deliberate deferral (whether `wealthfolio.test.ts` exists) is an instruction to CHECK, with both outcomes specified.
- **Type consistency:** `CategorizeTxn`/`SpendingCategory`/`MenuAction`/`MenuSession` defined in T1 and consumed by name in T4/T5; `onMenuCallback`'s `cb`/`ui` shapes identical in T3 (producer) and T4 (consumer); `SPENDING_TAXONOMY_ID` defined once in T4 and bound in T5; the three client methods named identically in T2 and T5.
