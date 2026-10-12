# Subscriptions & bills, and question-and-answer Telegram flows — design

Nick approved this design section by section on 2026-10-12, as project 1 of
the five-project roadmap from that day's brainstorm (audience: new store users
and his own daily use, equally). He asked for a `/subscriptions` Telegram
command to view and manage subscriptions, chose "answer a question" input over
typed one-liners, and asked for `/pool` and `/newrule` to work the same way.

Ships as **two releases** from one spec:

- **R1 — question flows.** A shared ask-and-answer engine for the bot, plus
  `/pool`, `/newrule` and `/afford` converted to use it.
- **R2 — subscriptions & bills.** One stored preferences document, one shared
  roster function, `/subscriptions`, the app card, and a "📅 Coming up" block in
  the daily report.

## Decisions

| Question | Decision |
|---|---|
| Who is this for? | New store users and Nick's daily use, equally. |
| Which manage actions? | Hide/restore, confirm a maybe, remind before a charge, rename — **all four**. |
| Hand-added subscriptions? | **Yes, any kind**, monthly or yearly (annual plans are what the detector misses). |
| Where do the actions live? | **Both** the app card and Telegram, same release, one stored list. |
| How is it stored? | **One document** (`subscription_prefs`) + **one shared roster function** every consumer renders from (approach A). |
| How does Telegram take typed input? | **Answer a question** — the next plain message answers the open question. |
| Which commands use questions? | `/subscriptions` add and rename, `/pool`, `/newrule`, `/afford`. One-line forms keep working. |
| Bills | Their **own group** with their own subtotal, out of the subscriptions total. |
| Reminders and news, delivery | A line in the daily report when it is on; their own message when it is off (v1.57 one-voice rule). |

### One deliberate change from the approved sections

Section 4 said the price-up and "cancelled?" lines show **once**. The daily
report already prints a price-creep line (`📈 Netflix charged $17.99 — up from
its usual $15.49.`, `companion/src/index.ts`, `CREEP_FRESH_DAYS = 3`) for the
three mornings after the charge, judged purely from the charge date, so it
needs no "already said" state and survives restarts. This design **keeps that
rule** and gives "cancelled?" the same kind of window instead of adding a
stored seen-list. Stored once-only state is used only where a window cannot
work: the separate messages sent when the daily report is off.

---

## Part A — question flows (R1)

### What exists

- `companion/src/telegram-listener.ts` `handleMessage` drops every message that
  is not a command (`if (!parsed) return;`).
- Menus use the `cz:` callback prefix (`MENU_CALLBACK_PREFIX`), routed through
  the optional `onMenuCallback` dep. `companion/src/findings-menu.ts` is the
  stateless model: every screen is re-judged at tap time.
- `/pool`, `/newrule` and `/afford` only accept one-line arguments and answer a
  bare command with a usage message (`POOL_USAGE_REPLY`, `NEWRULE_USAGE_REPLY`,
  `AFFORD_USAGE_REPLY`).

### A1. The engine — `shared/ask-flow.ts` (pure)

```ts
type StepResult<T> = { ok: true; value: T } | { ok: false; hint: string };

export type AskStep =
  | { id: string; kind: 'text'; prompt: (answers: Answers) => string;
      parse: (input: string, answers: Answers) => StepResult<unknown>;
      /** Optional quick-pick buttons on a text step (e.g. common categories). */
      quick?: (answers: Answers) => Array<{ label: string; value: unknown }> }
  | { id: string; kind: 'choice'; prompt: (answers: Answers) => string;
      options: (answers: Answers) => Array<{ label: string; value: unknown }> };

export interface AskFlow {
  id: string;                     // 'pool-set', 'newrule', 'afford', 'sub-add', 'sub-rename'
  title: string;                  // shown on every question: "New subscription · 2 of 5"
  steps: AskStep[];
  /** Present → the flow ends on a summary with ✅ Save. Absent → the last
   *  answer finishes the flow (rename, afford). */
  summary?: (answers: Answers) => string;
}

export interface AskState { flowId: string; seq: number; step: number;
  answers: Answers; startedAt: number; context: Record<string, unknown> }

startAsk(flow, context, seq, now): { state; screen: AskScreen }
answerText(flow, state, text, now): AskOutcome
answerChoice(flow, state, index, now): AskOutcome
goBack(flow, state): { state; screen }
// AskOutcome = { kind: 'next'; state; screen } | { kind: 'retry'; screen }
//            | { kind: 'summary'; state; screen } | { kind: 'done'; answers }
```

