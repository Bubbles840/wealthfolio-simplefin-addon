# Bank-first card payments, leading references, renamed subscriptions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cash-account payment that names one of your own connected accounts is a held transfer from the moment it posts (A); every pattern builder drops a bank's leading reference token (B), with stored subscription choices still matching (R6); and a subscription survives a renamed charge (C1) and a one-time price step (C2).

**Architecture:** B is one helper, `stripLeadingReference`, inside `categoryRulePattern` (and so inside every key built from it); `rulePatternFor` becomes `categoryRulePattern` of the bank's words. R6 adds one idempotent normalizer, `subscriptionKey` / `normalizeRosterKey`, and routes every stored-name comparison through it. A is a pure decision, `bankFirstTransferOut` (new `shared/bank-first-payment.ts`), called in `runSyncCore`'s per-row typing before the payback and `notTransfer` handling; the existing in-transit path does the rest. C2 (`planChange`) and C1 (`joinRenamedMerchants`, `brandWord`) live in `shared/subscriptions.ts`; C1's `accountId` is threaded from `getNativeMerchantRows` through the cube builder.

**Tech Stack:** TypeScript; vitest (root project: jsdom, `src/` + `shared/`; companion project: node, `companion/src/`); the sync core's fake host (`shared/fake-host.ts`).

**Spec:** `docs/superpowers/specs/2026-10-18-bank-first-payments-design.md` (approved by Nick 2026-10-18, committed at 58ef24f). Its Rulings table (R1–R11) and Tests section bind this plan; read both.

**Target tree:** this repo, branch `feat/bank-first-payments` at 58ef24f. Every block below was applied, task by task, to a scratch clone of that commit, and every FAIL/PASS count was read off that replay (each task's tests run against its parent commit, then against the task's own).

**Execution:** subagent-driven development — one implementer per task, one reviewer per task, tasks in order (each consumes the one before).

## Deviations and readings (decided — do not "fix")

The spec leaves these open or cannot be taken literally; each is the closest faithful version.