- **A wrong answer re-asks only that question**, with the parser's hint on top
  ("Couldn't read '9,99' as an amount — try 9.99").
- **Every question carries `‹ Back` and `✖ Cancel`.** Back on the first
  question is Cancel.
- **Button data** is `cz:ak:<seq>:<step>:<action>` (`c<i>` choice, `q<i>`
  quick pick, `b` back, `x` cancel, `s` save). `seq` increments per started
  flow, so a button from an older question gets "That question has moved on"
  instead of answering the current one. It starts from the process start time
  (base 36), so a button from before a restart never matches a new flow. Well
  under Telegram's 64 bytes.
- **The engine is pure; flow definitions live in the companion**, because
  their prompts and quick picks need the database (e.g. `/newrule`'s match
  count and most-used categories). Their closures capture those deps.

### A2. Shared parsers — `shared/telegram-commands.ts`

Extracted so one-liners and questions read input identically:

- `parseAmountCents(text)` — `$16,000.50`, `9.99`, `20`. From the amount half
  of `parsePoolArgs` and `parseAffordArgs`; both are refactored to call it.
- `parseDateInput(text, now)` — `Dec 12`, `2026-12-12`, `today`, `tomorrow`.
  Returns the date; **the caller decides** what a past date means: `/pool`
  refuses a past ISO date and reads a month-name as its next occurrence (today's
  behavior, unchanged); a subscription's next date rolls forward.

### A3. Sessions — `companion/src/ask-session.ts`

- **One open question per chat, in memory**, created by a command or a menu
  button. Expires **15 minutes** after the last answer.
- **The next plain message in that chat answers it.** No need to use Telegram's
  Reply.
- **Any `/command` cancels the open question** and runs; one line,
  "Cancelled your earlier question.", is sent just before the command's reply.
- The listener honours one configured chat, so "one per chat" is a single
  slot in practice.
- **Starting a new flow replaces an open one**, with the same note.
- **Plain text with no open question:**
  - The chat's question expired in this process (remembered for 1 hour after
    expiry) → "That question expired — send /pool again." (names the flow's
    command).
  - Otherwise (including after a restart) → "I'm not waiting for an answer
    right now — /help lists what I can do."
- Restart loses open questions. Accepted: restarts are rare (deploys) and the
  user is told rather than ignored.

**Listener change:** new optional dep
`onText?: (text: string, chatId: number, reply) => Promise<void>`, called from
`handleMessage` when `parseCommand` returns null and the message has text.
Same never-rejects guarantee as `onCommand`. Absent → today's silence.
`cz:ak:` taps arrive through the existing `onMenuCallback`; the companion asks
the ask sessions **before** the categorize controller, which treats unknown
`cz:` data as an expired session (the v1.17.0 lesson).

### A4. Converted commands

The one-line forms are **unchanged** (their existing tests stay as
regressions). Only the bare command changes.

| Command | Bare form today | Bare form after R1 |
|---|---|---|
| `/pool` | Shows the pool (or "No pool set" + usage). | Same text, plus `[✏️ Set a new pool]` and, when one is set, `[Clear pool]`. Set: **How much?** → **Must last until?** → summary → Save (same write as `/pool 16000 Dec 12`, start date = today). Clear: "Clear the pool? `[Yes, clear]` `[Cancel]`" (today's `/pool off` stays instant). |
| `/newrule` | Usage message. | **Which words should match?** (e.g. *trader joes*) → **Which category?** (the question says how many charges in the past year match — the same one-year window as the transfer-rule preview's `countMatches`) (text, resolved by `resolveCategoryQuery` over the whole tree with the same ambiguity reply; quick-pick buttons for the 6 categories used most in the last 90 days) → hands off to `controller.openRulePreview(pattern, categoryId)`, the existing preview-before-write screen. |
| `/afford` | Usage message. | **How much?** → **Which category?** (quick picks: budgeted categories) → the same `formatAffordReply` answer. |

`/help`'s descriptions change to say the bare command asks
(e.g. `/pool — Semester money pool (asks, or /pool 16000 Dec 12)`).

---

## Part B — subscriptions & bills (R2)

### What exists

- `shared/subscriptions.ts`: `detectSubscriptions` (tiers subscription / bill /
  possible, `creep`), run by the companion at cube build
  (`companion/src/report-cube-build.ts`) and published in the report cube.
- Two settings, `hidden_subscriptions` and `confirmed_subscriptions` (string
  arrays). A confirmed name the detector has no verdict on is "watched".
- **The "what counts" filter is written out three times**: the app card
  (`src/components/budget/ReportView.tsx` `Subscriptions`), the reports server
  (`companion/src/reports-server.ts`), and the companion's
  `readCubeSubscriptions` (weekly line + creep line).
- The app writes whole-list snapshots from React state
  (`SyncPage.tsx` → `setHiddenSubscriptions(next)`), which can overwrite a
  change made elsewhere.
- Detection needs the companion: without it there is no Subscriptions data.

### B1. The stored document — `shared/subscription-prefs.ts`

Setting key `subscription_prefs`:

```ts
export interface ManualSubscription {
  id: string;                    // short random id
  name: string;
  cents: number;
  cadence: 'monthly' | 'yearly';
  nextDate: string;              // YYYY-MM-DD, as entered or last rolled
  merchant?: string;             // detector key, once linked
}
export interface SubscriptionPrefs {
  v: 1;
  hidden: string[];              // keys
  confirmed: string[];           // detector keys
  names: Record<string, string>; // key → display name
  prevNames: Record<string, string | null>; // one level, for ↩ Undo on rename
  remind: Record<string, 1 | 3 | 7>;        // key → days of warning
  manual: ManualSubscription[];
  deleted: Array<ManualSubscription & { deletedAt: string }>; // ↩ Undo; pruned after 7 days
  declinedLinks: string[];       // `${manualId}|${merchant}`, so a "No" sticks
}
```

- **Keys:** a detected entry's key is the detector's name (as today). A
  hand-added entry's key is `m:<id>`, even after it is linked.
- `parseSubscriptionPrefs(raw)` → `{ kind: 'ok', prefs } | { kind: 'absent' } |
  { kind: 'corrupt' }`.
- `loadSubscriptionPrefs(get)`: absent → built from the two legacy settings
  (nothing hidden or confirmed is lost); corrupt → legacy lists as a read-only
  fallback, flagged `unreadable: true`.
- `editSubscriptionPrefs(get, set, edit)`: **re-reads immediately before
  writing**, applies `edit`, writes the document, and **mirrors `hidden` and
  `confirmed` into the two legacy settings**. Refuses with
  `SubscriptionPrefsUnreadableError` when the stored document is corrupt —
  treating it as empty and saving would wipe every choice.
- The legacy mirror stays for R2 and the release after; removing it is a
  follow-up entry in `docs/superpowers/follow-ups.md`.
- Both writers use this one function: the app through `SecretsStore`
  (`getSubscriptionPrefs?()`, `editSubscriptionPrefs?(edit)`, optional-called
  like every new store method), the companion through `getAddonSecret` /
  `setAddonSecret`.

### B2. The roster — `shared/subscription-roster.ts` (pure)

```ts
export interface RosterEntry {
  key: string;
  displayName: string;           // rename, else manual name, else detector name
  bankName?: string;             // detector name when it differs from displayName
  group: 'subscription' | 'bill' | 'maybe';
  source: 'detected' | 'watched' | 'manual';
  cents: number;                 // per charge; "about" for bills
  cadence: 'monthly' | 'yearly';
  nextDate: string | null;       // null once overdue
  late?: boolean;                // nextDate is past, inside the 7-day grace
  overdueSince?: string;         // predicted date passed more than 7 days ago
  creep?: { fromCents: number; toCents: number; chargedOn: string };
  remind?: 1 | 3 | 7;
  recent: Array<{ date: string; cents: number }>; // newest first, up to 3
  handle: string;                // short hash of key, for button data
}
export interface Roster {
  subscriptions: RosterEntry[]; bills: RosterEntry[]; maybes: RosterEntry[];
  hidden: RosterEntry[];
  monthlyCents: number;          // subscriptions with monthly cadence
  yearlyCents: number;           // yearly ones, NOT divided by 12
  billsMonthlyCents: number;
  linkSuggestions: Array<{ manualId: string; manualName: string;
    merchant: string; date: string; cents: number }>;
  detectionAvailable: boolean;   // false without a cube: hand-added only
}
buildRoster(input: { detected; merchants; links; prefs; today }): Roster
dueWithin(roster, today, days): RosterEntry[]   // date order
```

**Groups:**

- **Subscriptions:** detector tier `subscription`, any confirmed name, watched
  names (confirmed, not detected; priced from recent merchants as the card does
  today), and every hand-added entry.
- **Bills:** detector tier `bill` (monthly, varying amount, 3+ charges), unless
  confirmed, which moves it to Subscriptions. **Listed automatically**; today
  they are asked about as maybes.
- **Maybes:** detector tier `possible`.
- **Hidden:** any of the above whose key is in `hidden`.

**Next charge date:**

- Detected: last charge + 1 month, day clamped to the month's end (31st → 30th
  or 28th/29th; Feb 29 handled). From last charge date, not from the previous
  prediction, so drift self-corrects.
- If that date is past by **≤ 7 days** → `late: true`, still shown.
- Past by **> 7 days** → `nextDate: null`, `overdueSince` set ("expected Oct 3,
  hasn't charged"). The detector drops a merchant 45 days after its last charge,
  so this state lasts about a week before the entry leaves detection.
- Hand-added, unlinked: `nextDate` rolled forward by its cadence until it is
  today or later. No overdue state: there is no charge data to judge by.
- Hand-added, linked, merchant detected: **one row**. Dates, amount, `recent`
  and `creep` come from detection; name, cadence, reminder and key stay the
  hand-added entry's. The detected entry is not listed separately.
- Hand-added, linked, not yet detected (one charge so far): `nextDate` from the
  linked charge's date + one period (written at link time).

**Link suggestions** come from the cube (B3) minus `declinedLinks` and minus
manual entries already linked.

**Consumers** — all switch to `buildRoster`, removing the three copies:
the app card, the reports server's subscriptions section, the companion's
weekly line, the Coming-up block, and `/subscriptions`.

### B3. Report cube additions — `shared/report-cube.ts`

Optional fields, so older cubes still parse and older readers ignore them:

- `DetectedSubscription.recent?: Array<{ date; cents }>` — the newest three
  charges, filled by `detectSubscriptions` (it already holds the list).
- `cube.subscriptionLinks?: Array<{ manualId; merchant; date; cents }>` —
  computed at cube build by the companion, which reads `subscription_prefs`:
  for each unlinked hand-added entry, a charge from the last 45 days that lands
  within **±3 days** of one of its rolled due dates and within **15%** of its
  amount. More than one candidate for one entry → none (an ambiguous match is
  worse than none, as with Amazon). Raw charges stay out of the cube.

Answering **Yes** (`editSubscriptionPrefs`): sets `merchant`, sets `nextDate`
to the charge date + one period, and moves any `hidden`/`remind` entry under
the merchant's key to the manual key. **No** adds to `declinedLinks`.

### B4. Telegram `/subscriptions` — `companion/src/subscriptions-menu.ts`

**Stateless, like `findings-menu.ts`.** Every screen rebuilds the roster at tap
time; buttons carry the entry's `handle`. A handle that no longer resolves gets
"That one is already sorted — refreshing." and the list.

Prefix `cz:sb:`. Screens:

- **List** (paged at 10 rows):
  ```
  💳 Subscriptions · $87.42/mo + $99/yr
  Spotify — $11.99 · next Oct 15 🔔
  Netflix — $17.99 · next Oct 22 · ⬆ was $15.49
  Hulu ✍️ — $9.99 · next Oct 20
  📄 Bills · about $140/mo
  LG&E — about $61 · next Oct 28
  ```
  One button per row, then `[❓ N maybes] [🙈 N hidden] [➕ Add]`. A pending
  link suggestion shows above the list as "Is HULU 877-824 your Hulu?"
  `[Yes] [No]`.
- **Detail:** name (+ bank name), the last 3 charges, next date (or "expected
  Oct 3, hasn't charged"); buttons `🔔 Remind: [1d] [3d] [7d] [Off]` (current
  one marked), `[✏️ Rename]`, `[🙈 Hide / I cancelled it]` — hand-added get
  `[🗑 Delete]` instead — and `[‹ Back]`.
- **Maybes:** each with `[✅ Yes, it's a subscription] [🙈 No]`.
- **Hidden:** each with `[Restore]`.

**Writes** go through `editSubscriptionPrefs`. Instant, no confirm screen,
with `[↩ Undo]` for hide (→ restore), confirm (→ unconfirm), delete (→ restore
from `deleted`), and rename (→ `prevNames`). Remind needs no undo: the four
buttons are the toggle. A corrupt document answers "Couldn't read your
subscription settings — nothing was changed." Wealthfolio unreachable answers
"Couldn't reach Wealthfolio — try again."

**Questions (R1 engine):**

- `➕ Add`: **Name?** → **Amount?** → `[Monthly] [Yearly]` → **Next charge
  date?** (a past date rolls forward to its next occurrence) → **Remind?**
  `[1d] [3d] [7d] [No]` → summary → Save.
- `✏️ Rename`: **New name for SPOTIFY?** → saved, with `↩ Undo`. Empty →
  re-asked.

**Listing:** `/subscriptions` joins `TELEGRAM_MORE_COMMANDS` (the ☰ menu stays
at 7). The weekly report's subscriptions line gains a `[See all]` button.

### B5. The app card — `src/components/budget/ReportView.tsx`

- Renders from `buildRoster`; the local filtering goes.
- Rows gain the next date, 🔔 when a reminder is set, ✍️ for hand-added, and the
  display name.
- **Clicking a row expands it inline:** last 3 charges; `Remind` segmented
  control `Off · 1d · 3d · 7d`; inline Rename field; Hide / I cancelled it
  (keeps the 🎉 message). Hand-added: Edit (amount, cadence, date) and Delete.
- `+ Add subscription` → inline form (name, amount, monthly/yearly, next date,
  remind), validated with the same parsers as Telegram.
- Link suggestion as a row at the top with Yes/No.
- Groups: Subscriptions, Bills (with `Bills ≈ $140/mo`), Maybes ("Is this a
  subscription?"), Hidden (full view, Restore), Watch a merchant (full view,
  unchanged).
- Total line: `$87.42/mo + $99/yr` (yearly part only when non-zero).
- **Without the companion** (`detectionAvailable: false`): hand-added entries
  render and work; the detected area keeps today's hint; the Remind control
  says reminders are sent by the companion and links to Settings' companion
  card (same 2-day freshness test as `companionSyncedRecently`).
- **Wiring:** `SyncPage` loads `getSubscriptionPrefs` once; edits call
  `editSubscriptionPrefs(edit)` and update state from what was written —
  replacing the whole-list snapshot writes. `BudgetTab`/`ReportView` props
  become `subscriptionPrefs` + `onSubscriptionEdit(edit)`.

### B6. Reports

**Daily — "📅 Coming up"**, `formatComingUpBlock(roster, today, detail,
style)` in `shared/telegram.ts`, placed after the spending summary and before
the 🧹 line. Absent when it has nothing to say.

| Line | Shown | Brief | Full |
|---|---|---|---|
| `🔔 Hulu charges in 3 days · $9.99` (→ "tomorrow" → "today") | Each morning from `remind` days before `nextDate` | ✓ | ✓ |
| `Spotify Oct 15 · $11.99 · Rent Oct 16 · $800` | Everything due in the next 7 days not already on a 🔔 line, date order | — | ✓ |
| `📈 Netflix charged $17.99 — up from its usual $15.49.` | The existing creep line, moved here; same 3-morning rule | ✓ | ✓ |
| `✓ Netflix didn't charge Oct 3 — cancelled?` | Days 7–9 after the missed date (`overdueSince`) | ✓ | ✓ |

- Keyboard: `[💳 Subscriptions]` when the block shows (opens the list as a **new
  message**, like the 🧹 button), and `[🙈 Hide Netflix]` for up to two
  "cancelled?" lines (`cz:sb:` hide, with Undo). Existing `[🧹 Show what to fix]`
  row unchanged.
- The archive copy (Reports tab, Web Push) carries the block text without
  buttons.

**Daily report off:** a check at the daily report's scheduled time sends 🔔,
📈 and ✓ lines (no due list) as **one short message**, each event at most once.
Event ids `key|remind|nextDate`, `key|creep|chargedOn`,
`key|cancel|overdueSince` are kept in companion setting
`subscription_news_sent`, pruned after 60 days. A reminder sends on the first
morning inside its window.

**Weekly (Full):** `📅 Next week: 4 charges · $852` under the existing
subscriptions line, which now comes from the roster; `[See all]` opens
`/subscriptions`.

**Reports server:** the subscriptions section renders from the roster (same
names and totals as the card).

---

## Error handling

| Situation | Behavior |
|---|---|
| `subscription_prefs` corrupt | Reads fall back to legacy lists; every write refused with a clear message; nothing overwritten. |
| Two writers at once | Each write re-reads immediately before writing; taps are human-paced. Accepted residual risk. |
| Mixed versions mid-upgrade | `hidden`/`confirmed` mirrored to legacy settings, so an old companion or tab reads correct data. A stale tab's own writes are covered by the existing reload banner. |
| No report cube | Roster has hand-added entries only; `detectionAvailable: false`. |
| Wealthfolio unreachable on a tap | "Couldn't reach Wealthfolio — try again"; no write. |
| Tapped entry gone | "Already sorted — refreshing." |
| Old question's button | "That question has moved on." |
| Bank/user text in Telegram | Escaped with the existing helpers (an unescaped `*` makes Telegram refuse the whole message). |
| Past next date on add | Rolled forward. |
| Empty rename | Re-asked. |
| Month-end and leap days | Clamped; Feb 29 handled. |

## Testing

- **Pure, table-driven:** `ask-flow` (next, retry, back, cancel, summary, seq
  mismatch), parsers (amounts, dates, past-date policy per caller),
  `subscription-prefs` (legacy import, corrupt refusal, mirror, undo fields,
  `deleted` pruning), `subscription-roster` (groups, renames, watched pricing,
  next dates across month ends and Feb 29, late vs overdue, yearly, linked
  absorption, link filtering, totals), `formatComingUpBlock` (Brief/Full,
  absent when empty, no duplicate between 🔔 and due list, escaping).
- **Fixed `now` everywhere** — no test may depend on today's date.
- **Fixtures copy the real cube and secret shapes**; a fixture missing a field
  the real data has has let tests pass vacuously three times before.
- **Companion:** ask sessions (next text answers, command cancels, replace,
  expiry message, restart message), listener `onText` routing and
  never-rejects, routing order (`cz:ak:` and `cz:sb:` before the categorize
  controller), `/pool` `/newrule` `/afford` flows end to end plus every
  existing one-line test unchanged, subscriptions menu (stateless after a
  simulated restart, gone handle, each write + undo), cube link suggestions
  (ambiguity → none), daily block placement and keyboard, report-off
  once-only sends, weekly line.
- **App:** card rows, inline detail, add form validation, link row, hidden
  restore, no-companion view, edit calls `editSubscriptionPrefs` (no snapshot
  writes).
- **Parity test:** one fixture rendered by the app card and the Telegram list
  shows the same names and totals.
- **Gates before each tag:** `npm test`, companion tests, `npm run type-check`,
  **and the companion build** (the root type-check misses companion code).

## Out of scope

- Cancelling at the merchant (bank access is read-only).
- Weekly-cadence subscriptions, and annual detection from bank data.
- Persisting open questions across restarts.
- Removing the legacy-setting mirror (follow-up, one release after R2).