1. **The leading reference keeps its slot in the six-token cap.** `categoryRulePattern` trims trailing junk, caps at six tokens, steps the cap back off a junk token, and only then strips the leading reference. Forced by the spec's own R6 acceptance case: the key stored before this change was `*8712 PAYMENT LOUISVILLE GAS & ACH` (six tokens, reference included) and the spec calls the new key `PAYMENT LOUISVILLE GAS & ACH` — so `normalize(oldKey) === newKey(raw)` holds for every stored key only if the cap is applied first. The step-back off a junk token makes the builder idempotent (R6 requires it); it changes the pattern of a 7+-token descriptor whose sixth token is junk (`ONE TWO THREE FOUR FIVE 1234 SEVEN` → `ONE TWO THREE FOUR FIVE`, was `… FIVE 1234`).
2. **`paybackRulePattern` strips the reference BEFORE the cap**, as its old regex did, so every payback pattern built today equals the one built before; only the regex is replaced (R5 forms now stripped too).
3. **`rulePatternFor` returns `''` when the bank words hold no letter or digit** (keeps `***` → `''`, which the transfer flow's eligibility filter relies on). Otherwise it is exactly `categoryRulePattern(bankWords(description).trim())`.
4. **R5's "never the last token that has a letter"**: a text with no lettered token at all is never stripped (`*0082 4471` stays whole).
5. **A needs a KNOWN `CASH` account type.** An unknown type (listAccounts failed) is not evidence of a cash account (R1).
6. **R6 covers hidden, confirmed, a hand-added entry's linked `merchant`, and `declinedLinks`** — in the roster, the prefs edits (hide/unhide, confirm/unconfirm, acceptLink, declineLink), link suggestions, the forecast's bill keys, the companion `/subscriptions` "uc" check and the app card's watch list. `names`, `prevNames` and `remind` stay exact (follow-up). Side effect, pinned by a test: a watched bank name (`HULU 877-824-4858`) now counts as the same entry as its detection (`HULU`) instead of a second row.
7. **C2's card text.** The detector prices a plan change at the NEW price (spec: "a subscription at the newest price"), so the roster's creep line takes its "from" price from `prevCents` when `monthlyCents === lastCents`; that is the only way the card shows "$5.29 → $21.19". `DetectedSubscription`'s shape is unchanged.
8. **C1's details (R8):** "same account" = the old merchant's LAST charge and the new merchant's FIRST charge carry the same `accountId`; "price" = the old merchant's last charge; brand word = the first token of 3+ letters and nothing else after splitting the key on non-alphanumerics (`G1AI101M` is skipped, not cut into `ai`); a chain of renames joins into the oldest name.
9. **The `notTransfer` test fixture is renamed** (`Citi` → `Card`) so the unlink data-safety tests keep testing the unlink, and the one-sided-override behaviour A changes is pinned by a new test instead (Task 5).

## Global Constraints

- **Rulings R1–R11 and the spec's Tests section are binding.** Do not re-open them.
- **Machine load (owner's laptop overheats):** every vitest run is `nice npx vitest run --maxWorkers=2 <files>` from the repo root, or `(cd companion && nice npx vitest run --maxWorkers=2 <files>)` — never `--root`. Run the task's files during its steps; run the FULL suites at most once per task (its last step).
- **Gates:** `npm test` (root), `(cd companion && npx vitest run)`, `npm run type-check`, `nice npm --prefix companion run build` — run with the `nice … --maxWorkers=2` form above.
- **Pre-existing, not this branch's — do not fix:** the main checkout's `node_modules` holds `@wealthfolio/addon-sdk` 3.6.2 (the lock wants ^3.9.0), so at 58ef24f the root suite already has **2 failures** (`src/utils/app-payback.test.ts` "getRules, saveRule…", `src/utils/host-can.test.ts` "declares only functions…") and `npm run type-check` already reports **15 errors**, all in `src/utils/{addon-host,app-payback,host-can,wf-facts}.ts`. A gate passes when nothing NEW fails. (`npm install` clears them; that is the owner's call.) `src/pages/audit-fix-app.test.tsx` can time out under full-suite load; it passes alone.
- **Tests pin their dates** (the suite is also run with the clock forced to 2027): sync tests use `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime`; pure tests pass `now` explicitly. Never depend on the real clock.
- **Fixtures:** no real account numbers beyond the descriptor text the spec quotes; neutral ids (`sfin-spend`, `wf-citi`, …); account names without numbers (`Spend`, `Citi Double Cash® Card`, `Robinhood Credit Card`).
- **Style:** match the surrounding code — long comments that say WHY with live evidence (dates, amounts, descriptors), plain American English, small pure helpers exported for tests.
- **Commits:** `git add` explicit paths only (a worktree may hold `node_modules` symlinks); every message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **No version bumps, no release** (R11: ships in the next release, when Nick asks).

## Review Focus

The five inputs most likely to bite that the spec does not spell out, each pinned by a test in its owning task:

1. **Nick's own 2026-10-17 payment is already stored as a WITHDRAWAL** when this ships. The next sync retypes it; the relink sweep re-creates it asset-free from the comment it read, so the in-transit marker lands one sync later. Expect one row, held, after two syncs (Task 5, "a payment already stored as a WITHDRAWAL…"; the one-sync gap is a follow-up).
2. **Choices saved before this change under a key with a leading reference** (a hidden LG&E bill, a confirmed Venmo maybe, a linked or declined LG&E) keep applying, and Restore / Undo still remove them (Task 2 roster + prefs, Task 3 menu + app card).
3. **A purchase or bill that shares a word with an account** (`CITI TRENDS #1234`, `CITIZENS UTILITY PAYMENT`, `DISCOVERY KIDS`) stays spending: money-movement wording and whole words are both required (Task 4).
4. **The months around a price step**: the step month is a rise, the month after is not, a step DOWN is never a rise, and an odd charge in the middle is a bill (Task 6).
5. **Two same-brand charges that could both continue an old one** are left apart, and a chain of renames joins into the oldest name (Task 7).

## File map

| File | Change |
| --- | --- |
| `shared/rule-pattern.ts` | `stripLeadingReference`; `categoryRulePattern` strips after the cap; `paybackRulePattern` uses the helper (Task 1) |
| `companion/src/transfer-learning.ts` | `rulePatternFor` = `categoryRulePattern(bankWords(…))` (Task 1) |
| `shared/subscriptions.ts` | `subscriptionKey` (Task 2); `planChange` (Task 6); `SubscriptionCharge.accountId`, `brandWord`, `joinRenamedMerchants` (Task 7) |
| `shared/subscription-roster.ts` | `normalizeRosterKey`, `normalizeDeclinedLink`, normalized `buildRoster` (Task 2); creep "from" price (Task 6) |
| `shared/subscription-prefs.ts` | normalized `without` / `withKey`, `acceptLink`, `declineLink` (Task 2) |
| `shared/subscription-links.ts`, `shared/forecast-inputs.ts`, `companion/src/subscriptions-menu.ts`, `src/components/budget/SubscriptionsCard.tsx` | stored names compared normalized (Task 3) |
| `shared/bank-first-payment.ts` (new) | `MONEY_MOVEMENT_WORDS`, `namesConnectedAccount`, `bankFirstTransferOut` (Task 4) |
| `shared/sync-core.ts` | `nameWords` built before the typing loop; A applied where `mapped` is computed (Task 5) |
| `companion/src/sqlite-native.ts`, `companion/src/report-cube-build.ts` | `accountId` on merchant rows and charges (Task 8) |
| `CHANGELOG.md`, `docs/superpowers/follow-ups.md` | Unreleased entry, §19 (Task 8) |

---

### Task 1: B — one leading-reference cleanup for every pattern builder

**Files:**
- Modify: `shared/rule-pattern.ts` (header comment; new `isLeadingReference` + `stripLeadingReference` above `categoryRulePattern`; `categoryRulePattern`; `paybackRulePattern`)
- Modify: `companion/src/transfer-learning.ts:96-113` (`rulePatternFor` at line 106 and its doc comment from line 96)
- Test: `shared/rule-pattern.test.ts`, `shared/subscriptions.test.ts`, `companion/src/transfer-learning.test.ts`

**Interfaces:**
- Consumes: `bankWords(description: string): string` (shared/rule-pattern.ts, existing); `ruleApplies` (shared/mapper.ts, existing, test only).
- Produces: `export function stripLeadingReference(text: string): string` (a verbatim suffix of `text`). `categoryRulePattern`, `paybackRulePattern`, `rulePatternFor` keep their signatures. Tasks 2, 3 and 7 rely on `categoryRulePattern('*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT') === 'PAYMENT LOUISVILLE GAS & ACH'` and on idempotency.

- [ ] **Step 1: Write the failing tests**

In `shared/rule-pattern.test.ts`, change the import to `import { categoryRulePattern, paybackRulePattern, stripLeadingReference } from './rule-pattern.js';` and append:

```ts
describe('leading reference tokens (R5)', () => {
  it('strips a *NNNN reference, so two months of one bill share a pattern', () => {
    // PNC since 2026-09-22: a fresh reference first, the payee after it.
    expect(categoryRulePattern('*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT')).toBe('PAYMENT LOUISVILLE GAS & ACH');
    expect(categoryRulePattern('*9999 PAYMENT LOUISVILLE GAS & ACH DEBIT')).toBe('PAYMENT LOUISVILLE GAS & ACH');
  });

  it('strips a run of 3+ digits and a 6+ character code with 3+ digits', () => {
    expect(stripLeadingReference('4090 E-PAYMENT DISCOVER ACH WEB')).toBe('E-PAYMENT DISCOVER ACH WEB');
    expect(stripLeadingReference('RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT')).toBe('TRANSFER CAPITAL ONE ACH WEB PAYMENT');
    expect(stripLeadingReference('3447db1440b44a1 BILTRENT BILT PAYMENT ACH WEB')).toBe('BILTRENT BILT PAYMENT ACH WEB');
    expect(stripLeadingReference('XX9257 NETFLIX')).toBe('NETFLIX');
    expect(stripLeadingReference('*0082 #4471 PAYMENT CITI AUTOPAY')).toBe('PAYMENT CITI AUTOPAY');
  });

  it('keeps merchant names that merely start with a digit', () => {
    for (const desc of ['7-ELEVEN 35221', '1PASSWORD', '76 FUEL LOUISVILLE KY', 'SQ *COFFEE SHOP #42']) {
      expect(stripLeadingReference(desc)).toBe(desc);
    }
    expect(categoryRulePattern('7-ELEVEN 35221')).toBe('7-ELEVEN');
    expect(categoryRulePattern('76 FUEL LOUISVILLE KY')).toBe('76 FUEL LOUISVILLE KY');
  });

  it('never strips the last token that has a letter', () => {
    expect(stripLeadingReference('XX9257')).toBe('XX9257');
    expect(stripLeadingReference('*0082 4471')).toBe('*0082 4471');
    expect(stripLeadingReference('XX9257 4471')).toBe('XX9257 4471');
  });

  it('returns a verbatim suffix of the text', () => {
    for (const desc of ['*0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR', '4090  E-PAYMENT DISCOVER', 'NETFLIX.COM']) {
      expect(desc.endsWith(stripLeadingReference(desc))).toBe(true);
    }
  });

  it('counts the reference inside the six-token cap, so a key stored before this change normalizes to the new key (R6)', () => {
    // The old pattern of this bill was "*8712 PAYMENT LOUISVILLE GAS & ACH" (six
    // tokens, reference included). Normalizing that stored key must land on
    // exactly the key the same charge gets today.
    expect(categoryRulePattern('*8712 PAYMENT LOUISVILLE GAS & ACH')).toBe(categoryRulePattern('*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT'));
    expect(categoryRulePattern('RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT')).toBe('TRANSFER CAPITAL ONE ACH WEB');
  });

  it('is idempotent, and the cap never ends the pattern on a junk token', () => {
    expect(categoryRulePattern('ONE TWO THREE FOUR FIVE 1234 SEVEN')).toBe('ONE TWO THREE FOUR FIVE');
    for (const desc of [
      '*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT', 'ONE TWO THREE FOUR FIVE 1234 SEVEN', 'CLAUDE.AI *SUB 8ZK1',
      'GOOGLE *G1AI101M MOUNTAIN VIEW CA', '99182', 'XX9257', '',
    ]) {
      expect(categoryRulePattern(categoryRulePattern(desc))).toBe(categoryRulePattern(desc));
    }
  });

  it('leaves descriptors with no leading reference exactly as before', () => {
    expect(categoryRulePattern('GOOGLE *Google One MOUNTAIN VIEW CA')).toBe('GOOGLE *Google One MOUNTAIN VIEW CA');
    expect(categoryRulePattern('PAYMENT ROBINHOOD CCB ACH DEBIT')).toBe('PAYMENT ROBINHOOD CCB ACH DEBIT');
  });

  it('paybackRulePattern strips every R5 reference, not only *NNNN', () => {
    expect(paybackRulePattern('4090 ZELLE FROM JANE DOE ON 10/09 REF # PNCAA0B1C2D3')).toBe('ZELLE FROM JANE DOE');
    expect(paybackRulePattern('*1234 CASHOUT VENMO ACH CREDIT')).toBe('CASHOUT VENMO ACH CREDIT');
  });
});
```

Append to `shared/subscriptions.test.ts` (B's effect on subscription keys; `NOW` there is 2026-09-02):

```ts
describe('leading references (1.63)', () => {
  it('groups one bill across the fresh reference PNC puts in front of each charge', () => {
    const found = detectSubscriptions([
      charge('2026-06-19', '*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT', 6120),
      charge('2026-07-20', '*5521 PAYMENT LOUISVILLE GAS & ACH DEBIT', 7480),
      charge('2026-08-19', '*0937 PAYMENT LOUISVILLE GAS & ACH DEBIT', 5390),
    ], NOW);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ name: 'PAYMENT LOUISVILLE GAS & ACH', kind: 'bill', count: 3 });
  });
});
```

In `companion/src/transfer-learning.test.ts`, add `import { ruleApplies } from '../../shared/mapper.js';` and REPLACE the test `'survives punctuation banks sprinkle through descriptors'` (its `'TST HAMMERHEADS'` expectation is the bug B fixes) with:

```ts
  it('keeps the bank\'s punctuation: a rule is a contains match on the raw text', () => {
    // Stripping it ("TST HAMMERHEADS") built a rule that matched nothing, not
    // even the transaction it was made from.
    expect(rulePatternFor('TST*HAMMERHEADS #12')).toBe('TST*HAMMERHEADS');
  });

  it('drops a leading reference, so the rule matches next month\'s payment too', () => {
    // Live, 2026-10-17: the rule written from this row was
    // "0082 PAYMENT CITI AUTOPAY ACH WEB", which September's *0062 never matched.
    const pattern = rulePatternFor('*0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR');
    expect(pattern).toBe('PAYMENT CITI AUTOPAY ACH WEB-RECUR');
    const rule = { pattern, matchType: 'contains' as const, activityType: 'TRANSFER_OUT' as const };
    expect(ruleApplies(rule, '*0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR', -42.4)).toBe(true);
    expect(ruleApplies(rule, '*0062 PAYMENT CITI AUTOPAY ACH WEB-RECUR', -42.4)).toBe(true);
  });

  it('always matches the transaction it was made from, built from the bank\'s own words', () => {
    for (const desc of [
      '*0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR', 'Payment to Ccb Credit Card Payments', 'TST*HAMMERHEADS #12',
      '4090 E-PAYMENT DISCOVER ACH WEB', 'AMAZON.COM*2K4 · Amazon: Lawn',
    ]) {
      const rule = { pattern: rulePatternFor(desc), matchType: 'contains' as const, activityType: 'TRANSFER_OUT' as const };
      expect(ruleApplies(rule, desc, -1)).toBe(true);
    }
    expect(rulePatternFor('*8768 PAYMENT VENMO ACH WEB · Venmo: Pizza')).toBe('PAYMENT VENMO ACH WEB');
  });
```

The existing `'is empty for a description with nothing to match on'` (`'***'` → `''`) stays as it is.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice npx vitest run --maxWorkers=2 shared/rule-pattern.test.ts shared/subscriptions.test.ts shared/payback-rules.test.ts`
Expected: `9 failed | 78 passed (87)` — `stripLeadingReference is not a function`, and `'*8712 PAYMENT LOUISVILLE GAS & ACH'` where `'PAYMENT LOUISVILLE GAS & ACH'` is expected.

Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/transfer-learning.test.ts)`
Expected: `3 failed | 29 passed (32)` — `'TST HAMMERHEADS'` and `'0082 PAYMENT CITI AUTOPAY ACH WEB'`.

- [ ] **Step 3: Implement**

In `shared/rule-pattern.ts`:
- `const isLeadingReference = (token: string): boolean` — R5 exactly: `/^[*#]\S*\d/` (a `*`/`#` token with a digit), or `/^\d{3,}$/`, or `/^[A-Za-z0-9]{6,}$/` with at least 3 digits.
- `export function stripLeadingReference(text: string): string` — tokens by `/\S+/g`; find the index of the LAST token containing `[a-zA-Z]`; advance from the front while the token is a reference AND its index is below that last lettered index; return `text` unchanged when nothing was stripped, else `text.slice(tokens[first].start)`. Doc comment: the PNC wording change (2026-09-22, `*0082 …` then `*0062 …`), verbatim suffix, never the last lettered token.
- `categoryRulePattern`: keep the trailing-junk walk and the all-junk fallback (`return description`); then `let end = Math.min(last, MAX_TOKENS - 1); while (end > 0 && isJunkToken(tokens[end].text)) end -= 1;` and return `stripLeadingReference(description.slice(tokens[0].start, tokens[end].end))`. Comment both decisions (Deviations 1).
- `paybackRulePattern`: `stripLeadingReference(bankWords(description).trim())` replaces the `.replace(/^[*#]\S*\d\S*\s+/, '')` line; the ` ON MM/DD…` replace and the final `categoryRulePattern(words)` stay. Update its doc comment (Deviations 2).
- File header: the paragraph that begins "Unlike the transfer flow's `rulePatternFor`" now says both builders return a verbatim substring, `rulePatternFor` being built from this one since 1.63.

In `companion/src/transfer-learning.ts`: import `{ bankWords, categoryRulePattern }` from `'../../shared/rule-pattern.js'`; `rulePatternFor(description)` = `const words = bankWords(description).trim(); if (!/[\p{L}\p{N}]/u.test(words)) return ''; return categoryRulePattern(words);`. Rewrite its doc comment: why it must be a verbatim substring (`ruleApplies` is a case-insensitive `contains` on the raw text; `WEB-RECUR` → `WEB RECUR` matched nothing) and the `*0082`/`*0062` live case.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice npx vitest run --maxWorkers=2 shared/rule-pattern.test.ts shared/subscriptions.test.ts shared/payback-rules.test.ts`
Expected: `87 passed (87)`

Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/transfer-learning.test.ts)`
Expected: `32 passed (32)`

- [ ] **Step 5: Run the full suites once**

Run: `nice npx vitest run --maxWorkers=2` then `(cd companion && nice npx vitest run --maxWorkers=2)`
Expected: root `2 failed | 3723 passed (3725)` (the 2 pre-existing SDK failures only); companion `1522 passed (1522)`. No other caller of `categoryRulePattern` (forecast-inputs, category-guess, categorize-menu, subscription-links, companion categorize) changes a test: their fixtures carry no leading reference.

- [ ] **Step 6: Commit**

```bash
git add shared/rule-pattern.ts shared/rule-pattern.test.ts shared/subscriptions.test.ts companion/src/transfer-learning.ts companion/src/transfer-learning.test.ts
git commit -m "$(cat <<'EOF'
Patterns drop a bank's leading reference; transfer rules use the bank's own words

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: R6 core — stored subscription choices are compared through one normalizer

**Files:**
- Modify: `shared/subscriptions.ts` (new `subscriptionKey`; `detectSubscriptions` groups by it)
- Modify: `shared/subscription-roster.ts` (`normalizeRosterKey`, `normalizeDeclinedLink`; `buildRoster`)
- Modify: `shared/subscription-prefs.ts` (`without`, `withKey`, `acceptLink`, `declineLink`)
- Test: `shared/subscriptions.test.ts`, `shared/subscription-roster.test.ts`, `shared/subscription-prefs.test.ts`

**Interfaces:**
- Consumes: `categoryRulePattern` (Task 1).
- Produces (Task 3 uses all three):
  - `export function subscriptionKey(merchant: string): string` in `shared/subscriptions.ts` — `categoryRulePattern(merchant) || merchant`; idempotent.
  - `export function normalizeRosterKey(key: string): string` in `shared/subscription-roster.ts` — `isManualKey(key) ? key : subscriptionKey(key)`.
  - `export function normalizeDeclinedLink(entry: string): string` in `shared/subscription-roster.ts` — splits at the FIRST `|`, normalizes the merchant part with `subscriptionKey`; an entry with no `|` is returned as is.

- [ ] **Step 1: Write the failing tests**

`shared/subscriptions.test.ts`: import `subscriptionKey` beside `detectSubscriptions`, and append:

```ts
describe('subscriptionKey (R6)', () => {
  it('is the detector key, and maps a key stored before 1.63 onto it', () => {
    expect(subscriptionKey('*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT')).toBe('PAYMENT LOUISVILLE GAS & ACH');
    expect(subscriptionKey('*8712 PAYMENT LOUISVILLE GAS & ACH')).toBe('PAYMENT LOUISVILLE GAS & ACH');
    expect(subscriptionKey('HULU 877-824-4858')).toBe('HULU');
  });

  it('is idempotent', () => {
    for (const name of ['*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT', 'HULU 877-824-4858', 'GOOGLE *Google One MOUNTAIN VIEW CA', '99182', '']) {
      expect(subscriptionKey(subscriptionKey(name))).toBe(subscriptionKey(name));
    }
  });
});
```

`shared/subscription-roster.test.ts`: add `normalizeDeclinedLink, normalizeRosterKey` to the import from `'./subscription-roster.js'`, and append (uses the file's `det`, `roster`, `prefsWith`, `names`; `TODAY` is 2026-10-12):

```ts
describe('buildRoster — choices stored under a key from before 1.63 (R6)', () => {
  // 1.63 strips a leading bank reference from the detector's key, so a choice
  // saved under the old key must still find the entry under the new one.
  const OLD = '*8712 PAYMENT LOUISVILLE GAS & ACH';
  const NEW = 'PAYMENT LOUISVILLE GAS & ACH';

  it('normalizes a stored key, leaving hand-added keys and the manual id of a declined link alone', () => {
    expect(normalizeRosterKey(OLD)).toBe(NEW);
    expect(normalizeRosterKey(NEW)).toBe(NEW);
    expect(normalizeRosterKey('m:lge00001')).toBe('m:lge00001');
    expect(normalizeDeclinedLink(`lge00001|${OLD}`)).toBe(`lge00001|${NEW}`);
  });

  it('a hidden name stored under the old key still hides the new key', () => {
    const r = roster({ detected: [det(NEW, { kind: 'bill', monthlyCents: 6149 })], prefs: prefsWith({ hidden: [OLD] }) });
    expect(r.bills).toEqual([]);
    expect(names(r.hidden)).toEqual([NEW]);
    expect(r.billsMonthlyCents).toBe(0);
  });

  it('a confirmed name stored under the old key still counts, with no second watched row', () => {
    const r = roster({
      detected: [det('PAYMENT VENMO ACH WEB', { kind: 'possible', count: 2 })],
      prefs: prefsWith({ confirmed: ['*8768 PAYMENT VENMO ACH WEB'] }),
    });
    expect(r.subscriptions.map((e) => [e.key, e.source])).toEqual([['PAYMENT VENMO ACH WEB', 'detected']]);
    expect(r.maybes).toEqual([]);
  });

  it('a watched bank name is the same entry as its detection', () => {
    const r = roster({ detected: [det('HULU', { kind: 'possible', count: 2, monthlyCents: 999 })], prefs: prefsWith({ confirmed: ['HULU 877-824-4858'] }) });
    expect(r.subscriptions.map((e) => [e.key, e.source])).toEqual([['HULU', 'detected']]);
  });

  it('a hand-added entry linked under the old key still absorbs the detection', () => {
    const lge = { id: 'lge00001', name: 'LG&E', cents: 6000, cadence: 'monthly' as const, nextDate: '2026-10-20', merchant: OLD };
    const r = roster({ detected: [det(NEW, { kind: 'bill', monthlyCents: 6149, lastDate: '2026-10-08' })], prefs: prefsWith({ manual: [lge] }) });
    expect(r.bills).toEqual([]);
    expect(r.subscriptions.map((e) => [e.key, e.cents, e.nextDate])).toEqual([['m:lge00001', 6149, '2026-11-08']]);
  });

  it('a No to a link, stored under the old key, still holds', () => {
    const r = roster({
      prefs: prefsWith({
        manual: [{ id: 'lge00001', name: 'LG&E', cents: 6000, cadence: 'monthly', nextDate: '2026-10-20' }],
        declinedLinks: [`lge00001|${OLD}`],
      }),
      links: [{ manualId: 'lge00001', merchant: NEW, date: '2026-09-19', cents: 6149 }],
    });
    expect(r.linkSuggestions).toEqual([]);
  });
});
```

`shared/subscription-prefs.test.ts` — append (uses the file's `prefs`, `HULU`):

```ts
describe('edits on a key stored before 1.63 (R6)', () => {
  const OLD = '*8712 PAYMENT LOUISVILLE GAS & ACH';
  const NEW = 'PAYMENT LOUISVILLE GAS & ACH';

  it('Restore removes the old key, and hiding again adds no second copy', () => {
    expect(unhideKey(prefs({ hidden: [OLD, 'SPOTIFY'] }), NEW).hidden).toEqual(['SPOTIFY']);
    expect(hideKey(prefs({ hidden: [OLD] }), NEW).hidden).toEqual([OLD]);
  });

  it('unconfirm removes the old key, and confirming again adds no second copy', () => {
    expect(unconfirmKey(prefs({ confirmed: [OLD] }), NEW).confirmed).toEqual([]);
    expect(confirmKey(prefs({ confirmed: [OLD] }), NEW).confirmed).toEqual([OLD]);
  });

  it('accepting a link moves a hide stored under the old key to the hand-added key', () => {
    const p = acceptLink(prefs({ manual: [HULU], hidden: [OLD] }), { manualId: 'hulu0001', merchant: NEW, date: '2026-09-19' });
    expect(p.hidden).toEqual(['m:hulu0001']);
  });

  it('compares hand-added keys exactly', () => {
    expect(unhideKey(prefs({ hidden: ['m:hulu0001'] }), 'm:hulu0002').hidden).toEqual(['m:hulu0001']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice npx vitest run --maxWorkers=2 shared/subscriptions.test.ts shared/subscription-roster.test.ts shared/subscription-prefs.test.ts`
Expected: `11 failed | 118 passed (129)` — `subscriptionKey` / `normalizeRosterKey` are not functions, the old-key hide/confirm/link/decline is not recognised, Restore leaves the old key. ("compares hand-added keys exactly" already passes; it guards the exception.)

- [ ] **Step 3: Implement**

- `shared/subscriptions.ts`: add `subscriptionKey` (doc: idempotent; why stored choices go through it, R6) and use it for the grouping key in `detectSubscriptions` (replacing `categoryRulePattern(c.merchant) || c.merchant`).
- `shared/subscription-roster.ts`: change the type-only import to `import { subscriptionKey, type DetectedSubscription } from './subscriptions.js';` (no cycle: subscriptions.ts imports only rule-pattern). Add the two exported normalizers right after `isManualKey`. In `buildRoster`:
  - `hidden` and `confirmed` sets hold `normalizeRosterKey` of each stored name; `linkedManual` is keyed by `subscriptionKey(m.merchant)`; the manual loop looks up `detectedByName.get(subscriptionKey(m.merchant))`.
  - Watched loop: iterate `prefs.confirmed`, `key = normalizeRosterKey(name)`; skip when `key` was already pushed (a `Set`), is detected, is linked, or `isManualKey(name)`. The entry keeps `key: name` (the stored name), so renames/reminders/prices stored under it still apply.
  - `visible` and the returned `hidden` list test `hidden.has(normalizeRosterKey(e.key))`.
  - `declined` = `new Set(prefs.declinedLinks.map(normalizeDeclinedLink))` (the `${l.manualId}|${l.merchant}` probe is already a detector key).
  - A comment where the sets are built: why (R6, the `*8712 …` example).
- `shared/subscription-prefs.ts`: import `normalizeDeclinedLink, normalizeRosterKey`. `const sameKey = (a, b) => a === b || normalizeRosterKey(a) === normalizeRosterKey(b);` — `without` filters `!sameKey(k, key)`, `withKey` appends only when no `sameKey` entry exists. `acceptLink`'s test becomes `p.hidden.some((k) => sameKey(k, link.merchant))` (its `remind` move stays exact). `declineLink` no longer uses `withKey` (it would normalize the whole `id|merchant` string): it returns `p` unchanged when an existing entry has the same `normalizeDeclinedLink`, else appends `${manualId}|${merchant}`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice npx vitest run --maxWorkers=2 shared/subscriptions.test.ts shared/subscription-roster.test.ts shared/subscription-prefs.test.ts`
Expected: `129 passed (129)`

- [ ] **Step 5: Run the full suites once**

Expected: root `2 failed | 3735 passed (3737)` (pre-existing 2 only); companion `1522 passed (1522)`.

- [ ] **Step 6: Commit**

```bash
git add shared/subscriptions.ts shared/subscriptions.test.ts shared/subscription-roster.ts shared/subscription-roster.test.ts shared/subscription-prefs.ts shared/subscription-prefs.test.ts
git commit -m "$(cat <<'EOF'
Subscription choices saved under an older key still apply (R6)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: R6 everywhere else a stored name meets a detected key

**Files:**
- Modify: `shared/subscription-links.ts:15-18, 49-63` (imports; `findLinkSuggestions`)
- Modify: `shared/forecast-inputs.ts:25, 135-152` (import; `detectorKey`, `billKeys`)
- Modify: `companion/src/subscriptions-menu.ts:27-29, 311` (the `uc` case)
- Modify: `src/components/budget/SubscriptionsCard.tsx:21-24, 409-415` (import; the watch list's `known` set)
- Test: `shared/subscription-links.test.ts`, `shared/forecast-inputs.test.ts`, `companion/src/subscriptions-menu.test.ts`, `src/components/budget/ReportView.test.tsx`

**Interfaces:**
- Consumes: `subscriptionKey` (shared/subscriptions.ts), `normalizeRosterKey`, `normalizeDeclinedLink` (shared/subscription-roster.ts) — Task 2.
- Produces: nothing new.

- [ ] **Step 1: Write the failing tests**

Append to `shared/subscription-links.test.ts` (uses the file's `NOW` = Oct 12, `HULU`, `prefsWith`, `charge`; `ManualSubscription` is already imported):

```ts
describe('names stored under a key from before 1.63 (R6)', () => {
  const LGE: ManualSubscription = { id: 'lge00001', name: 'LG&E', cents: 6149, cadence: 'monthly', nextDate: '2026-10-19' };
  const bill = charge('2026-09-19', '*0937 PAYMENT LOUISVILLE GAS & ACH DEBIT', 6149);

  it('a merchant declined or linked under the old key is not offered again', () => {
    expect(findLinkSuggestions([bill], prefsWith({ manual: [LGE] }), NOW))
      .toEqual([{ manualId: 'lge00001', merchant: 'PAYMENT LOUISVILLE GAS & ACH', date: '2026-09-19', cents: 6149 }]);
    expect(findLinkSuggestions([bill], prefsWith({ manual: [LGE], declinedLinks: ['lge00001|*8712 PAYMENT LOUISVILLE GAS & ACH'] }), NOW))
      .toEqual([]);
    expect(findLinkSuggestions([bill], prefsWith({ manual: [LGE, { ...HULU, merchant: '*8712 PAYMENT LOUISVILLE GAS & ACH' }] }), NOW))
      .toEqual([]);
  });
});
```

In `shared/forecast-inputs.test.ts`, inside `describe('the bills’ past charges', …)`, before `'sums what they charged…'`:

```ts
  it('a hand-added entry linked under a key from before 1.63 counts its charges under today\'s key (R6)', () => {
    const linked = entry({ key: 'm:abc12345', source: 'manual', displayName: 'LG&E' });
    expect([...billKeys([linked], [manual({ merchant: '*8712 PAYMENT LOUISVILLE GAS & ACH' })])]).toEqual(['PAYMENT LOUISVILLE GAS & ACH']);
    expect(detectorKey('*0937 PAYMENT LOUISVILLE GAS & ACH DEBIT · TRN-5')).toBe('PAYMENT LOUISVILLE GAS & ACH');
  });
```

In `companion/src/subscriptions-menu.test.ts`, inside `describe('subscriptions menu', …)`, before `'a maybe answered Yes counts…'`:

```ts
  it('Restore and Undo find a choice stored under a key from before 1.63 (R6)', async () => {
    const LGE = 'PAYMENT LOUISVILLE GAS & ACH';
    const VENMO = 'PAYMENT VENMO ACH WEB';
    const h = harness({
      report_cube: cubeJson([det(LGE, { kind: 'bill' }), det(VENMO, { kind: 'possible', count: 2 })]),
      subscription_prefs: doc({ hidden: ['*8712 PAYMENT LOUISVILLE GAS & ACH'], confirmed: ['*8768 PAYMENT VENMO ACH WEB'] }),
    });
    await h.tap(`cz:sb:u:${H(LGE)}`);
    expect(h.stored().hidden).toEqual([]);
    await h.tap(`cz:sb:uc:${H(VENMO)}`);
    expect(h.stored().confirmed).toEqual([]);
  });
```

In `src/components/budget/ReportView.test.tsx`, inside `describe('subscriptions card: watch + per-item restore', …)`, before `'watch list and watched pricing look back past the current month'`:

```tsx
  it('restores a row hidden under a key from before 1.63, and never offers a known merchant to watch (R6)', () => {
    const onEdit = vi.fn();
    const base = prefsWith({ hidden: ['*8712 PAYMENT LOUISVILLE GAS & ACH'], confirmed: ['PAYMENT VENMO ACH WEB'] });
    render(<ReportView id="subscriptions" customReports={[]} hero
      cube={{
        ...fresh(),
        subscriptions: [sub(), sub({ name: 'PAYMENT LOUISVILLE GAS & ACH', kind: 'bill', monthlyCents: 6149, lastCents: 6149 })],
        merchants: [[], [{ name: '*8768 PAYMENT VENMO ACH WEB', cents: 2000, count: 1 }, { name: 'CHIPOTLE', cents: 4500, count: 3 }]],
      }}
      subscriptionPrefs={base} onSubscriptionEdit={onEdit} />);
    expect(screen.getByRole('button', { name: 'Watch CHIPOTLE' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Watch *8768 PAYMENT VENMO ACH WEB' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restore PAYMENT LOUISVILLE GAS & ACH' }));
    expect(applied(onEdit, base.prefs).hidden).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice npx vitest run --maxWorkers=2 shared/subscription-links.test.ts shared/forecast-inputs.test.ts src/components/budget/ReportView.test.tsx`
Expected: `3 failed | 108 passed (111)` — a suggestion is still offered for the old-key decline/link; `billKeys` returns the old key; the `Watch *8768 …` button is offered.

Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/subscriptions-menu.test.ts)`
Expected: `1 failed | 21 passed (22)` — `confirmed` is still `['*8768 PAYMENT VENMO ACH WEB']` (the `uc` check compares exactly; the Restore half already passes after Task 2).

- [ ] **Step 3: Implement**

- `shared/subscription-links.ts`: import `subscriptionKey` (with `type SubscriptionCharge`) from `./subscriptions.js` and `normalizeDeclinedLink` from `./subscription-roster.js`; drop the `categoryRulePattern` import. `claimed` holds `subscriptionKey(m.merchant)`; `declined` = `new Set(prefs.declinedLinks.map(normalizeDeclinedLink))`; the per-charge key is `subscriptionKey(c.merchant)`. Comment: R6, why.
- `shared/forecast-inputs.ts`: import `subscriptionKey` from `./subscriptions.js`, drop `categoryRulePattern`; `detectorKey` returns `name ? subscriptionKey(name) : ''`; `billKeys` adds `subscriptionKey(merchant)` for a linked hand-added entry (one-line comment: a link saved before 1.63 keeps the reference).
- `companion/src/subscriptions-menu.ts`: import `normalizeRosterKey`; the `uc` guard becomes `!prefs.confirmed.some((k) => normalizeRosterKey(k) === normalizeRosterKey(anywhere.key))` (comment: the Yes may be stored under a pre-1.63 key). `unconfirmKey` already compares normalized (Task 2).
- `src/components/budget/SubscriptionsCard.tsx`: import `normalizeRosterKey`; build `known` from the same four sources `.map(normalizeRosterKey)`, and filter `recentMerchants(cube)` by `!known.has(normalizeRosterKey(m.name))` (comment: a bank name, a detected key and a pre-1.63 choice name one merchant).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice npx vitest run --maxWorkers=2 shared/subscription-links.test.ts shared/forecast-inputs.test.ts src/components/budget/ReportView.test.tsx`
Expected: `111 passed (111)`

Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/subscriptions-menu.test.ts)`
Expected: `22 passed (22)`

- [ ] **Step 5: Run the full suites once**

Expected: root `2 failed | 3738 passed (3740)`; companion `1523 passed (1523)`.

- [ ] **Step 6: Commit**

```bash
git add shared/subscription-links.ts shared/subscription-links.test.ts shared/forecast-inputs.ts shared/forecast-inputs.test.ts companion/src/subscriptions-menu.ts companion/src/subscriptions-menu.test.ts src/components/budget/SubscriptionsCard.tsx src/components/budget/ReportView.test.tsx
git commit -m "$(cat <<'EOF'
Links, bills, /subscriptions and the watch list match pre-1.63 names (R6)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: A — the bank-first decision, as a pure helper

**Files:**
- Create: `shared/bank-first-payment.ts`
- Test: `shared/bank-first-payment.test.ts` (new)

**Interfaces:**
- Consumes: `type MappedType` (shared/mapper.ts); `accountNameWords(name, orgName?)` (shared/sync-core.ts, test only).
- Produces (Task 5 uses `bankFirstTransferOut`):
  - `export const MONEY_MOVEMENT_WORDS: RegExp` — R3, each a whole word, case-insensitive: `/(?<![a-z0-9])(?:payment|pmt|autopay|auto-pmt|e-?pay|e-payment|transfer|ach)(?![a-z0-9])/i`.
  - `export function namesConnectedAccount(description: string, otherAccountWords: ReadonlyArray<readonly string[]>): boolean` — R2: split the lower-cased text on `/[^a-z0-9]+/` (the same split `accountNameWords` uses) and test each account word for whole-word membership.
  - `export function bankFirstTransferOut(description: string, amount: number, accountType: string | undefined, mapped: MappedType, otherAccountWords: ReadonlyArray<readonly string[]>): boolean` — true only when `accountType === 'CASH' && amount < 0 && !mapped.fromRule && mapped.type === 'WITHDRAWAL'` and the text has money-movement wording and names a connected account.

- [ ] **Step 1: Write the failing tests** — create `shared/bank-first-payment.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { bankFirstTransferOut, MONEY_MOVEMENT_WORDS, namesConnectedAccount } from './bank-first-payment.js';
import { accountNameWords } from './sync-core.js';
import type { MappedType } from './mapper.js';

/** The other connected accounts a PNC cash account sees, as the sync builds their words. */
const OTHERS = [
  accountNameWords('Citi Double Cash® Card', 'Citibank'),
  accountNameWords('Robinhood Credit Card'),
  accountNameWords('Robinhood individual'),
  accountNameWords('Discover it Card'),
  accountNameWords('Chase Freedom Unlimited'),
  accountNameWords('360 Performance Savings', 'Capital One'),
];
const WITHDRAWAL: MappedType = { type: 'WITHDRAWAL', fromRule: false };
const bankFirst = (description: string, over: { amount?: number; accountType?: string | undefined; mapped?: MappedType } = {}) =>
  bankFirstTransferOut(description, over.amount ?? -42.4, 'accountType' in over ? over.accountType : 'CASH', over.mapped ?? WITHDRAWAL, OTHERS);

describe('bankFirstTransferOut (A)', () => {
  it('types money out that names a connected account, in money-movement words, as a transfer', () => {
    for (const desc of [
      '*0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR',
      'PAYMENT ROBINHOOD CCB ACH DEBIT',
      'ACH DEBIT ROBINHOOD CCB',
      '4090 E-PAYMENT DISCOVER ACH WEB',
      'RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT',
    ]) {
      expect(bankFirst(desc)).toBe(true);
    }
  });

  it('leaves a bill that names no connected account alone', () => {
    for (const desc of ['*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT', '*8768 PAYMENT VENMO ACH WEB', '3447db1440b44a1 BILTRENT BILT PAYMENT ACH WEB']) {
      expect(bankFirst(desc)).toBe(false);
    }
  });

  it('needs money-movement words: a purchase at a store sharing a word with an account is spending', () => {
    expect(bankFirst('CITI TRENDS #1234 LOUISVILLE KY')).toBe(false);
    expect(bankFirst('DISCOVER BOOKS LOUISVILLE')).toBe(false);
  });

  it('matches whole words only', () => {
    expect(bankFirst('CITIZENS UTILITY PAYMENT')).toBe(false);
    expect(bankFirst('CHASERS SPORTS BAR PAYMENT')).toBe(false);
    expect(namesConnectedAccount('PAYMENT TO DISCOVER', OTHERS)).toBe(true);
    expect(namesConnectedAccount('PAYMENT TO DISCOVERY KIDS', OTHERS)).toBe(false);
  });

  it('covers money out on a cash account only (R1)', () => {
    expect(bankFirst('Credit card cashback rewards of $12.67 transferred to Robinhood Brokerage account', { amount: 12.67 })).toBe(false);
    expect(bankFirst('PAYMENT ROBINHOOD CCB ACH DEBIT', { accountType: 'CREDIT_CARD' })).toBe(false);
    // listAccounts failed: an unknown type is not evidence of a cash account.
    expect(bankFirst('PAYMENT ROBINHOOD CCB ACH DEBIT', { accountType: undefined })).toBe(false);
  });

  it('never overrides a mapping rule, and has nothing to do once the mapper said transfer', () => {
    expect(bankFirst('PAYMENT ROBINHOOD CCB ACH DEBIT', { mapped: { type: 'WITHDRAWAL', fromRule: true } })).toBe(false);
    expect(bankFirst('PAYMENT ROBINHOOD CCB ACH DEBIT', { mapped: { type: 'TRANSFER_OUT', fromRule: false } })).toBe(false);
  });

  it('names nothing when there is no other connected account', () => {
    expect(bankFirstTransferOut('PAYMENT ROBINHOOD CCB ACH DEBIT', -50, 'CASH', WITHDRAWAL, [])).toBe(false);
  });
});

describe('MONEY_MOVEMENT_WORDS (R3)', () => {
  it('knows each phrasing as a whole word, in any case', () => {
    for (const word of ['payment', 'PMT', 'Autopay', 'AUTO-PMT', 'e-pay', 'EPAY', 'E-PAYMENT', 'transfer', 'ACH']) {
      expect(MONEY_MOVEMENT_WORDS.test(`X ${word} Y`)).toBe(true);
    }
  });

  it('does not find them inside other words', () => {
    for (const text of ['ACHIEVE FITNESS', 'PAYMENTUS UTILITIES', 'TRANSFERWISE', 'REPAY ME']) {
      expect(MONEY_MOVEMENT_WORDS.test(text)).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nice npx vitest run --maxWorkers=2 shared/bank-first-payment.test.ts`
Expected: FAIL — `Failed to resolve import "./bank-first-payment.js"` (`Tests  no tests`).

- [ ] **Step 3: Implement `shared/bank-first-payment.ts`** with the three exports above. File header: the 2026-10-17 live case ($42.40 `*0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR`, PNC posted before Citi, asked for a category); the two ways the sync knew a transfer before (wording, the other half); why "names another connected account" (the signal `expiryHoldAccount` already trusts) plus money-movement wording (keeps `CITI TRENDS` a purchase); that a typed row takes the existing in-transit path. `MONEY_MOVEMENT_WORDS` comment: `ach` is there for PNC's pending `ACH DEBIT ROBINHOOD CCB`. `bankFirstTransferOut` doc: R1–R4 in one line each; `otherAccountWords` must leave out the row's own account; `notTransfer` is applied by the caller afterwards, so it still wins.

- [ ] **Step 4: Run the test to verify it passes**

Run: `nice npx vitest run --maxWorkers=2 shared/bank-first-payment.test.ts`
Expected: `9 passed (9)`

- [ ] **Step 5: Run the full suites once**

Expected: root `2 failed | 3747 passed (3749)`; companion `1523 passed (1523)`.

- [ ] **Step 6: Commit**

```bash
git add shared/bank-first-payment.ts shared/bank-first-payment.test.ts
git commit -m "$(cat <<'EOF'
bankFirstTransferOut: money out naming a connected account is a transfer (A)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: A in the sync — typed before payback and `notTransfer`, then the in-transit path

**Files:**
- Modify: `shared/sync-core.ts` — import; build `nameWords` before the per-account typing loop (the `for` at line 2161); per-account `otherAccountWords`; apply A where `mapped` is computed (line 2197); remove the later `nameWords` construction (lines 2350 and 2359) so the expiry hold reads the same map.
- Modify: `shared/sync-core-not-transfer.test.ts` — fixture rename + one new test (Deviations 9).
- Test: `shared/sync-core-bank-first.test.ts` (new)

**Interfaces:**
- Consumes: `bankFirstTransferOut` (Task 4); `accountNameWords` (sync-core.ts, existing).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing tests**

Create `shared/sync-core-bank-first.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { IN_TRANSIT_COMMENT_PREFIX, runSyncCore, VALUATION_POLL } from './sync-core.js';
import type { HostActivity } from './sync-host.js';
import { emptySyncOverrides, setTxOverride } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';
import type { SimplefinTransaction } from './types.js';

const NOW = new Date('2026-10-18T15:00:00Z');
const epoch = (iso: string) => Date.parse(iso) / 1000;
const CITI_PAYMENT = '*0082 PAYMENT CITI AUTOPAY ACH WEB-RECUR';

/** PNC "Spend" and the Citi card, both connected; the Citi feed refreshed now
 *  unless `citiAlive` says otherwise. */
const pncAndCiti = (spend: SimplefinTransaction[], citi: SimplefinTransaction[] = [], extra: Partial<FakeHostSeed> = {}, citiAlive = NOW.toISOString()): FakeHostSeed => ({
  accountSet: { errors: [], accounts: [
    { id: 'sfin-spend', name: 'Spend', org: { name: 'PNC Bank' }, currency: 'USD', balance: '0',
      'balance-date': epoch('2026-10-18T12:00:00Z'), transactions: spend },
    { id: 'sfin-citi', name: 'Citi Double Cash® Card', org: { name: 'Citibank' }, currency: 'USD', balance: '0',
      'balance-date': epoch(citiAlive), transactions: citi },
  ] },
  mapping: { 'sfin-spend': 'wf-spend', 'sfin-citi': 'wf-citi' },
  accountTypes: { 'wf-spend': 'CASH', 'wf-citi': 'CREDIT_CARD' },
  ...extra,
});
const tx = (id: string, iso: string, amount: string, description: string, pending = false): SimplefinTransaction =>
  ({ id, posted: epoch(iso), amount, description, ...(pending ? { pending: true } : {}) });
const rowOf = (rows: HostActivity[] | undefined, txId: string) => (rows ?? []).find((r) => (r.comment ?? '').includes(` · ${txId}`));
const inTransit = (r: HostActivity | undefined) => (r?.comment ?? '').startsWith(IN_TRANSIT_COMMENT_PREFIX);

describe('runSyncCore — a payment naming a connected account is a transfer from the moment it posts (A)', () => {
  beforeEach(() => {
    VALUATION_POLL.delayMs = 1;
    VALUATION_POLL.attempts = 1;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); });

  it("holds PNC's Citi autopay as an in-transit placeholder, then links it when Citi's half posts", async () => {
    // Live, 2026-10-17: PNC posted first and the $42.40 asked for a category.
    const first = createFakeHost(pncAndCiti([tx('pnc-1', '2026-10-17T12:00:00Z', '-42.40', CITI_PAYMENT)]));
    await runSyncCore(first.host, first.store, {});
    const held = rowOf(first.activities.get('wf-spend'), 'pnc-1');
    expect(held).toMatchObject({ activityType: 'TRANSFER_OUT', amount: 42.4 });
    expect(inTransit(held)).toBe(true);
    expect(first.links).toEqual([]);

    vi.setSystemTime(new Date('2026-10-19T15:00:00Z'));
    const second = createFakeHost(pncAndCiti(
      [tx('pnc-1', '2026-10-17T12:00:00Z', '-42.40', CITI_PAYMENT)],
      [tx('citi-1', '2026-10-19T12:00:00Z', '42.40', 'AUTOPAY 000000000000000RAUTOPAY AUTO-PMT')],
      { existing: first.activities },
    ));
    await runSyncCore(second.host, second.store, { force: true });
    expect(second.links).toHaveLength(1);
    const out = rowOf(second.activities.get('wf-spend'), 'pnc-1');
    const into = rowOf(second.activities.get('wf-citi'), 'citi-1');
    expect([out?.activityType, into?.activityType]).toEqual(['TRANSFER_OUT', 'TRANSFER_IN']);
    expect(inTransit(out)).toBe(false);
  });

  it("holds PNC's pending wording too: a pending row never pairs, but it is a placeholder", async () => {
    const seed = pncAndCiti([tx('pnc-p', '2026-10-17T12:00:00Z', '-55.00', 'ACH DEBIT ROBINHOOD CCB', true)]);
    seed.accountSet!.accounts.push({ id: 'sfin-rh', name: 'Robinhood Credit Card', currency: 'USD', balance: '0',
      'balance-date': epoch('2026-10-18T12:00:00Z'), transactions: [] });
    seed.mapping!['sfin-rh'] = 'wf-rh';
    seed.accountTypes!['wf-rh'] = 'CREDIT_CARD';
    const fh = createFakeHost(seed);
    await runSyncCore(fh.host, fh.store, {});
    const held = rowOf(fh.activities.get('wf-spend'), 'pnc-p');
    expect(held?.activityType).toBe('TRANSFER_OUT');
    expect(inTransit(held)).toBe(true);
  });

  it('leaves alone: money in, bills naming no account, a card charge, a ruled row, an undone row, and a row naming only its own account', async () => {
    const seed = pncAndCiti([
      tx('gas', '2026-10-15T12:00:00Z', '-61.20', '*8712 PAYMENT LOUISVILLE GAS & ACH DEBIT'),
      tx('venmo', '2026-10-15T12:00:00Z', '-25.00', '*8768 PAYMENT VENMO ACH WEB'),
      tx('ruled', '2026-10-16T12:00:00Z', '-42.40', CITI_PAYMENT),
      tx('undone', '2026-10-16T12:00:00Z', '-77.00', 'PAYMENT ROBINHOOD CCB ACH DEBIT'),
    ], [tx('card-neg', '2026-10-16T12:00:00Z', '-19.99', 'ROBINHOOD PAYMENT')], {
      mappingRules: [{ pattern: 'PAYMENT CITI AUTOPAY', matchType: 'contains', activityType: 'WITHDRAWAL' }],
      syncOverrides: setTxOverride(emptySyncOverrides(), accountTxKey('sfin-spend', 'undone'), 'notTransfer', NOW),
    });
    seed.accountSet!.accounts.push(
      { id: 'sfin-rh', name: 'Robinhood Credit Card', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-18T12:00:00Z'), transactions: [] },
      { id: 'sfin-rhi', name: 'Robinhood individual', currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-18T12:00:00Z'),
        transactions: [tx('cashback', '2026-10-16T12:00:00Z', '12.67', 'Credit card cashback rewards of $12.67 transferred to Robinhood Brokerage account')] },
      { id: 'sfin-360', name: '360 Checking', org: { name: 'Capital One' }, currency: 'USD', balance: '0', 'balance-date': epoch('2026-10-18T12:00:00Z'),
        transactions: [tx('own', '2026-10-16T12:00:00Z', '-100.00', 'RT08C248B2E7C8B TRANSFER CAPITAL ONE ACH WEB PAYMENT')] },
    );
    Object.assign(seed.mapping!, { 'sfin-rh': 'wf-rh', 'sfin-rhi': 'wf-rhi', 'sfin-360': 'wf-360' });
    Object.assign(seed.accountTypes!, { 'wf-rh': 'CREDIT_CARD', 'wf-rhi': 'CASH', 'wf-360': 'CASH' });
    const fh = createFakeHost(seed);
    const result = await runSyncCore(fh.host, fh.store, {});
    expect(result.errors).toEqual([]);
    const typed = (wf: string, id: string) => {
      const r = rowOf(fh.activities.get(wf), id);
      return [r?.activityType, inTransit(r)];
    };
    expect(typed('wf-spend', 'gas')).toEqual(['WITHDRAWAL', false]);
    expect(typed('wf-spend', 'venmo')).toEqual(['WITHDRAWAL', false]);
    expect(typed('wf-spend', 'ruled')).toEqual(['WITHDRAWAL', false]);
    expect(typed('wf-spend', 'undone')).toEqual(['WITHDRAWAL', false]);
    expect(typed('wf-citi', 'card-neg')).toEqual(['WITHDRAWAL', false]);
    expect(typed('wf-rhi', 'cashback')).toEqual(['DEPOSIT', false]);
    expect(typed('wf-360', 'own')).toEqual(['WITHDRAWAL', false]);
  });

  it('past the 10 days it gives up: ordinary spending, marked Needs review', async () => {
    const fh = createFakeHost(pncAndCiti([tx('pnc-old', '2026-10-05T12:00:00Z', '-42.40', CITI_PAYMENT)]));
    await runSyncCore(fh.host, fh.store, {});
    const create = fh.saved.flatMap((r) => r.creates ?? []).find((c) => c.comment.includes('pnc-old'))!;
    expect(create).toMatchObject({ activityType: 'WITHDRAWAL', needsReview: true });
    expect(create.comment.startsWith(IN_TRANSIT_COMMENT_PREFIX)).toBe(false);
  });

  it("past the 10 days, a dead Citi feed still holds the payment that names it", async () => {
    const fh = createFakeHost(pncAndCiti([tx('pnc-old', '2026-10-05T12:00:00Z', '-42.40', CITI_PAYMENT)], [], {}, '2026-08-18T12:00:00Z'));
    await runSyncCore(fh.host, fh.store, {});
    const held = rowOf(fh.activities.get('wf-spend'), 'pnc-old');
    expect(held?.activityType).toBe('TRANSFER_OUT');
    expect(inTransit(held)).toBe(true);
  });

  it('a payment already stored as a WITHDRAWAL (before 1.63) becomes the placeholder within two syncs, as one row', async () => {
    // The first sync retypes it TRANSFER_OUT and the relink sweep re-creates it
    // asset-free from the comment it read, so the in-transit marker lands on
    // the second sync (follow-up: the sweep could carry the marker itself).
    const fh = createFakeHost(pncAndCiti([tx('pnc-1', '2026-10-17T12:00:00Z', '-42.40', CITI_PAYMENT)], [], {
      existing: new Map([['wf-spend', [{ id: 'old-1', accountId: 'wf-spend', activityType: 'WITHDRAWAL', date: '2026-10-17', amount: 42.4,
        comment: `${CITI_PAYMENT} · pnc-1`, sourceGroupId: null, assetId: '$CASH-USD' }]]]),
    }));
    for (let run = 0; run < 2; run += 1) {
      const r = await runSyncCore(fh.host, fh.store, { force: true });
      expect(r.errors).toEqual([]);
    }
    const rows = fh.activities.get('wf-spend')!;
    expect(rows).toHaveLength(1);
    expect(rows[0].activityType).toBe('TRANSFER_OUT');
    expect(inTransit(rows[0])).toBe(true);
  });
});
```

In `shared/sync-core-not-transfer.test.ts`:
- Rename the card's SimpleFin account in BOTH places from `name: 'Citi'` to `name: 'Card'` (the `twoAccounts` fixture, ~line 34, and the `two(…)` builder in "counts pairs, not legs", ~line 393), and extend the `twoAccounts` doc comment: the name is generic on purpose, because since 1.63 a cash leg whose text names a connected account is a transfer from the moment it posts (A), which would turn these unlink tests into tests of that typing; the naming case is pinned at the end of the file.
- Add `IN_TRANSIT_COMMENT_PREFIX` to the `./sync-core.js` import, and append inside the top-level `describe('runSyncCore — notTransfer', …)`:

```ts
  it('one override on the card leg, the cash leg naming the card: the cash leg stays a transfer and is held (1.63, A)', async () => {
    // Before 1.63 the cash leg became ordinary spending. Now its text names a
    // connected account ("CITI" and a card called "Citi"), so it is the paying
    // half of a transfer whose other half was undone: held, as the card leg is
    // when the override sits on the cash side. Undo marks BOTH legs, so this
    // takes a one-sided override. The first sync unlinks; the second retypes
    // the stored WITHDRAWAL (the relink sweep re-creates it asset-free, without
    // the in-transit marker); the third marks it.
    const seed = twoAccounts({ existing: linkedRows(), syncOverrides: notTransfer(IN), upstreamWriteRules: true });
    seed.accountSet!.accounts[1].name = 'Citi';
    const fh = createFakeHost(seed);
    for (let run = 0; run < 3; run += 1) {
      const r = await runSyncCore(fh.host, fh.store, run === 0 ? {} : { force: true });
      expect(r.errors).toEqual([]);
    }
    expect(fh.links).toEqual([]);
    expect(fh.activities.get('wf-b')!.map((r) => r.activityType)).toEqual(['CREDIT']);
    expect(fh.activities.get('wf-a')!.map((r) => [r.activityType, r.comment])).toEqual([
      ['TRANSFER_OUT', `${IN_TRANSIT_COMMENT_PREFIX}CITI AUTOPAY PAYMENT · tx-out`],
    ]);
  });
```

(Repeated syncs run on ONE fake host: each new host restarts its ids at `fh-1`, so a second host built on the first one's rows collides ids.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice npx vitest run --maxWorkers=2 shared/sync-core-bank-first.test.ts shared/sync-core-not-transfer.test.ts`
Expected: `6 failed | 72 passed (78)` — the held/linked, pending, past-the-window, dead-feed and stored-WITHDRAWAL tests see `WITHDRAWAL` (and no `needsReview`); the new not-transfer test sees `WITHDRAWAL`. The "leaves alone" test and the renamed-fixture tests already pass (they guard R1–R4 and the unlink once A exists).

- [ ] **Step 3: Implement in `shared/sync-core.ts`**

- `import { bankFirstTransferOut } from './bank-first-payment.js';` beside the mapper import.
- Immediately before `for (const sfAccount of accountSet.accounts) { const wfAccountId = mapping[sfAccount.id]; if (!wfAccountId) {` (the typing loop, after `venmoMatches`), build `const nameWords = new Map<string, string[]>()` with `accountNameWords(sfAccount.name, sfAccount.org?.name)` for every MAPPED account (comment: built once, before typing, because typing needs it — spec A; the expiry hold reads the same map).
- Inside the loop, after `const prepared: PreparedTx[] = [];`: `const otherAccountWords = [...nameWords].filter(([id]) => id !== sfAccount.id).map(([, words]) => words);` (R2: the row's own account never counts).
- Rename the `mapTransactionWithSource(...)` result to `builtIn` and add:

```ts
      const mapped = bankFirstTransferOut(tx.description, amount, acctType, builtIn, otherAccountWords)
        ? { ...builtIn, type: 'TRANSFER_OUT' as ActivityType }
        : builtIn;
```

  with a comment: the live case; decided HERE, before the payback and `notTransfer` handling below, so both still win (R4); a mapping rule already won inside the helper; from here the in-transit path does the rest (placeholder, link, expiry, dead-feed hold). `tx.description` is the bank's raw text (enrichment comes later). Everything below `mapped` stays as it is.
- In the in-transit block (lines 2350 and 2359), delete `const nameWords = new Map<string, string[]>();` and the `nameWords.set(...)` line from the `feedAliveEpoch` loop; `expiryHoldAccount(…, { nameWords })` now reads the map built above (same contents: mapped accounts only).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice npx vitest run --maxWorkers=2 shared/sync-core-bank-first.test.ts shared/sync-core-not-transfer.test.ts`
Expected: `78 passed (78)`

- [ ] **Step 5: Run the full suites once, and type-check**

Expected: root `2 failed | 3754 passed (3756)`; companion `1523 passed (1523)`; `npm run type-check` still exactly the 15 pre-existing errors (the new test file must add none — note `HostActivity.comment` is nullable, hence `r.comment ?? ''`).

- [ ] **Step 6: Commit**

```bash
git add shared/sync-core.ts shared/sync-core-bank-first.test.ts shared/sync-core-not-transfer.test.ts
git commit -m "$(cat <<'EOF'
A payment naming a connected account is held as a transfer from the moment it posts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: C2 — a price step is a plan change, not a bill

**Files:**
- Modify: `shared/subscriptions.ts` (`PLAN_PRICE_AGREEMENT`, `planChange`, the tier/price/creep lines in `detectSubscriptions`, the `monthlyCents` doc)
- Modify: `shared/subscription-roster.ts` (`fromDetection`'s creep "from" price)
- Test: `shared/subscriptions.test.ts`, `shared/subscription-roster.test.ts`

**Interfaces:**
- Consumes: `AMOUNT_TOLERANCE` (0.15), `median`, the trailing-three `recent` (existing).
- Produces: internal `function planChange(recent: readonly SubscriptionCharge[]): { steppedNow: boolean } | null`; `const PLAN_PRICE_AGREEMENT = 0.02`.

- [ ] **Step 1: Write the failing tests**

Append to `shared/subscriptions.test.ts` (`NOW` there is 2026-09-02):

```ts
describe('a price step is a plan change (C2, 1.63)', () => {
  it('in the month the price goes up: a subscription at the new price, flagged as a rise', () => {
    // Nick's Google One as it stood on 2026-09-10: $5.29 for three months, then
    // the upgrade. Before 1.63 the step made it a "bill" priced at $5.29.
    const found = detectSubscriptions([
      charge('2026-06-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 529),
      charge('2026-06-10', 'Google One Mountain View CA', 2649),
      charge('2026-07-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 529),
      charge('2026-08-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 529),
      charge('2026-09-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 2119),
    ], new Date('2026-09-10T12:00:00Z'));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      name: 'GOOGLE *Google One MOUNTAIN VIEW CA', kind: 'subscription', monthlyCents: 2119,
      lastCents: 2119, prevCents: 529, count: 4, creep: true,
    });
  });

  it('the month after: still a subscription at the new price, no longer a rise', () => {
    const found = detectSubscriptions([
      charge('2026-06-14', 'CLAUDE.AI SUBSCRIPTION', 2000),
      charge('2026-07-14', 'CLAUDE.AI SUBSCRIPTION', 10000),
      charge('2026-08-14', 'CLAUDE.AI SUBSCRIPTION', 10000),
    ], NOW);
    expect(found[0]).toMatchObject({ kind: 'subscription', monthlyCents: 10000, creep: false });
  });

  it('a step down is a plan change too, never a rise', () => {
    const found = detectSubscriptions([
      charge('2026-06-03', 'PEACOCK TV', 1500),
      charge('2026-07-03', 'PEACOCK TV', 1500),
      charge('2026-08-03', 'PEACOCK TV', 999),
    ], NOW);
    expect(found[0]).toMatchObject({ kind: 'subscription', monthlyCents: 999, creep: false });
  });

  it('"agree" is within 2% (R9): a near-repeat then a jump is a step, a wider pair is not', () => {
    const run = (b: number) => detectSubscriptions([
      charge('2026-06-03', 'ACME STORAGE', 5000),
      charge('2026-07-03', 'ACME STORAGE', b),
      charge('2026-08-03', 'ACME STORAGE', 9000),
    ], NOW)[0];
    expect(run(5100)).toMatchObject({ kind: 'subscription', monthlyCents: 9000, creep: true });
    expect(run(5110).kind).toBe('bill');
  });

  it('charges that wander stay a bill, and so does an odd one in the middle', () => {
    const lge = detectSubscriptions([
      charge('2026-06-03', 'LOUISVILLE GAS & ELECTRIC', 8412),
      charge('2026-07-03', 'LOUISVILLE GAS & ELECTRIC', 10233),
      charge('2026-08-03', 'LOUISVILLE GAS & ELECTRIC', 7655),
    ], NOW);
    expect(lge[0]).toMatchObject({ kind: 'bill', creep: false });
    const middle = detectSubscriptions([
      charge('2026-06-06', 'GOOGLE *Google One', 529),
      charge('2026-07-06', 'GOOGLE *Google One', 2119),
      charge('2026-08-06', 'GOOGLE *Google One', 529),
    ], NOW);
    expect(middle[0].kind).toBe('bill');
  });
});
```

In `shared/subscription-roster.test.ts`, inside `describe('buildRoster — what detection adds', …)`, before `'lists the newest three charges…'`:

```ts
  it('a plan change shows the old price beside the new one in the month it steps (C2)', () => {
    // The detector prices a step at the NEW price, so the old one is prevCents.
    const e = roster({ detected: [det('GOOGLE *Google One MOUNTAIN VIEW CA', {
      monthlyCents: 2119, lastCents: 2119, prevCents: 529, creep: true, lastDate: '2026-09-06',
    })] }).subscriptions[0];
    expect(e.cents).toBe(2119);
    expect(e.creep).toEqual({ fromCents: 529, toCents: 2119, chargedOn: '2026-09-06' });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice npx vitest run --maxWorkers=2 shared/subscriptions.test.ts shared/subscription-roster.test.ts`
Expected: `5 failed | 80 passed (85)` — `kind: 'bill'` priced at the median where a subscription at the new price is expected; the roster's `fromCents` is 2119. ("charges that wander…" already passes; it guards bills.)

- [ ] **Step 3: Implement**

In `shared/subscriptions.ts`, after `DAY_MS`: `const PLAN_PRICE_AGREEMENT = 0.02;` and `planChange(recent)` — null unless exactly three charges `[a, b, c]` (cents); `agree(x, y)` = `|x − y| ≤ max(x, y) × PLAN_PRICE_AGREEMENT`; `apart(odd, price)` = `|odd − price| > price × AMOUNT_TOLERANCE`; `agree(a, b) && apart(c, b)` → `{ steppedNow: true }`; else `agree(b, c) && apart(a, b)` → `{ steppedNow: false }`; else null. Doc comment: the Google One live case (Sep 6 upgrade read as a $5.29 bill), why gas & electric stays a bill, what `steppedNow` means. In `detectSubscriptions`:
- `const change = list.length >= 3 && !stable ? planChange(recent) : null;` before the tier;
- 3+ charges: `kind = stable || change ? 'subscription' : 'bill'` (the two-charge branch is untouched — R9);
- `monthlyCents: change ? last.cents : <the existing expression>`;
- `creep: kind === 'subscription' && ((stable && last.cents > typical) || (!!change?.steppedNow && last.cents > recent[1].cents))`, commented "a step up is a rise in the month it lands, and only then".
- `DetectedSubscription.monthlyCents` doc: "…or, after a plan change (C2, 1.63), the newest charge."

In `shared/subscription-roster.ts` `fromDetection`, the creep object's `fromCents` becomes `d.lastCents === d.monthlyCents && d.prevCents !== undefined ? d.prevCents : d.monthlyCents`, with a comment (Deviations 7). A stable creep always has `lastCents > monthlyCents`, so its text is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice npx vitest run --maxWorkers=2 shared/subscriptions.test.ts shared/subscription-roster.test.ts`
Expected: `85 passed (85)`

- [ ] **Step 5: Run the full suites once**

Expected: root `2 failed | 3760 passed (3762)`; companion `1523 passed (1523)`.

- [ ] **Step 6: Commit**

```bash
git add shared/subscriptions.ts shared/subscriptions.test.ts shared/subscription-roster.ts shared/subscription-roster.test.ts
git commit -m "$(cat <<'EOF'
A one-time price step is a plan change: a subscription at the new price (C2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: C1 — a renamed charge joins its old name

**Files:**
- Modify: `shared/subscriptions.ts` (`SubscriptionCharge.accountId`; `brandWord`; `joinRenamedMerchants`; `detectSubscriptions` sorts each group, then iterates the joined groups)
- Test: `shared/subscriptions.test.ts`

**Interfaces:**
- Consumes: `MIN_GAP_DAYS` (24), `MAX_GAP_DAYS` (38), `AMOUNT_TOLERANCE` (0.15), `DAY_MS`; `subscriptionKey` grouping (Task 2); `planChange` (Task 6).
- Produces (Task 8 relies on the field):
  - `SubscriptionCharge` gains `accountId?: string` (doc: the Wealthfolio account charged; a charge without one is never joined).
  - `export function brandWord(key: string): string | null` — the first token of `key.toLowerCase().split(/[^a-z0-9]+/)` matching `/^[a-z]{3,}$/`, else null.
  - internal `function joinRenamedMerchants(groups: Map<string, SubscriptionCharge[]>): Map<string, SubscriptionCharge[]>` (lists sorted oldest first).

- [ ] **Step 1: Write the failing tests**

In `shared/subscriptions.test.ts` change the import to `import { brandWord, detectSubscriptions, subscriptionKey, type SubscriptionCharge } from './subscriptions.js';` and append:

```ts
describe('a renamed charge is the same subscription (C1, 1.63)', () => {
  const g = (date: string, merchant: string, cents: number, accountId: string | null = 'wf-citi'): SubscriptionCharge =>
    ({ date, merchant, cents, ...(accountId ? { accountId } : {}) });
  /** Nick's six Google rows on the Citi card. Google renamed the charge on Oct 6. */
  const GOOGLE = (): SubscriptionCharge[] => [
    g('2026-06-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 529),
    g('2026-06-10', 'Google One Mountain View CA', 2649),
    g('2026-07-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 529),
    g('2026-08-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 529),
    g('2026-09-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 2119),
    g('2026-10-06', 'GOOGLE *G1AI101M MOUNTAIN VIEW CA', 2119),
  ];
  const withOct = (over: Partial<SubscriptionCharge>) => [...GOOGLE().slice(0, 5), { ...GOOGLE()[5], ...over }];
  const OCT_22 = new Date('2026-10-22T12:00:00Z');

  it.each(['2026-10-18', '2026-10-22'])("Nick's Google One on %s: one subscription at $21.19, five charges, under the older name", (day) => {
    expect(detectSubscriptions(GOOGLE(), new Date(`${day}T12:00:00Z`))).toEqual([expect.objectContaining({
      name: 'GOOGLE *Google One MOUNTAIN VIEW CA', kind: 'subscription', monthlyCents: 2119, count: 5,
      lastDate: '2026-10-06', lastCents: 2119, creep: false,
    })]);
  });

  it('never joins charges on different accounts', () => {
    const moved = withOct({ accountId: 'wf-chase' });
    expect(detectSubscriptions(moved, new Date('2026-10-18T12:00:00Z'))).toEqual([expect.objectContaining({ count: 4, lastDate: '2026-09-06' })]);
    expect(detectSubscriptions(moved, OCT_22)).toEqual([]);
  });

  it('joins nothing without an account', () => {
    expect(detectSubscriptions(GOOGLE().map(({ accountId: _a, ...c }) => c), OCT_22)).toEqual([]);
  });

  it.each([
    ['a different price', { cents: 2649 }],
    ['a charge off the monthly date', { date: '2026-10-20' }],
    ['a different brand', { merchant: 'YOUTUBE PREMIUM 650-253-0000' }],
  ])('leaves a new merchant apart at %s', (_why, over) => {
    expect(detectSubscriptions(withOct(over), OCT_22)).toEqual([]);
  });

  it('leaves it apart when two new merchants could continue the old one', () => {
    const two = [...GOOGLE(), g('2026-10-07', 'GOOGLE *G1XX999Z MOUNTAIN VIEW CA', 2119)];
    expect(detectSubscriptions(two, OCT_22)).toEqual([]);
  });

  it('needs two charges under the old name', () => {
    const one = [g('2026-09-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 2119), g('2026-10-06', 'GOOGLE *G1AI101M MOUNTAIN VIEW CA', 2119)];
    expect(detectSubscriptions(one, OCT_22)).toEqual([]);
  });

  it('follows a chain of renames back to the oldest name', () => {
    const chain = [
      g('2026-06-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 999), g('2026-07-06', 'GOOGLE *Google One MOUNTAIN VIEW CA', 999),
      g('2026-08-06', 'GOOGLE STORAGE 855-836-3987', 999), g('2026-09-06', 'GOOGLE STORAGE 855-836-3987', 999),
      g('2026-10-06', 'GOOGLE *G1AI101M MOUNTAIN VIEW CA', 999),
    ];
    expect(detectSubscriptions(chain, OCT_22)).toEqual([expect.objectContaining({
      name: 'GOOGLE *Google One MOUNTAIN VIEW CA', kind: 'subscription', count: 5, monthlyCents: 999,
    })]);
  });

  it('takes the brand from the first all-letters word of 3+ letters (R8)', () => {
    expect(brandWord('GOOGLE *G1AI101M MOUNTAIN VIEW CA')).toBe('google');
    expect(brandWord('SQ *BLUE BOTTLE')).toBe('blue');
    expect(brandWord('NETFLIX.COM')).toBe('netflix');
    expect(brandWord('G1AI101M MOUNTAIN VIEW')).toBe('mountain');
    expect(brandWord('99182')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nice npx vitest run --maxWorkers=2 shared/subscriptions.test.ts`
Expected: `4 failed | 38 passed (42)` — Oct 18 gives the 4-charge `GOOGLE *Google One` entry, Oct 22 and the chain give `[]`, `brandWord is not a function`. (The "left apart" cases already pass; they guard R8.)

- [ ] **Step 3: Implement**

`joinRenamedMerchants(groups)`, doc comment carrying the live case (Google renamed the charge on 2026-10-06; by Oct 22 the old name was silent 46 days and the new one had one charge, so the subscription vanished) and R8 in one sentence:
1. Candidate pairs over the ORIGINAL groups, `(oldKey, nextKey)`, `oldKey !== nextKey`, all of: `old.length >= 2`; `old`'s last charge has an `accountId` equal to `next[0].accountId`; `brandWord(oldKey)` non-null and equal to `brandWord(nextKey)`; the day gap from old's last date to `next[0].date` within `[MIN_GAP_DAYS, MAX_GAP_DAYS]`; `|next[0].cents − oldLast.cents| ≤ oldLast.cents × AMOUNT_TOLERANCE`.
2. Keep a pair only when its old key appears in exactly one pair as the old side AND its next key in exactly one pair as the next side (anything ambiguous is left apart).
3. Every key that is not a kept pair's next side starts a result entry under its own key; follow kept pairs from it (old → next → next…), appending each continuation's charges. Dates only increase along a chain, so it terminates.

In `detectSubscriptions`, after grouping: sort every group's list oldest first (move the existing per-group `list.sort` here), then loop over `joinRenamedMerchants(byMerchant)` instead of `byMerchant`. The joined entry keeps the OLDER key as `name`, which is where hidden/confirmed/linked choices live.

- [ ] **Step 4: Run the test to verify it passes**

Run: `nice npx vitest run --maxWorkers=2 shared/subscriptions.test.ts`
Expected: `42 passed (42)`

- [ ] **Step 5: Run the full suites once, and type-check**

Expected: root `2 failed | 3771 passed (3773)`; companion `1523 passed (1523)`; type-check: the 15 pre-existing errors only.

- [ ] **Step 6: Commit**

```bash
git add shared/subscriptions.ts shared/subscriptions.test.ts
git commit -m "$(cat <<'EOF'
A renamed charge on the same account joins its old subscription (C1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: C1 in the companion — merchant rows carry their account; docs

**Files:**
- Modify: `companion/src/sqlite-native.ts:1332-1347` (`getNativeMerchantRows`)
- Modify: `companion/src/report-cube-build.ts:224-230` (`datedCharges`)
- Modify: `CHANGELOG.md` (`## [Unreleased]`), `docs/superpowers/follow-ups.md` (new §19 before "## Reference: name mismatches…")
- Test: `companion/src/sqlite-native.test.ts`, `companion/src/report-cube-build.test.ts`

**Interfaces:**
- Consumes: `SubscriptionCharge.accountId` (Task 7); `line.row.accountId` (readSpendLines, existing).
- Produces: `getNativeMerchantRows(...)` returns `Array<{ month: string; date: string; notes: string; amount: number; accountId: string }>`. Other readers of these rows (`cash-forecast-facts` via `MerchantRow`) ignore the extra field.

- [ ] **Step 1: Write the failing tests**

In `companion/src/sqlite-native.test.ts`, the two `getNativeMerchantRows` row expectations gain the account (they use `toContainEqual`, which is exact):
- in `'getNativeMerchantRows hands back raw notes with month and amount, uncategorized included'`: change the comment to "`date` feeds the subscription detector, which needs day-level cadence; `accountId` lets it join a renamed charge to its old name (1.63, C1)." and add `accountId: 'acct-cash'` to the CHIPOTLE row and `accountId: 'acct-card'` to the MYSTERY row;
- in `'getNativeMerchantRows, strict (the cash forecast), …'`: add `accountId: 'acct-cash'` to the CHIPOTLE row.

Append to `companion/src/report-cube-build.test.ts`:

```ts
describe('subscriptions follow a renamed charge (1.63, C1)', () => {
  it("joins Google's renamed charge to its old name, because each row names its account", async () => {
    const row = (date: string, notes: string, amount: number) => ({ month: date.slice(0, 7), date, notes, amount, accountId: 'acct-card' });
    const cube = await buildReportCube(deps({
      merchantRows: vi.fn(() => [
        row('2026-06-06', 'GOOGLE *Google One MOUNTAIN VIEW CA · TRN-1', 5.29),
        row('2026-06-10', 'Google One Mountain View CA · TRN-2', 26.49),
        row('2026-07-06', 'GOOGLE *Google One MOUNTAIN VIEW CA · TRN-3', 5.29),
        row('2026-08-06', 'GOOGLE *Google One MOUNTAIN VIEW CA · TRN-4', 5.29),
        row('2026-09-06', 'GOOGLE *Google One MOUNTAIN VIEW CA · TRN-5', 21.19),
        row('2026-10-06', 'GOOGLE *G1AI101M MOUNTAIN VIEW CA · TRN-6', 21.19),
      ]),
    }), new Date('2026-10-22T12:00:00Z'), 2);
    expect(cube.subscriptions).toEqual([expect.objectContaining({
      name: 'GOOGLE *Google One MOUNTAIN VIEW CA', kind: 'subscription', monthlyCents: 2119, count: 5, lastDate: '2026-10-06',
    })]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/sqlite-native.test.ts src/report-cube-build.test.ts)`
Expected: `3 failed | 124 passed (127)` — the rows carry no `accountId`; the cube's `subscriptions` is `[]` (the charges reach the detector without an account, so nothing is joined).

- [ ] **Step 3: Implement**

- `getNativeMerchantRows`: return type gains `accountId: string`; each row gains `accountId: line.row.accountId` (comment: the detector joins a renamed charge only on the same account, 1.63 C1).
- `report-cube-build.ts`: the row cast gains `accountId?: string`; push `{ date, merchant, cents, ...(r.accountId ? { accountId: r.accountId } : {}) }` (one-line comment).
- `CHANGELOG.md`, under `## [Unreleased]` (keep the blank line before `## [1.62.0]`), exactly:

```markdown
### Changed
- **A card payment that names one of your accounts is a transfer from the
  moment it posts.** On a cash account, money out whose bank text names another
  connected account (Citi, Robinhood, Discover…) in payment words (`payment`,
  `autopay`, `e-payment`, `transfer`, `ach`…) is held as a transfer while its
  other half is on the way, instead of asking for a category. It links when the
  other half posts and, as before, counts as spending marked "Needs review"
  after 10 days. A transaction rule or an Undo still wins. Money in is left to
  pairing.
- **A bank's leading reference number no longer splits a merchant.** PNC now
  puts a fresh reference first (`*0082 PAYMENT CITI AUTOPAY …`). Category rules,
  category guesses, subscriptions, the forecast's bills and "Make every …
  deposit a payback" now leave it out, so this month's rule matches next
  month's charge. Rules you already saved are untouched, and anything you hid,
  confirmed, linked or said No to under the old name still applies.
- **A subscription survives a rename and a plan change.** When a merchant
  renames its charge on the same account, at the same price, a month after the
  last one, it stays one subscription under its old name. A price that steps
  once and then holds is a subscription at the new price, shown as a rise in
  the month it changes, instead of a bill priced at the old one.

### Fixed
- **"↔ Mark one as a transfer" writes a rule that matches.** The rule dropped
  the bank's punctuation (`WEB-RECUR` became `WEB RECUR`) and kept its leading
  reference, so it matched nothing, or only that one payment. It is now built
  from the bank's own words, the way a category rule is.
```

- `docs/superpowers/follow-ups.md`, a new section before `## Reference: name mismatches between the database, the REST API, and the SDK`:

```markdown
## 19. Bank-first card payments (2026-10-18, plan `2026-10-18-bank-first-payments.md`)

- **Yearly subscriptions (R10).** Not detected: an annual plan (one charge,
  about 365 days after the last) stays invisible, as before.
- **Product words in account names (R2).** `double`, `freedom`, `unlimited`
  and `individual` name an account (`accountNameWords`). A bill that uses one
  of them with payment wording is held up to 10 days, then counts as spending
  marked "Needs review". If that happens live, add the word to
  `GENERIC_ACCOUNT_WORDS` (sync-core.ts), which also narrows the dead-feed hold.
- **Money in still waits for its other half (R1).** A deposit that names an
  account (Robinhood's "…transferred to Robinhood Brokerage account" cashback)
  is left to pairing and `NOT_AWAITING_TRANSFER_HALF`.
- **The relink sweep drops the in-transit marker.** A row stored as a
  WITHDRAWAL that a later sync retypes as a held transfer (A, a new rule) is
  re-created asset-free from the comment it was READ with, so the marker and
  the external metadata land one sync later; in between it is a bare
  TRANSFER_OUT. Carry the planned comment and metadata into `relinkCreates`.
- **Renames and reminders under an old key.** R6 compares hidden, confirmed,
  linked and declined names through `normalizeRosterKey`; `names`, `prevNames`
  and `remind` are still exact, so one stored under a key with a leading
  reference is lost once.
- **The reference keeps its slot in the six-token cap.** `categoryRulePattern`
  strips the leading reference after the cap, so a stored key normalizes to
  exactly the new key; a long descriptor's pattern is one token shorter than
  it could be. Payback patterns strip it before the cap, as they always did.
- **A one-sided `notTransfer`** on a pair whose cash leg names the card now
  holds the cash leg as a transfer for 10 days (pinned in
  sync-core-not-transfer.test.ts). Undo marks both legs, so only a hand-made
  override reaches it.
- **The fake host restarts its ids per host** (`fh-1`, …): a test that builds a
  new host on an earlier host's activities can collide ids. Run repeated syncs
  on one host.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `(cd companion && nice npx vitest run --maxWorkers=2 src/sqlite-native.test.ts src/report-cube-build.test.ts)`
Expected: `127 passed (127)`

- [ ] **Step 5: The four gates, and the forced-2027 check**

Run, once each:
- `nice npx vitest run --maxWorkers=2` → `Test Files 2 failed | 168 passed (170)`, `Tests 2 failed | 3771 passed (3773)` (the 2 pre-existing SDK failures only);
- `(cd companion && nice npx vitest run --maxWorkers=2)` → `Test Files 67 passed (67)`, `Tests 1524 passed (1524)`;
- `nice npm run type-check` → the same 15 pre-existing errors, all in `src/utils/{addon-host,app-payback,host-can,wf-facts}.ts`, none new;
- `nice npm --prefix companion run build` → exits 0, no output after `> tsc`.

Then the clock check every new test file gets (throwaway files — do NOT commit them). In the repo root create `force-2027.setup.ts`:

```ts
import { beforeEach, vi } from 'vitest';
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-01-01T12:00:00Z'));
});
```

and `vitest.force2027.config.ts`:

```ts
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';
export default mergeConfig(base, defineConfig({ test: { setupFiles: ['./force-2027.setup.ts'] } }));
```

copy both into `companion/`, and run:
- `nice npx vitest run --config vitest.force2027.config.ts --maxWorkers=2 shared/rule-pattern.test.ts shared/subscriptions.test.ts shared/subscription-roster.test.ts shared/subscription-prefs.test.ts shared/subscription-links.test.ts shared/forecast-inputs.test.ts shared/bank-first-payment.test.ts shared/sync-core-bank-first.test.ts shared/sync-core-not-transfer.test.ts src/components/budget/ReportView.test.tsx` → `360 passed (360)`;
- `(cd companion && nice npx vitest run --config vitest.force2027.config.ts --maxWorkers=2 src/transfer-learning.test.ts src/subscriptions-menu.test.ts src/sqlite-native.test.ts src/report-cube-build.test.ts)` → `181 passed (181)`.

Delete the four throwaway files; `git status` shows only this task's files.

- [ ] **Step 6: Commit**

```bash
git add companion/src/sqlite-native.ts companion/src/sqlite-native.test.ts companion/src/report-cube-build.ts companion/src/report-cube-build.test.ts CHANGELOG.md docs/superpowers/follow-ups.md
git commit -m "$(cat <<'EOF'
Merchant rows carry their account, so the cube follows a renamed charge; docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Verification record (scratch clone of 58ef24f, 2026-10-18)

| Task | Step 2 (parent commit + the task's tests) | Step 4 (the task's commit) |
| --- | --- | --- |
| 1 | root 9 failed / 78 passed (87); companion 3 failed / 29 passed (32) | 87 passed; 32 passed |
| 2 | 11 failed / 118 passed (129) | 129 passed |
| 3 | root 3 failed / 108 passed (111); companion 1 failed / 21 passed (22) | 111 passed; 22 passed |
| 4 | import fails, no tests | 9 passed |
| 5 | 6 failed / 72 passed (78) | 78 passed |
| 6 | 5 failed / 80 passed (85) | 85 passed |
| 7 | 4 failed / 38 passed (42) | 42 passed |
| 8 | companion 3 failed / 124 passed (127) | 127 passed |

Full-suite totals after each task (measured): T1 3723 / 1522, T2 3735 / 1522, T3 3738 / 1523, T4 3747 / 1523, T5 3754 / 1523, T6 3760 / 1523, T7 3771 / 1523, T8 3771 / 1524 (root passed, plus the 2 pre-existing failures / companion passed).

Gates after Task 8: root `2 failed | 3771 passed (3773)` (baseline 58ef24f: `2 failed | 3713 passed (3715)`, the same 2); companion `1524 passed (1524)` (baseline 1520); type-check 15 errors (baseline 15, identical); companion build clean. Forced 2027: 360 + 181 passed.

## Self-review against the spec

- **A** (spec "The change" A, R1–R4; Tests "A", "A, not applied", "A, past the window"): Task 4 (decision, wording, whole words, cash only, rules) and Task 5 (placeholder → link; not applied: cashback money in, `*8712` LG&E, `*8768` Venmo, a card's own negative, a ruled row, a `notTransfer` row, plus own-account-only; expiry with Needs review; dead-feed hold; pending).
- **B** (R5, R7; Tests "B"): Task 1 — `*8712`/`*9999` agree; `rulePatternFor` matches `*0082` and `*0062` through `ruleApplies`; `RT…` and `3447db…` stripped; `7-ELEVEN`, `1PASSWORD`, `76` kept; `paybackRulePattern` uses the helper; saved rules are never rewritten (no code touches stored rules).
- **R6** (Tests "R6"): Task 2 (the literal acceptance case: hidden `*8712 PAYMENT LOUISVILLE GAS & ACH` hides `PAYMENT LOUISVILLE GAS & ACH`), Task 3 (every other consumer).
- **C1/C2** (R8, R9, R10; Tests "C"): Task 6 (Sep-6 state: subscription, 2119, creep true; wandering bill stays bill), Task 7 (Nick's six rows on Oct 18 and Oct 22; different accounts not joined), Task 8 (the account reaches the detector in production). R10's yearly tier is a follow-up.
- **R11:** no version bump, no release; CHANGELOG under Unreleased.
