# Audits without SSH — R2 Fix (2c) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The two repairs that used to need the server's `fix-transfers.mjs` and `skip-transaction.mjs`, in Telegram and the app, each in the change log with Undo — **Link**: a Health leg with exactly one likely other half is linked to it in one tap (`/audit` → Health and Settings → Checks; **Link all N** for two or more); **Remove for good…**: a row the bank reported twice is put on the skip list and deleted, from its story (`/why` and the app) — plus the residuals of R1's final review (ruling C-H).

**Architecture:** Three pure shared modules. `shared/fix-row.ts` is the row both fixes re-read right before they write (Wealthfolio's ActivityDetails, as the SDK and REST both return it), its exact create payload, and how sure a host is that it is half of a linked pair. `shared/audit-link.ts` decides what Health offers to link, the fingerprints its buttons carry and whether a pair still reads as shown (`checkLinkPair`), and runs a link (`linkPairs`): through the host's `linkPair` — the sync's own `linkPairByRecreate` — writing both rows back if Wealthfolio refuses the re-create, recording a `transfer-link` entry with actor `you`, and on the add-on adding the pair to `linked_groups`. `shared/tx-remove.ts` decides whether a story offers "Remove for good…" and runs it (`removeForGood`): skip first through the corrupt-safe edit, then delete, taking the skip back if the delete fails, then a new `transaction-removed` entry whose Undo and Redo the change log learns (`shared/change-entries.ts`, `shared/change-undo.ts`, `shared/change-undo-run.ts`). Each host lends its reads and writes: the companion over REST (`companion/src/audit-fix-host.ts`, wired into `/audit` and `/why`), the add-on through the SDK (`src/utils/audit-fix.ts`, wired into Settings → Checks and the story view).

**Tech Stack:** TypeScript, React (add-on), vitest (root project: jsdom, `src/` + `shared/`; companion project: node, `companion/src/`), Telegram Bot API (legacy `Markdown`), Wealthfolio REST (companion), add-on SDK 3.6.2 on Wealthfolio 3.8–3.10 (add-on).

**Spec:** `docs/superpowers/specs/2026-10-13-audits-without-ssh-design.md` — section C (R2 — Fix) and the parts of D that apply; sections A and B shipped in R1 (PR #7, merge ece1902). Branch `feat/audits-fix`, off main at ece1902. Rulings Y1–Y11 (2026-10-14) are folded into the tasks below.

**Verified facts this plan builds on (Y1):**
- **(a) The linker is DELETE-first, not create-first.** `linkPairByRecreate` deletes both rows (`shared/link-pair.ts:39`) and then re-creates them in ONE `saveMany` as a marked group (`:42-53`); it is `unlinkPairByRecreate` (`:123-166`) that creates first. Both hosts' `linkPair` is this function (`src/utils/addon-host.ts:201-203`, `companion/src/rest-host.ts:186-188`); the sync calls `host.linkPair` (`shared/sync-core.ts:3820`) and logs `transferLinkChange` (actor `auto`) on success (`:3826`). Wealthfolio applies a bulk request all or nothing — any preparation error returns before the write (`activities_service.rs` `bulk_mutate_activities`, v3.8.0) — so a re-create it refuses wrote nothing while the delete already went through: `LinkResult.problems` documents exactly this loss (`shared/sync-host.ts:111-117`). R2 links through the same function and, on that one outcome (a `save (…)` problem and no `delete (…)` problem), writes both rows back exactly as they were. **The add-on's ledger:** the add-on cannot read groups (`readsSourceGroupId: false`, `src/utils/addon-host.ts:107`), so its sync keeps `linked_groups`, per leg `accountTxKey(sfinId, txId) → groupId` (`shared/sync-core.ts:3872-3897`, written at `:3959`); that ledger is what makes its sync treat a leg as linked (`isLinkedRow`, `:2672-2675`) and keep a linked leg's stored type and date (`keepLinkedLegAsStored`, `:283`). R2's add-on Link writes both keys there. **Card outflows:** the sync never links money leaving a card — a card's negative is never the OUT side of a detected pair (`shared/transfers.ts:91`); the v1.55 rule writes the sync's own card outflows (opening debt, plugs, restated placeholders) as WITHDRAWAL because 3.8 refuses TRANSFER_OUT on a card (`shared/sync-core.ts:1448-1475`, CHANGELOG 1.55.0); and a WITHDRAWAL is never half of a valid pair (Health counts only TRANSFER_IN/OUT in a group, `shared/audit-health.ts:134-145`). So R2 refuses to link money leaving a card unless the card already stores it as a TRANSFER_OUT (3.10 accepts one, #1796). **Undo of a link with actor `you`:** the planner is actor-blind for `transfer-link` — `notTransfer` on both tx keys, `needsSync: true` (`shared/change-undo.ts:399-416`) — and the sync's unlink pre-pass finds the partner by group on the companion and by `linked_groups` on the add-on, so the same Undo and Redo work. One gap: the app's "Update the companion first" gate keys on actor `auto` (`needsOverrideSupport`, `:94-96`), so it would let a `you` link's Undo through to a companion that ignores overrides; Task 2 widens it to any `transfer-link`. SDK 3.9's `activities.linkTransfer` (in place, ids and categories kept) is NOT adopted: it needs new manifest permissions — Nick's call, recorded in follow-ups §12 as the later option.
- **(b) Removal needs a new kind.** `import`'s Undo removes and skips, its Redo un-skips (`shared/change-undo.ts:528-544`) — the reverse; `duplicate-removed`'s Undo sets `keepDuplicate` and re-creates, its Redo clears the override (`:507-526`) — no skip list. Neither has "Undo re-creates exactly and un-skips; Redo skips and removes", so Task 2 adds ONE kind, `transaction-removed` (actor `you`, undoable), whose `before.activity` is the row's create payload in the shape the sync keeps for a removed duplicate (`recreatePayload`, `shared/sync-core.ts:1787-1800`). The duplicate Undo's "exact copy" refusal (`UNDO_EXACT_COPY`, `shared/change-undo-run.ts:318-322`) cannot bite on its own: the row is deleted before Undo re-creates it, and the skip list keeps the bank feed from re-importing it. Only a copy added back by hand meets it, and then Undo changes nothing — its create is the first step and there is no override to roll back (pinned in Task 2).
- **(c) Safety checks reused, unchanged:** `UNDO_LINKED_REFUSAL`/`UNDO_MAYBE_LINKED` through `linkedRefusal` (Redo of a removal, `shared/change-undo.ts:215`); `maybeLinkedTransfer` (`shared/change-undo-run.ts:135`) as the add-on's "maybe linked" rule for Remove, and narrowed by the snapshot's evidence for Link (Deviations); the note markers `isPendingNote`, `isPlaceholderNote`, `isStartingBalanceNote`, `isCorrectionNote` (`shared/audit-ledger.ts:80-83`); `editSkippedTransactions`, which never overwrites a list it cannot read (`shared/skipped-transactions.ts:88-98`); `loadSyncOverrides` (`shared/sync-overrides.ts:155`), whose `unreadable` refuses every fix. The exact-id reads are the ones the story uses: the SDK's `activityIds` filter (`src/utils/tx-story.ts:71-75`) and REST's `activityIdFilter` (`companion/src/tx-story-host.ts:72-73`).
- **(d) R1's snapshot carries what Link needs.** An incomplete-leg issue holds the leg and its unique counterpart as `HealthLeg`s — activity id, account id and name, tx key, date, amount, type, currency, description (`shared/audit-health.ts:76-92`) — plus `problem`, `owner` and `match` (`:102-115`). The reader marks a whole snapshot corrupt for one unknown reason kind (`REASON_KINDS.has`, `shared/audit-snapshot.ts:151`) or issue kind (`:165`) and does not check `more` (ruling C-H); Task 1 fixes both.

**Deviations from the spec (decided, do not "fix"):**
- **A card's outflow is not "created as a WITHDRAWAL" (C1).** A WITHDRAWAL in a group is not half of a valid pair, and 3.8/3.9 refuse a TRANSFER_OUT on a card — after the linker has already deleted both rows. Link refuses money leaving a card unless the row is already a TRANSFER_OUT: "Wealthfolio doesn't take a transfer out of a credit card, so these two can't be linked here." (a). A card's money IN (a card payment, the common case) links on every version.
- **Link writes both rows back when Wealthfolio refuses the re-create** — "Wealthfolio refused the link (<why>). Both rows are back as they were." — because the linker deletes first (a). If that write also fails: "…, and the two rows couldn't be put back — the next sync brings back any the bank still sends." A thrown error says "Couldn't link them: <why>. Check both accounts in Wealthfolio."
- **The add-on's "may be linked" for Link is 2a's rule narrowed by the snapshot.** Every incomplete leg is a transfer-typed row nothing marks as unpaired, so 2a's rule verbatim would refuse every Link in the app. The snapshot read the row unpaired from the database; since then only Wealthfolio's own link keeps a row's id, and it stamps `flow.is_external: false` on both rows (storage-sqlite activities repository.rs:1103-1108 at v3.8.0) — every other linker re-creates rows under new ids, which the re-read by id sees as gone. So in the app a transfer-typed row may be linked when its metadata says `is_external: false` or the host did not report metadata; a group the SDK does report, or the add-on's ledger, confirms it. Remove has no snapshot behind it and uses 2a's rule as it is: the app refuses to remove any transfer leg nothing marks as unpaired ("Unlink it first."); `/why`, which reads groups, can remove an unlinked one.
- **Remove for good also refuses a pending row**: "It's still pending — remove it once it posts." SimpleFin often gives a pending transaction a new id when it posts (`shared/reconcile.ts:130-139`), so skipping the pending id would not keep the posted copy out.
- **Remove skips the tx id under every feed that maps to the row's account** (two feeds can share one, `sfinIdsFor`), and the entry lists every key; Undo takes each back off. Undo re-creates the row, THEN un-skips (a skip entry left behind is harmless to a stored row); Redo skips, THEN deletes, as the removal did.
- **Link's refusals all read "It has changed since — nothing was linked."** (ruling Y2), including a pending row, a `notTransfer` override, a linked or maybe-linked row, and one of the add-on's own rows; "Link all" counts each as "had changed since". A row no longer carrying the tx id its leg named is "changed" too.
- **Telegram buttons:** a Link button carries both legs' fingerprints (`l<16 hex>`: id, account, amount, date, type); "Link all" carries one handle over every pair the list showed (`L<8 hex>`) and links nothing — saying it changed — if the list is different now; the list shows "Likely the other half: …" under each linkable leg (the list is the preview) and buttons "Link 1", "Link 2"…; the issue screen gets "Link". `/why`'s remove buttons carry the activity id, as every story button already does, plus the row's fingerprint (`D<id>:<8 hex>`); the longest is 52 bytes. **Cancel** returns to the story without its Back (`t<id>:c`): the Back's query would not fit 64 bytes.
- **After a fix:** Telegram edits the screen in place — Health again, re-read, with the result on top; after a removal, the result alone; after a refused removal, the story re-read with "⚠️ <why>" on top. The app's Checks card hides the pairs it linked and, since it shows a snapshot, adds "Changes show here after the next sync." to the result; a removal in the app says its result and does not re-read the story (the row is gone, which a re-read would call "changed since"); a refused one re-reads it.
- **Undo of a link you made waits for a companion that obeys overrides in the app**, like the sync's (a): `needsOverrideSupport` now covers a `transfer-link` whoever made it.
- **A newer snapshot is read, not refused** (ruling C-H): an unknown reason kind is dropped and its cents counted in `unexplainedCents`, so the lines still add up; an unknown Health issue kind is dropped and counted in `more` ("and N more"). A known kind stays strictly checked; `health.more` and a reason's `more` must be numbers.
- **Copy the rulings did not spell out:** "Linked all 4." and "Linked 2 of 4 — 1 had changed since, 1 couldn't be linked."; "Couldn't reach Wealthfolio — nothing was linked." / "— nothing was removed."; "Removed. The bank feed won't import it again — Undo in the change log puts it back."; "The sync manages this row (a held transfer, a starting balance or a correction), so it can't be removed here."; "Only a transaction from your bank feed can be removed here."; "Couldn't remove it (<why>) — nothing was changed." and "…, and it stays on the skip list — the bank feed won't import it again until it's taken off."; an unreadable overrides document refuses with the existing "Your sync overrides can't be read, so nothing was changed."; the entries' "Removed <bank text> for good", "You removed it; the bank feed won't import it again", "You linked them from the Health list"; Undo's "Undone — it's back, and the bank feed can import it again." and Redo's "Redone — it's removed and won't be imported again."; the skip-list note "Removed for good"; buttons "Remove for good…", "Remove", "Cancel", "Link", "Link N", "Link all N".
- **Remove's Undo puts the row back as the bank feed wrote it** — a category filed on it is not part of the row and does not come back (follow-ups §12).

**Task order:** the snapshot reader (1); the change log's new kind, its Undo and Redo (2); the pure Link (3) and Remove (4); the companion's hosts (5), `/audit`'s Link (6) and `/why`'s Remove (7); the app's Link on the Checks card (8) and Remove on the story (9); docs, the forced-date run and every gate (10).

## Global Constraints

- **Writes only through the existing paths (spec D1).** Link: the host's `linkPair` (`linkPairByRecreate`); Remove: `editSkippedTransactions`, then the host's `saveMany` delete; the change log: each host's own writer (`recordCompanionChanges` on the companion, `store.recordChange` on the add-on). Writing rows back after a refused link uses the host's `saveMany` creates with `recreateWrite`. No new secret.
- **Re-read right before writing.** Link re-reads both rows by exact id right before EACH pair's write; Remove re-reads the row at its second tap. A refusal writes nothing. Link reads the overrides once per run; an unreadable document links nothing.
- **Copy (verbatim; constants in `shared/audit-link.ts`, `shared/tx-remove.ts`, `src/components/AuditViews.tsx`):** `It has changed since — nothing was linked.` · `Linked.` · `Link` · `Link all <N>` · `Wealthfolio doesn't take a transfer out of a credit card, so these two can't be linked here.` · `Couldn't reach Wealthfolio — nothing was linked.` · `Remove for good…` · `Deletes this row and stops the bank feed importing it again. Undo puts it back.` · `Remove` · `Cancel` · `Unlink it first.` · `Couldn't save the skip list — nothing was changed.` · `It has changed since — nothing was removed.` · `It's still pending — remove it once it posts.` · `Changes show here after the next sync.` Every other string is spelled out in its task.
- **Telegram.** Legacy `Markdown`. `/audit` (`cz:au:`) adds `l<16 hex>` and `L<8 hex>`; `/why` (`cz:wy:`) adds `d<id>` and `D<id>:<8 hex>`. Every `callback_data` ≤ 64 bytes (the longest `/audit` button is 23; the longest `/why` remove button 52, with a 36-character id). Stateless: every tap re-reads. Bank text and Wealthfolio's error text are escaped and kept outside every `*…*`/`_…_`. Glyphs: 🔎 ⬅️ ⚠️ only. Link and Remove appear only when the menu's deps can do them (`link`, `remove`), so every screen an R1 or 2b test renders is unchanged.
- **App.** No emoji in app copy (`\p{Extended_Pictographic}`). New CSS: `.sfin-audit-fix` and `.sfin-why-remove`, each column-0 selector defined once (`src/components/theme-styles.test.ts`). Every store method is optional-called. One action per click: a ref guard, and every button of the card or story disabled with `aria-busy` while it runs (the Change log card's pattern from 2a). Results in a `role="status"` element mounted from the first render. No state update after unmount.
- **The change log never costs the work.** Link records a `transfer-link` entry with actor `you` (the sync's own entry, `transferLinkChange(out, in, 'you')`); Remove records `transaction-removed`. A failed append, or a failed `linked_groups` write, is logged and the fix still stands.
- **Tests use a fixed `now`.** Shared and companion: fixed `Date`s and a `now` argument; the add-on: fixed `now` props, or `vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(...)` with `vi.useRealTimers()` after. Every new test file also passes with the date forced to 2027-01-01 (Task 10).
- **Imports:** shared sources import siblings WITH `.js`; `src/` imports shared WITHOUT an extension; companion imports `'../../shared/x.js'` and `'./x.js'`.
- **Run the companion suite from `companion/`** (`cd companion && npx vitest run …`), never with `--root`.
- **Gates before calling a task done:** the touched project's tests, plus `nice npm run type-check` when `src/` or `shared/` changed and `nice npm --prefix companion run build` when `companion/` or `shared/` changed. Final task: `npm test`, `npm --prefix companion test`, `npm run type-check`, `npm --prefix companion run build`, all under `nice` — the Mac overheats.
- **Edits are exact.** Every "replace" block below is copied from the file as it stands after the previous tasks (and the earlier edits of the same file in the same task) and occurs exactly once; replace it verbatim (the Edit tool's `old_string` → `new_string`). Apply a file's numbered edits in order. Every "Create" block is the whole file.
- **No version bump, tag or release.** CHANGELOG goes under `[Unreleased]`.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

- **A row that changed between the snapshot or list and the click or tap** → "It has changed since — nothing was linked." / "…nothing was removed.", and no write. Pinned in Task 3 (`writes nothing for a row that changed between the snapshot and the click`; `refuses a row that is %s`), Task 8 (`refuses a row whose amount changed between the snapshot and the click, and writes nothing`), Task 4 (`writes nothing when %s`), Task 6 (`links nothing when a leg changed between the list and the tap`; `Link all links every pair the list showed — and nothing when the list has changed since`) and Task 7 (`a refused Remove shows the story again, as it is now, with why on top`).
- **A pending leg, a row the add-on cannot rule out as linked, a `notTransfer` override** → refused, nothing written. Pinned in Task 3 (`refuses %s and writes nothing`: a pending leg, a row the add-on cannot rule out as linked, a notTransfer override), Task 8 (`refuses a pair its ledger already knows, and a row a link has marked since the snapshot`), Task 4 (`refuses %s`: a pending row) and Task 9 (`refuses a transfer leg it cannot rule out as linked, and a row its ledger knows`).
- **One failure inside Link all** → the rest still linked, each counted: "Linked 2 of 4 — 1 had changed since, 1 couldn't be linked." Pinned in Task 3 (`Link all goes on past a pair that changed and one that failed, and counts each`).
- **Remove, then Undo** → the exact row re-created and off the skip list; Redo removes it again. **Link, then Undo** → `notTransfer` on both legs, which the next sync acts on; Redo takes them back. Pinned in Task 4 (`re-creates the exact row and takes it off the skip list`) and Task 2 (`Undo re-creates the exact row and takes it off the skip list; Redo removes it again and skips it`; `Undo of a link you made tells the sync neither half is a transfer; Redo takes that back`).
- **The delete fails after the skip** → the key it added comes back off the list (one already there stays). Pinned in Task 4 (`takes back off the skip list only what it added when the delete fails`; `says so when it cannot take the key back off either`).
- **A corrupt skip list** → "Couldn't save the skip list — nothing was changed.", nothing deleted. Pinned in Task 4 (`deletes nothing when the skip list is corrupt`) and Task 9 (the same, through the SDK).
- **Wealthfolio refuses the re-create after the linker's delete** → both rows written back exactly. Pinned in Task 3 (`puts both rows back exactly when Wealthfolio refuses the re-create after the delete went through`); money leaving a card is never attempted (`refuses money leaving a card unless the card already stores it as a transfer out (Wealthfolio 3.10)`).
- **The longest callback** → within 64 bytes: 23 on `/audit`, 52 on `/why`. Pinned in Task 6 (`keeps every button within 64 bytes — the longest is 23`) and Task 7 (`parse back, and the longest fits 64 bytes with a 36-character id`).
- **A snapshot from a newer companion** with an unknown reason or Health issue kind → still read as ok. Pinned in Task 1 (`drops a reason kind it cannot name, counts its cents as not explained, and still reads ok`; `drops a Health issue kind…`).
- **A double click** → one action. Pinned in Task 8 (`runs one action at a time, every button disabled and busy…`) and Task 9 (`Remove acts once, busy while it runs, then says so and leaves nothing to click`).
- **Dates** → every test pins its clock; Task 10 runs every new test file with the date forced to 2027-01-01.

---

## File Structure

| File | Responsibility |
|---|---|
| `shared/audit-snapshot.ts` (modify) | The reader drops unknown reason and issue kinds; `more` must be a number. |
| `shared/change-entries.ts`, `shared/change-view.ts` (modify) | The `transaction-removed` kind and its builder; `transferLinkChange(…, actor)`; the kind under Corrections. |
| `shared/change-undo.ts`, `shared/change-undo-run.ts` (modify) | Undo (create, then un-skip) and Redo (skip, then delete) of a removal; the companion gate for any `transfer-link`. |
| `shared/fix-row.ts` (create) | `FixRow`, `fixRowOf`, `recreateWrite`, `linkedState`: the row both fixes re-read. |
| `shared/audit-link.ts` (create) | `linkablePair(s)`, the fingerprints, `checkLinkPair`, `linkPairs`, `linkRunLine`, the Link copy. |
| `shared/tx-remove.ts` (create) | `removalOffered`, `removalFingerprint`, `removeForGood`, the Remove copy. |
| `companion/src/audit-fix-host.ts` (create) | `companionLinkIo`, `companionRemoveIo`: REST reads and writes, the companion's change-log writer. |
| `companion/src/audit-menu.ts`, `companion/src/why-menu.ts` (modify) | `/audit`'s Link and Link all; `/why`'s two-tap Remove. |
| `companion/src/index.ts` (modify) | `buildAuditMenu` links, `buildWhyMenu` removes. |
| `src/utils/audit-fix.ts` (create) | `addonLinkIo`/`linkFromApp`, `addonRemoveIo`/`removeFromApp`: SDK reads and writes, `linked_groups`, the store's writer. |
| `src/components/AuditViews.tsx`, `src/components/ui.tsx` (modify) | Link and Link all on the Checks card; `.sfin-audit-fix`, `.sfin-why-remove`. |
| `src/tabs/SettingsTab.tsx`, `src/pages/SyncPage.tsx` (modify) | The card's linker; the snapshot read again after a fix. |
| `src/utils/tx-story.ts`, `src/components/TxStory.tsx` (modify) | The story offers Remove for good…; the two-click remove. |
| `CHANGELOG.md`, `README.md`, `docs/superpowers/follow-ups.md`, `shared/audit-headline.ts` (modify) | Docs, follow-ups §12, and the R1 remainder list (ruling C-H). |

---

### Task 1: The snapshot reads what a newer companion adds

Ruling C-H's code half (Y4). The reader drops a reason or a Health issue of a kind it cannot name instead of marking the whole snapshot corrupt, so a newer companion never makes an older add-on say "Couldn't read the checks — run /audit in Telegram." A dropped reason's cents are added to `unexplainedCents` (the lines still add up to the gap); a dropped issue is counted in `more` ("and N more"). Every kind it knows stays strictly checked, and `health.more` and a reason's `more` must be numbers. Two of R1's corrupt cases were exactly unknown kinds (the issue `{ kind: 'x', key: 'k' }` and the reason `'future'`); they leave that list, and the new describe pins unknown kinds as read.

**Files:**
- Modify: `shared/audit-snapshot.ts`, `shared/audit-snapshot.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `parseAuditSnapshot(raw: string | null | undefined): AuditSnapshotRead` — the same signature; a snapshot carrying unknown kinds reads `ok`, without them.

- [ ] **Step 1: Write the failing tests**

Edit 1 of 3 in `shared/audit-snapshot.test.ts` — replace:

```ts
      JSON.stringify({ ...good, balanceNotes: undefined }),
      JSON.stringify({ ...good, health: { issues: [{ kind: 'x', key: 'k' }], notes: [] } }),
      JSON.stringify({ ...good, health: { issues: [{ kind: 'incomplete-leg', key: 'k' }], notes: [] } }),
```

with:

```ts
      JSON.stringify({ ...good, balanceNotes: undefined }),
      JSON.stringify({ ...good, health: { issues: [{ kind: 'incomplete-leg', key: 'k' }], notes: [] } }),
```

Edit 2 of 3 in `shared/audit-snapshot.test.ts` — replace:

```ts
      reasonRows([{ date: 'soon', description: 'A', cents: 1, account: 'B' }]),
      reasonRows([], 'future'),
```

with:

```ts
      reasonRows([{ date: 'soon', description: 'A', cents: 1, account: 'B' }]),
```

Edit 3 of 3 in `shared/audit-snapshot.test.ts` — replace:

```ts
    expect(parseAuditSnapshot(balance({ bank: { kind: 'none' } })).kind).toBe('ok');
  });
});
```

with:

```ts
    expect(parseAuditSnapshot(balance({ bank: { kind: 'none' } })).kind).toBe('ok');
  });
});

describe('a snapshot from a newer companion', () => {
  const good = buildAuditSnapshot(small(), NOW)!;
  const lateStart = { kind: 'late-start', key: 'k', activityId: 'a', accountId: 'b', accountName: 'C', date: '2026-10-02', earliest: '2026-10-01', cents: 1 };

  it('drops a reason kind it cannot name, counts its cents as not explained, and still reads ok', () => {
    const newer = { kind: 'split-lines', cents: 7, rows: [{ date: '2026-10-02', description: 'A', cents: 7, account: 'B' }], more: 3 };
    const read = parseAuditSnapshot(JSON.stringify({
      ...good, headline: { ...good.headline, unexplainedCents: 5, reasons: [...good.headline.reasons!, newer] },
    }));
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.snapshot.headline.reasons!.map((r) => r.kind)).toEqual(['first-midnight']);
    expect(read.snapshot.headline.unexplainedCents).toBe(12);
  });

  it('drops a Health issue kind it cannot name, counts it under "and N more", and still reads ok', () => {
    const read = parseAuditSnapshot(JSON.stringify({
      ...good, health: { issues: [lateStart, { kind: 'oversold', key: 'o', anything: true }], notes: [], more: 2 },
    }));
    expect(read.kind).toBe('ok');
    if (read.kind !== 'ok') return;
    expect(read.snapshot.health.issues!.map((i) => i.kind)).toEqual(['late-start']);
    expect(read.snapshot.health.more).toBe(3);
  });

  it('still refuses a kind it knows that is malformed, and a `more` that is not a number', () => {
    for (const raw of [
      JSON.stringify({ ...good, headline: { ...good.headline, reasons: [{ kind: 'excluded', cents: 'x', rows: [] }] } }),
      JSON.stringify({ ...good, headline: { ...good.headline, reasons: [{ cents: 1, rows: [] }] } }),
      JSON.stringify({ ...good, headline: { ...good.headline, reasons: [{ kind: 'excluded', cents: 1, rows: [], more: null }] } }),
      JSON.stringify({ ...good, health: { issues: [{ ...lateStart, cents: 'x' }], notes: [] } }),
      JSON.stringify({ ...good, health: { issues: [{ kind: 5, key: 'k' }], notes: [] } }),
      JSON.stringify({ ...good, health: { issues: [], notes: [], more: '1' } }),
    ]) {
      expect(parseAuditSnapshot(raw)).toEqual({ kind: 'corrupt' });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/audit-snapshot.test.ts`
Expected: FAIL — the 3 tests of "a snapshot from a newer companion" (the two newer snapshots read `corrupt`; a reason whose `more` is `null` reads `ok`); 14 pass.

- [ ] **Step 3: Implement**

Edit 1 of 2 in `shared/audit-snapshot.ts` — replace:

```ts
/** The stored secret: absent when there is none, corrupt when it is not a
 *  snapshot this version can read — every field the app's views read, dates
 *  and kinds included — else the snapshot. */
export function parseAuditSnapshot(raw: string | null | undefined): AuditSnapshotRead {
```

with:

```ts
/** `more`: absent, or a count. */
const goodMore = (x: unknown) => x === undefined || isNum(x);

/** The stored secret: absent when there is none, corrupt when it is not a
 *  snapshot this version can read — every field the app's views read, dates
 *  and kinds included — else the snapshot.
 *
 *  A newer companion may publish a reason or a Health issue of a kind this
 *  version cannot name (2c R2, ruling C-H). It is DROPPED, never read as
 *  corrupt, so an older add-on keeps showing everything it does know: a
 *  dropped reason's cents count as not explained, and a dropped issue counts
 *  under "and N more". Every kind it knows stays strictly checked. */
export function parseAuditSnapshot(raw: string | null | undefined): AuditSnapshotRead {
```

Edit 2 of 2 in `shared/audit-snapshot.ts` — replace:

```ts
  const h = v.headline;
  if (!isObject(h) || typeof h.month !== 'string' || !nullOrArray(h.reasons) || !Array.isArray(h.notes)) return corrupt;
  for (const r of h.reasons ?? []) {
    if (!isObject(r) || !REASON_KINDS.has(r.kind) || !isNum(r.cents) || !Array.isArray(r.rows)) return corrupt;
    for (const row of r.rows) if (!isObject(row) || !isNum(row.cents) || !isDay(row.date)) return corrupt;
  }
  const health = v.health;
  if (!isObject(health) || !nullOrArray(health.issues) || !Array.isArray(health.notes)) return corrupt;
  const goodLeg = (l: unknown) => isObject(l) && typeof l.activityId === 'string' && typeof l.accountId === 'string' && isNum(l.absCents) && isDay(l.date);
  for (const i of health.issues ?? []) {
    if (!isObject(i) || typeof i.kind !== 'string' || typeof i.key !== 'string') return corrupt;
    if (i.kind === 'incomplete-leg') {
      if (!goodLeg(i.leg) || (i.counterpart != null && !goodLeg(i.counterpart))) return corrupt;
    } else if (i.kind === 'phantom-cash') {
      if (!isNum(i.rows) || !Array.isArray(i.accounts)) return corrupt;
    } else if (i.kind === 'late-start') {
      if (typeof i.activityId !== 'string' || typeof i.accountId !== 'string' || !isNum(i.cents) || !isDay(i.date) || !isDay(i.earliest)) return corrupt;
    } else return corrupt;
  }
  return { kind: 'ok', snapshot: v as AuditSnapshot };
}
```

with:

```ts
  const h = v.headline;
  if (!isObject(h) || typeof h.month !== 'string' || !nullOrArray(h.reasons) || !Array.isArray(h.notes)) return corrupt;
  const reasons: unknown[] = [];
  let unnamedCents = 0;
  for (const r of h.reasons ?? []) {
    if (!isObject(r) || typeof r.kind !== 'string' || !isNum(r.cents) || !Array.isArray(r.rows) || !goodMore(r.more)) return corrupt;
    if (!REASON_KINDS.has(r.kind)) {
      unnamedCents += r.cents;
      continue;
    }
    for (const row of r.rows) if (!isObject(row) || !isNum(row.cents) || !isDay(row.date)) return corrupt;
    reasons.push(r);
  }
  const health = v.health;
  if (!isObject(health) || !nullOrArray(health.issues) || !Array.isArray(health.notes) || !goodMore(health.more)) return corrupt;
  const goodLeg = (l: unknown) => isObject(l) && typeof l.activityId === 'string' && typeof l.accountId === 'string' && isNum(l.absCents) && isDay(l.date);
  const issues: unknown[] = [];
  let unnamedIssues = 0;
  for (const i of health.issues ?? []) {
    if (!isObject(i) || typeof i.kind !== 'string' || typeof i.key !== 'string') return corrupt;
    if (i.kind === 'incomplete-leg') {
      if (!goodLeg(i.leg) || (i.counterpart != null && !goodLeg(i.counterpart))) return corrupt;
    } else if (i.kind === 'phantom-cash') {
      if (!isNum(i.rows) || !Array.isArray(i.accounts)) return corrupt;
    } else if (i.kind === 'late-start') {
      if (typeof i.activityId !== 'string' || typeof i.accountId !== 'string' || !isNum(i.cents) || !isDay(i.date) || !isDay(i.earliest)) return corrupt;
    } else {
      unnamedIssues += 1;
      continue;
    }
    issues.push(i);
  }
  const headline = h.reasons === null ? h : {
    ...h, reasons,
    ...(unnamedCents !== 0 && isNum(h.unexplainedCents) ? { unexplainedCents: h.unexplainedCents + unnamedCents } : {}),
  };
  const checked = health.issues === null ? health : {
    ...health, issues,
    ...(unnamedIssues > 0 ? { more: (health.more ?? 0) + unnamedIssues } : {}),
  };
  return { kind: 'ok', snapshot: { ...v, headline, health: checked } as AuditSnapshot };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/audit-snapshot.test.ts`
Expected: PASS — 17 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/audit-snapshot.test.ts shared/audit-snapshot.ts
git commit -m "Audits R2: the snapshot reader drops kinds it cannot name instead of refusing the snapshot; more must be a number

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The change log learns "removed for good" — and a link you make

Spec C2's logging and C1's (Y1a, Y1b, Y7). ONE new kind, `transaction-removed` — actor `you`, undoable, under Corrections — whose `before.activity` is the row's full create payload and whose `subject.txKeys` are every key the removal put on the skip list. **Undo** re-creates the row from the payload, THEN takes each key off the skip list; **Redo** skips each key, THEN deletes the row the last Undo put back — refused when that row is gone ("That transaction is gone — nothing was redone.") or is now half of a linked transfer (`linkedRefusal`). A copy added back by hand makes Undo's create meet Wealthfolio's exact-copy refusal, and then nothing changes (pinned). `transferLinkChange` takes an `actor`, so R2's link is the sync's own entry with actor `you` ("You linked them from the Health list"); its Undo is unchanged — `notTransfer` on both legs, carried out by the next sync, and Redo takes them back (pinned on the runner) — so the app's "Update the companion first" gate now covers a `transfer-link` whoever made it. A removal's Undo writes rows and the skip list itself: no gate. `/changes` and the Change log card offer the new entries' Undo through `undoAvailability`, which needs no change (pinned).

**Files:**
- Modify: `shared/change-entries.ts`, `shared/change-view.ts`, `shared/change-undo.ts`, `shared/change-undo-run.ts`, `shared/change-entries.test.ts`
- Create: `shared/change-undo-remove.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:

```ts
// shared/change-entries.ts
export type ChangeKind = /* … */ 'duplicate-removed' | 'transaction-removed' /* … */;   // CHANGE_KINDS: 17
export interface TransactionRemovedFacts {
  account: ChangeAccount; txKeys: string[]; activityId: string; description: string;
  amountCents: number; date: string; payload: Record<string, unknown>;
}
export function transactionRemovedChange(f: TransactionRemovedFacts): ChangeDraft;
export function transferLinkChange(out: LinkLegFacts, inLeg: LinkLegFacts, actor?: ChangeActor /* default 'auto' */): ChangeDraft;
// shared/change-undo.ts
UNDO_KINDS.has('transaction-removed');                                  // true
needsOverrideSupport({ kind: 'transfer-link', actor: 'you' });          // true
// undo: [{ do: 'create', write }, ...{ do: 'unskip', account, txId }]; redo: [...{ do: 'skip', account, txId }, { do: 'delete', activityId }]
```

- [ ] **Step 1: Write the failing tests**

Edit 1 of 3 in `shared/change-entries.test.ts` — replace:

```ts
  it('lists every kind once', () => {
    expect(new Set(CHANGE_KINDS).size).toBe(16);
  });
```

with:

```ts
  it('lists every kind once', () => {
    expect(new Set(CHANGE_KINDS).size).toBe(17);
  });
```

Edit 2 of 3 in `shared/change-entries.test.ts` — replace:

```ts
  stampChange, startingBalanceChange, startingBalanceMovedChange, transferLinkChange, transferTypeChange,
  type ChangeDraft,
} from './change-entries.js';
```

with:

```ts
  stampChange, startingBalanceChange, startingBalanceMovedChange, transactionRemovedChange, transferLinkChange, transferTypeChange,
  type ChangeDraft,
} from './change-entries.js';
```

Edit 3 of 3 in `shared/change-entries.test.ts` — replace:

```ts
    }), 'Removed a duplicate copy of TRADER JOE S #628'],
    ['starting-balance', startingBalanceChange({
```

with:

```ts
    }), 'Removed a duplicate copy of TRADER JOE S #628'],
    ['transaction-removed', transactionRemovedChange({
      account: CHECKING, txKeys: [KEY], activityId: 'act-600', description: 'MOBILE DEPOSIT', amountCents: 60000, date: '2026-10-09',
      payload: { accountId: 'wf-checking', activityType: 'DEPOSIT', activityDate: '2026-10-09', amount: 600, currency: 'USD', comment: 'MOBILE DEPOSIT · TRN-a1b2' },
    }), 'Removed MOBILE DEPOSIT for good'],
    ['starting-balance', startingBalanceChange({
```

**Create `shared/change-undo-remove.test.ts`:**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CHANGE_KINDS, reversalChange, stampChange, transactionRemovedChange, transferLinkChange, type ChangeDraft, type ChangeEntry,
  type TransactionRemovedFacts,
} from './change-entries.js';
import type { ChangeLogItem } from './change-log.js';
import { changeGroupOf, changeSourceText } from './change-view.js';
import {
  planChangeUndo, undoAvailability, undoGone, UNDO_EXACT_COPY, UNDO_LINKED_REFUSAL, UNDO_NO_KEY, UNDO_NOT_POSSIBLE, type UndoOp,
} from './change-undo.js';
import { runChangeUndo, type UndoIo } from './change-undo-run.js';
import { createFakeHost, type FakeHostSeed } from './fake-host.js';
import { parseSkippedTransactionsStrict, SKIPPED_TRANSACTIONS_SECRET_KEY } from './skipped-transactions.js';
import type { HostActivity } from './sync-host.js';
import { hasTxOverride, parseSyncOverrides, SYNC_OVERRIDES_SECRET_KEY } from './sync-overrides.js';
import { accountTxKey } from './transfers.js';

const NOW = new Date('2026-10-14T15:00:00Z');
const CHECKING = { sfinId: 'sfin-1', wfId: 'wf-a', name: 'Checking' };
const KEY = accountTxKey('sfin-1', 'TRN-600');
const PAYLOAD = {
  accountId: 'wf-a', activityType: 'DEPOSIT', activityDate: '2026-10-09', symbol: { symbol: '$CASH-USD' }, amount: 600,
  currency: 'USD', comment: 'MOBILE DEPOSIT · TRN-600',
};
const ALLY_KEY = accountTxKey('sfin-2', 'TRN-9');
const OUT_LEG = { account: CHECKING, txKey: KEY, description: 'TRANSFER TO ALLY', amountCents: -60000, date: '2026-10-04', oldActivityId: 'o1', newActivityId: 'n1' };
const IN_LEG = {
  account: { sfinId: 'sfin-2', wfId: 'wf-b', name: 'Ally' }, txKey: ALLY_KEY, description: 'FROM PNC',
  amountCents: 60000, date: '2026-10-05', oldActivityId: 'o2', newActivityId: 'n2',
};
const removed = (over: Partial<TransactionRemovedFacts> = {}): ChangeEntry => stampChange(transactionRemovedChange({
  account: CHECKING, txKeys: [KEY], activityId: 'dup-1', description: 'MOBILE DEPOSIT', amountCents: 60000, date: '2026-10-09',
  payload: PAYLOAD, ...over,
}), 'addon', new Date('2026-10-14T12:00:00Z'));

describe('the entries R2 writes', () => {
  it('records a removal as yours and undoable, under Corrections, with the full create payload', () => {
    const e = removed();
    expect(e).toMatchObject({
      actor: 'you', kind: 'transaction-removed', undoable: true, summary: 'Removed MOBILE DEPOSIT for good',
      subject: { txKeys: [KEY], activityIds: ['dup-1'], amountCents: 60000, date: '2026-10-09' },
      before: { activityId: 'dup-1', activity: PAYLOAD },
    });
    expect(CHANGE_KINDS).toContain('transaction-removed');
    expect(changeGroupOf('transaction-removed')).toBe('corrections');
    expect(changeSourceText(e)).toBe('You, in the app');
    // Its Undo writes the row and the skip list itself: no companion gate, on either surface.
    expect(undoAvailability(e, { host: 'addon', companionVersion: '1.59.2' })).toEqual({ kind: 'ready', op: 'undo' });
    expect(undoAvailability(e, { host: 'companion', companionVersion: null })).toEqual({ kind: 'ready', op: 'undo' });
  });

  it('records a link you made as yours, with the legs the sync records — and its Undo still waits for a companion that obeys overrides', () => {
    const yours = transferLinkChange(OUT_LEG, IN_LEG, 'you');
    expect(yours).toEqual({ ...transferLinkChange(OUT_LEG, IN_LEG), actor: 'you', why: 'You linked them from the Health list' });
    const item = stampChange(yours, 'addon', NOW);
    expect(undoAvailability(item, { host: 'addon', companionVersion: '1.59.2' })).toEqual({ kind: 'update-companion', op: 'undo', text: 'Update the companion first' });
    expect(undoAvailability(item, { host: 'addon', companionVersion: '1.61.0' })).toEqual({ kind: 'ready', op: 'undo' });
    const plan = planChangeUndo(item, 'undo', {}, { latest: null });
    expect(plan).toMatchObject({ ok: true, plan: { needsSync: true, steps: [{ do: 'set-tx', txKey: KEY, flag: 'notTransfer' }, { do: 'set-tx', flag: 'notTransfer' }] } });
  });
});

describe('planning the Undo and Redo of a removal', () => {
  const back = { id: 'back-1', accountId: 'wf-a', type: 'DEPOSIT', date: '2026-10-09', absCents: 60000, comment: PAYLOAD.comment };
  const undoneBy = (e: ChangeEntry) => stampChange(reversalChange(e, 'undo', { activityId: 'back-1' }), 'addon', NOW);

  it('puts the row back first, then takes it off the skip list', () => {
    expect(planChangeUndo(removed(), 'undo', {}, { latest: null })).toEqual({
      ok: true,
      plan: {
        op: 'undo', needsSync: false, rowAfter: 'created', done: "Undone — it's back, and the bank feed can import it again.",
        steps: [{ do: 'create', write: PAYLOAD }, { do: 'unskip', account: 'sfin-1', txId: 'TRN-600' }],
      },
    });
  });

  it('takes every key it skipped back off', () => {
    const two = removed({ txKeys: [KEY, accountTxKey('sfin-old', 'TRN-600')] });
    const plan = planChangeUndo(two, 'undo', {}, { latest: null });
    expect(plan.ok && plan.plan.steps.slice(1)).toEqual([
      { do: 'unskip', account: 'sfin-1', txId: 'TRN-600' }, { do: 'unskip', account: 'sfin-old', txId: 'TRN-600' },
    ]);
  });

  it('refuses an Undo it cannot carry out', () => {
    expect(planChangeUndo(removed({ txKeys: [] }), 'undo', {}, { latest: null })).toEqual({ ok: false, reason: UNDO_NO_KEY });
    expect(planChangeUndo(removed({ txKeys: ['no-separator'] }), 'undo', {}, { latest: null })).toEqual({ ok: false, reason: UNDO_NO_KEY });
    expect(planChangeUndo(removed({ payload: { amount: 600 } }), 'undo', {}, { latest: null })).toEqual({ ok: false, reason: UNDO_NOT_POSSIBLE });
  });

  it('removes the row the Undo put back again, skip first — unless it is gone or now linked', () => {
    const e = removed();
    const latest = undoneBy(e);
    expect(planChangeUndo(e, 'redo', { row: { ...back, linked: false } }, { latest })).toEqual({
      ok: true,
      plan: {
        op: 'redo', needsSync: false, rowAfter: null, done: "Redone — it's removed and won't be imported again.",
        steps: [{ do: 'skip', account: 'sfin-1', txId: 'TRN-600' }, { do: 'delete', activityId: 'back-1' }],
      },
    });
    expect(planChangeUndo(e, 'redo', { row: null }, { latest })).toEqual({ ok: false, reason: undoGone('redo') });
    expect(planChangeUndo(e, 'redo', { row: { ...back, linked: 'confirmed' } }, { latest })).toEqual({ ok: false, reason: UNDO_LINKED_REFUSAL });
  });
});

describe('Undo and Redo of a removal, on a host', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function harness(rows: HostActivity[], secrets: Record<string, string>, seed: Partial<FakeHostSeed> = {}) {
    const fh = createFakeHost({ mapping: { 'sfin-1': 'wf-a' }, accountTypes: { 'wf-a': 'CASH' }, existing: new Map([['wf-a', rows]]), ...seed });
    const data = new Map(Object.entries(secrets));
    const log: ChangeEntry[] = [];
    const io: UndoIo = {
      host: fh.host,
      secrets: { get: async (k) => data.get(k) ?? null, set: async (k, v) => { data.set(k, v); } },
      record: async (d: ChangeDraft) => { log.unshift(stampChange(d, 'addon', NOW)); },
      where: { host: 'addon', companionVersion: '1.61.0' },
    };
    const asItem = (e: ChangeEntry): ChangeLogItem => {
      const latest = log.find((x) => x.reverses?.id === e.id);
      return latest?.reverses?.op === 'undo' ? { ...e, undone: { by: latest.id, at: latest.at } } : { ...e };
    };
    const undo = (e: ChangeEntry, op: UndoOp) => runChangeUndo(asItem(e), [...log, e], op, io, 'plain', NOW);
    const skipped = () => {
      const p = parseSkippedTransactionsStrict(data.get(SKIPPED_TRANSACTIONS_SECRET_KEY));
      return p.kind === 'ok' ? p.list.map((s) => `${s.account}/${s.txId}`) : p.kind;
    };
    return { fh, undo, skipped, log, data };
  }
  const list = JSON.stringify([
    { account: 'sfin-9', txId: 'KEEP' }, { account: 'sfin-1', txId: 'TRN-600', note: 'Removed for good', at: '2026-10-14T12:00:00.000Z' },
  ]);

  it('Undo re-creates the exact row and takes it off the skip list; Redo removes it again and skips it', async () => {
    const h = harness([], { [SKIPPED_TRANSACTIONS_SECRET_KEY]: list });
    const e = removed();
    expect(await h.undo(e, 'undo')).toEqual({ ok: true, message: "Undone — it's back, and the bank feed can import it again.", needsSync: false });
    expect(h.fh.saved[0]).toEqual({ creates: [PAYLOAD] });
    const [row] = h.fh.activities.get('wf-a')!;
    expect(row).toMatchObject({ accountId: 'wf-a', activityType: 'DEPOSIT', date: '2026-10-09', amount: 600, comment: PAYLOAD.comment });
    expect(h.skipped()).toEqual(['sfin-9/KEEP']);
    expect(h.log[0]).toMatchObject({ kind: 'transaction-removed', reverses: { id: e.id, op: 'undo' }, after: { activityId: row.id } });

    expect(await h.undo(e, 'redo')).toEqual({ ok: true, message: "Redone — it's removed and won't be imported again.", needsSync: false });
    expect(h.fh.activities.get('wf-a')).toEqual([]);
    expect(h.skipped()).toEqual(['sfin-9/KEEP', 'sfin-1/TRN-600']);
  });

  it('Undo of a link you made tells the sync neither half is a transfer; Redo takes that back', async () => {
    const h = harness([], {});
    const link = stampChange(transferLinkChange(OUT_LEG, IN_LEG, 'you'), 'addon', new Date('2026-10-14T12:00:00Z'));
    const told = (key: string) => {
      const p = parseSyncOverrides(h.data.get(SYNC_OVERRIDES_SECRET_KEY));
      return p.kind === 'ok' && hasTxOverride(p.overrides, key, 'notTransfer');
    };
    expect(await h.undo(link, 'undo')).toEqual({ ok: true, message: 'Undone — the next sync counts each half as spending or money in.', needsSync: true });
    expect([told(KEY), told(ALLY_KEY)]).toEqual([true, true]);
    expect(await h.undo(link, 'redo')).toEqual({ ok: true, message: 'Redone — the next sync can treat them as a transfer again.', needsSync: true });
    expect([told(KEY), told(ALLY_KEY)]).toEqual([false, false]);
  });

  it('an Undo Wealthfolio refuses as an exact copy (the row was added back by hand) changes nothing', async () => {
    const byHand: HostActivity = { id: 'hand-1', accountId: 'wf-a', activityType: 'DEPOSIT', date: '2026-10-09', amount: 600, comment: PAYLOAD.comment, sourceGroupId: null };
    const h = harness([byHand], { [SKIPPED_TRANSACTIONS_SECRET_KEY]: list }, { upstreamWriteRules: true });
    expect(await h.undo(removed(), 'undo')).toEqual({ ok: false, message: UNDO_EXACT_COPY });
    expect(h.fh.activities.get('wf-a')!.map((r) => r.id)).toEqual(['hand-1']);
    expect(h.skipped()).toEqual(['sfin-9/KEEP', 'sfin-1/TRN-600']);
    expect(h.log).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/change-entries.test.ts shared/change-undo-remove.test.ts`
Expected: FAIL — `shared/change-entries.test.ts` fails to load (`TypeError: transactionRemovedChange is not a function`), and 8 of the 9 tests of `change-undo-remove.test.ts` fail; `Undo of a link you made tells the sync neither half is a transfer; Redo takes that back` already passes — the planner was already actor-blind for a link (Y1a).

- [ ] **Step 3: Implement**

Edit 1 of 7 in `shared/change-entries.ts` — replace:

```ts
 *  - a transfer link: both legs' tx keys and their new activity ids;
 *  - an Amazon label: the label text and the note before and after.
 */
```

with:

```ts
 *  - a transfer link: both legs' tx keys and their new activity ids;
 *  - an Amazon label: the label text and the note before and after;
 *  - a row you removed for good (2c R2): its tx keys and its full create payload.
 */
```

Edit 2 of 7 in `shared/change-entries.ts` — replace:

```ts
  | 'duplicate-removed'
  | 'starting-balance' | 'starting-balance-moved' | 'balance-correction'
```

with:

```ts
  | 'duplicate-removed' | 'transaction-removed'
  | 'starting-balance' | 'starting-balance-moved' | 'balance-correction'
```

Edit 3 of 7 in `shared/change-entries.ts` — replace:

```ts
  'duplicate-removed',
  'starting-balance', 'starting-balance-moved', 'balance-correction',
```

with:

```ts
  'duplicate-removed', 'transaction-removed',
  'starting-balance', 'starting-balance-moved', 'balance-correction',
```

Edit 4 of 7 in `shared/change-entries.ts` — replace:

```ts
/** Two legs linked as one transfer. Undo (R2): `notTransfer` on both tx keys. */
export function transferLinkChange(out: LinkLegFacts, inLeg: LinkLegFacts): ChangeDraft {
```

with:

```ts
/** Two legs linked as one transfer — by the sync, or by you from the Health
 *  list (2c R2). Undo (R2): `notTransfer` on both tx keys. */
export function transferLinkChange(out: LinkLegFacts, inLeg: LinkLegFacts, actor: ChangeActor = 'auto'): ChangeDraft {
```

Edit 5 of 7 in `shared/change-entries.ts` — replace:

```ts
  return {
    actor: 'auto',
    kind: 'transfer-link',
```

with:

```ts
  return {
    actor,
    kind: 'transfer-link',
```

Edit 6 of 7 in `shared/change-entries.ts` — replace:

```ts
    summary: `Linked ${what(out.description)} and ${what(inLeg.description)} as one transfer`,
    why: 'Same amount left one account and arrived in another',
```

with:

```ts
    summary: `Linked ${what(out.description)} and ${what(inLeg.description)} as one transfer`,
    why: actor === 'you' ? 'You linked them from the Health list' : 'Same amount left one account and arrived in another',
```

Edit 7 of 7 in `shared/change-entries.ts` — replace:

```ts
    summary: `Removed a duplicate copy of ${what(f.description)}`,
    why: 'Wealthfolio held this transaction twice',
    before: { activityId: f.activityId, activity: f.payload },
    undoable: true,
  };
}
```

with:

```ts
    summary: `Removed a duplicate copy of ${what(f.description)}`,
    why: 'Wealthfolio held this transaction twice',
    before: { activityId: f.activityId, activity: f.payload },
    undoable: true,
  };
}

export interface TransactionRemovedFacts {
  account: ChangeAccount;
  /** Its key under every feed of its account: each went on the skip list. */
  txKeys: string[];
  activityId: string;
  description: string;
  /** Signed, money out negative. */
  amountCents: number;
  date: string;
  /** The deleted row as a create request (`ActivityWrite` shape). */
  payload: Record<string, unknown>;
}

/**
 * A row you removed for good (2c R2, "Remove for good…" on its story): deleted,
 * and its tx id put on the skip list so the bank feed never imports it again.
 * Undo (R2): re-create the row from `before.activity`, then take it off the
 * skip list. Redo: skip it and remove it again.
 */
export function transactionRemovedChange(f: TransactionRemovedFacts): ChangeDraft {
  return {
    actor: 'you',
    kind: 'transaction-removed',
    account: f.account,
    subject: { txKeys: [...f.txKeys], activityIds: [f.activityId], description: f.description, amountCents: f.amountCents, date: f.date },
    summary: `Removed ${what(f.description)} for good`,
    why: "You removed it; the bank feed won't import it again",
    before: { activityId: f.activityId, activity: f.payload },
    undoable: true,
  };
}
```

Edit 1 of 1 in `shared/change-view.ts` — replace:

```ts
  'duplicate-removed': 'corrections',
```

with:

```ts
  'duplicate-removed': 'corrections',
  'transaction-removed': 'corrections',
```

Edit 1 of 4 in `shared/change-undo.ts` — replace:

```ts
  ...SYNC_DECISION_KINDS, ...COMPANION_ONLY_KINDS, 'mapping-rule-created', 'starting-balance', 'starting-balance-moved',
]);
```

with:

```ts
  ...SYNC_DECISION_KINDS, ...COMPANION_ONLY_KINDS, 'mapping-rule-created', 'starting-balance', 'starting-balance-moved',
  'transaction-removed',
]);
```

Edit 2 of 4 in `shared/change-undo.ts` — replace:

```ts
/** An automatic sync decision: its undo is an override the sync must obey. */
export function needsOverrideSupport(entry: Pick<ChangeEntry, 'kind' | 'actor'>): boolean {
  return SYNC_DECISION_KINDS.has(entry.kind) && entry.actor === 'auto';
}
```

with:

```ts
/** A sync decision whose undo is an override the sync must obey: an automatic
 *  one, and a transfer link whoever made it — 2c R2 links as `you`, and its
 *  Undo is still `notTransfer` on both legs, which only a sync carries out. */
export function needsOverrideSupport(entry: Pick<ChangeEntry, 'kind' | 'actor'>): boolean {
  return SYNC_DECISION_KINDS.has(entry.kind) && (entry.actor === 'auto' || entry.kind === 'transfer-link');
}
```

Edit 3 of 4 in `shared/change-undo.ts` — replace:

```ts
    case 'duplicate-removed':
      // The copy was removed; there is no row until an undo puts one back.
      return null;
```

with:

```ts
    case 'duplicate-removed':
    case 'transaction-removed':
      // The row was removed; there is no row until an undo puts one back.
      return null;
```

Edit 4 of 4 in `shared/change-undo.ts` — replace:

```ts
    case 'import': {
      if (!key || !sfinId || !key.startsWith(`${sfinId}\u0000`)) return refuse(UNDO_NO_KEY);
```

with:

```ts
    case 'transaction-removed': {
      // Every key the removal put on the skip list: (SimpleFin account, tx id).
      const skipped: Array<{ account: string; txId: string }> = [];
      for (const k of entry.subject.txKeys ?? []) {
        const at = k.indexOf('\u0000');
        if (at <= 0 || at === k.length - 1) return refuse(UNDO_NO_KEY);
        skipped.push({ account: k.slice(0, at), txId: k.slice(at + 1) });
      }
      if (skipped.length === 0) return refuse(UNDO_NO_KEY);
      if (op === 'undo') {
        const payload = rec(before.activity);
        if (!str(payload.accountId) || !str(payload.activityType) || !str(payload.activityDate) || typeof payload.comment !== 'string') {
          return refuse(UNDO_NOT_POSSIBLE);
        }
        // The row first: a skip entry left behind is harmless to a stored row
        // (the sync never deletes one on the list's behalf), and it is reported.
        return plan({
          op, needsSync: false, rowAfter: 'created', done: "Undone — it's back, and the bank feed can import it again.",
          steps: [
            { do: 'create', write: payload as unknown as ActivityWrite },
            ...skipped.map((s) => ({ do: 'unskip' as const, account: s.account, txId: s.txId })),
          ],
        });
      }
      const row = state.row ?? null;
      if (!row) return refuse(undoGone(op));
      const linked = linkedRefusal(row);
      if (linked) return refuse(linked);
      // The skip first, as the removal did.
      return plan({
        op, needsSync: false, rowAfter: null, done: "Redone — it's removed and won't be imported again.",
        steps: [...skipped.map((s) => ({ do: 'skip' as const, account: s.account, txId: s.txId })), { do: 'delete', activityId: row.id }],
      });
    }

    case 'import': {
      if (!key || !sfinId || !key.startsWith(`${sfinId}\u0000`)) return refuse(UNDO_NO_KEY);
```

Edit 1 of 1 in `shared/change-undo-run.ts` — replace:

```ts
    case 'import': {
      state.row = await findRow(io, entry, latest, key);
```

with:

```ts
    case 'transaction-removed':
      // Only a Redo acts on a row: the one the last Undo put back.
      if (op === 'redo') state.row = await findRow(io, entry, latest, key);
      return state;
    case 'import': {
      state.row = await findRow(io, entry, latest, key);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/change-undo-remove.test.ts shared/change-entries.test.ts shared/change-undo.test.ts shared/change-undo-run.test.ts shared/change-view.test.ts`
Expected: PASS — 137 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/change-entries.test.ts shared/change-undo-remove.test.ts shared/change-entries.ts shared/change-view.ts shared/change-undo.ts shared/change-undo-run.ts
git commit -m "Audits R2: transaction-removed in the change log — Undo re-creates and un-skips, Redo removes again; a link you make is the sync's entry, as you

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Link — what Health offers, whether it still reads as shown, and the runner

Spec C1 and ruling Y2, pure (Y9: complete code and tests). `shared/fix-row.ts` is the row both fixes re-read: Wealthfolio's ActivityDetails as the SDK and REST both return it (`fixRowOf`), its exact create payload (`recreateWrite`, the shape of the sync's `recreatePayload`), and `linkedState` — a group or the add-on's ledger confirms; the companion reads groups, so nothing else is linked there; the add-on applies 2a's "maybe" rule, or for a row the snapshot read unpaired the narrowed one (Deviations). `shared/audit-link.ts`: a Health issue offers a pair when it is a leg of yours, not linked at all, with exactly one likely other half, both from the bank feed; a button carries both legs' fingerprints; `checkLinkPair` refuses a pair that no longer reads as shown and money leaving a card, and types the legs (a counterpart stored as ordinary money becomes the transfer it is); `linkPairs` reads the overrides once, then for each pair, one at a time: re-reads both rows, links through the host, writes both rows back if Wealthfolio refused the re-create after the delete, remembers the pair (the add-on) and records the entry — one failure never stops the rest, and the run counts them.

**Files:**
- Create: `shared/fix-row.ts`, `shared/fix-row.test.ts`, `shared/audit-link.ts`, `shared/audit-link.test.ts`

**Interfaces:**
- Consumes: Task 2 (`transferLinkChange(out, in, 'you')`); `HealthIssue`, `HealthLeg` (shared/audit-health.ts); the note markers (shared/audit-ledger.ts); `maybeLinkedTransfer` (shared/change-undo-run.ts); `hasTxOverride`, `LoadedSyncOverrides`, `SYNC_OVERRIDES_UNREADABLE_MESSAGE` (shared/sync-overrides.ts); `ActivityWrite`, `LinkLeg`, `LinkResult`, `SaveManyResult` (shared/sync-host.ts).
- Produces:

```ts
// shared/fix-row.ts
export interface FixRow {
  id: string; accountId: string; accountName: string; accountType: string; type: string; date: string;
  absCents: number; feeCents: number; currency: string; notes: string; subtype: string | null;
  flowExternal: boolean | null | undefined; grouped: boolean;
}
export function fixRowOf(raw: unknown, accountType: string): FixRow | null;
export function recreateWrite(row: FixRow): ActivityWrite;
export type LinkedState = 'confirmed' | 'maybe' | false;
export function linkedState(row: FixRow, how: { readsGroups: boolean; ledgerKnows: boolean; unpairedWhenRead?: boolean }): LinkedState;
// shared/audit-link.ts
export const LINK_BUTTON: string; export const linkAllButton: (n: number) => string;
export const LINK_DONE: string; export const LINK_CHANGED: string; export const LINK_CARD_OUT: string; export const LINK_UNREACHABLE: string;
export interface LinkPair { key: string; leg: HealthLeg; counterpart: HealthLeg }
export function linkablePair(issue: HealthIssue): LinkPair | null;
export function linkablePairs(issues: readonly HealthIssue[] | null | undefined): LinkPair[];
export const legFingerprint: (l: Pick<HealthLeg, 'activityId' | 'accountId' | 'absCents' | 'date' | 'type'>) => string; // 8 hex
export const pairHandle: (p: LinkPair) => string;                  // 16 hex
export const pairsHandle: (pairs: readonly LinkPair[]) => string;  // 8 hex
export interface ReadRow { row: FixRow; linked: LinkedState }
export type LinkCheck = { ok: true; legs: [LinkLeg, LinkLeg]; rows: [FixRow, FixRow]; keys: [string, string] } | { ok: false; reason: string };
export function checkLinkPair(pair: LinkPair, now: readonly [ReadRow | null, ReadRow | null], overrides: SyncOverrides): LinkCheck;
export interface LinkIo {
  read(pair: LinkPair): Promise<[ReadRow | null, ReadRow | null]>;
  overrides(): Promise<LoadedSyncOverrides>;
  link(legs: [LinkLeg, LinkLeg]): Promise<LinkResult>;
  restore(writes: ActivityWrite[]): Promise<SaveManyResult>;
  remember?(keys: [string, string], groupId: string): Promise<void>;
  record(draft: ChangeDraft): Promise<void>;
  log(msg: string): void;
}
export interface LinkRun { total: number; linked: number; changed: number; failed: number; done: string[]; message: string }
export function linkRunLine(r: Pick<LinkRun, 'total' | 'linked' | 'changed' | 'failed'>): string;
export function linkPairs(pairs: readonly LinkPair[], io: LinkIo): Promise<LinkRun>;
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/fix-row.test.ts`:**

```ts
import { describe, it, expect } from 'vitest';
import { fixRowOf, linkedState, recreateWrite, type FixRow } from './fix-row';

/** An ActivityDetails row as the SDK and REST search both return it. */
const details = (over: Record<string, unknown> = {}) => ({
  id: 'act-1', accountId: 'wf-chk', accountName: 'PNC Checking', activityType: 'deposit', date: '2026-10-09T00:00:00+00:00',
  amount: '600', fee: '0', currency: 'usd', comment: 'MOBILE DEPOSIT · TRN-600', subtype: null, sourceGroupId: null, metadata: null,
  ...over,
});
const fix = (over: Partial<FixRow> = {}): FixRow => ({ ...fixRowOf(details(), 'CASH')!, ...over });

describe('fixRowOf', () => {
  it('reads an ActivityDetails row: upper-case type and currency, cents, the UTC day, raw text', () => {
    expect(fixRowOf(details(), 'cash')).toEqual({
      id: 'act-1', accountId: 'wf-chk', accountName: 'PNC Checking', accountType: 'CASH', type: 'DEPOSIT', date: '2026-10-09',
      absCents: 60000, feeCents: 0, currency: 'USD', notes: 'MOBILE DEPOSIT · TRN-600', subtype: null, flowExternal: null, grouped: false,
    });
  });

  it('reads a 3.10 local-midnight instant as its UTC day, a group, metadata as an object or a string, and notes under either name', () => {
    const r = fixRowOf(details({ date: '2026-10-01T04:00:00+00:00', sourceGroupId: 'wf-transfer-1', metadata: { flow: { is_external: false } } }), 'CASH')!;
    expect(r).toMatchObject({ date: '2026-10-01', grouped: true, flowExternal: false });
    expect(fixRowOf(details({ metadata: '{"flow":{"is_external":true}}' }), 'CASH')!.flowExternal).toBe(true);
    const { comment: _c, metadata: _m, ...noComment } = details();
    expect(fixRowOf({ ...noComment, notes: 'N · TRN-1' }, 'CASH')).toMatchObject({ notes: 'N · TRN-1', flowExternal: undefined });
  });

  it('is null for a row it cannot write back', () => {
    for (const over of [{ id: '' }, { accountId: undefined }, { activityType: 5 }, { date: null }, { date: 'soon' }, { currency: undefined }]) {
      expect(fixRowOf(details(over), 'CASH')).toBeNull();
    }
    expect(fixRowOf(null, 'CASH')).toBeNull();
  });
});

describe('recreateWrite', () => {
  it('writes ordinary money with the cash symbol, and a transfer leg with none', () => {
    expect(recreateWrite(fix())).toEqual({
      accountId: 'wf-chk', activityType: 'DEPOSIT', activityDate: '2026-10-09', symbol: { symbol: '$CASH-USD' }, amount: 600,
      currency: 'USD', comment: 'MOBILE DEPOSIT · TRN-600',
    });
    expect(recreateWrite(fix({ type: 'TRANSFER_OUT', feeCents: 125, subtype: 'REIMBURSEMENT', flowExternal: true }))).toEqual({
      accountId: 'wf-chk', activityType: 'TRANSFER_OUT', activityDate: '2026-10-09', amount: 600, fee: 1.25, currency: 'USD',
      comment: 'MOBILE DEPOSIT · TRN-600', subtype: 'REIMBURSEMENT', metadata: '{"flow":{"is_external":true}}',
    });
  });
});

describe('linkedState', () => {
  const leg = (over: Partial<FixRow> = {}) => fix({ type: 'TRANSFER_OUT', ...over });
  const addon = { readsGroups: false, ledgerKnows: false };

  it('is confirmed by a group on the row or the add-on’s ledger, and never more than that on the companion', () => {
    expect(linkedState(fix({ grouped: true }), { readsGroups: true, ledgerKnows: false })).toBe('confirmed');
    expect(linkedState(leg(), { readsGroups: false, ledgerKnows: true })).toBe('confirmed');
    expect(linkedState(leg(), { readsGroups: true, ledgerKnows: false })).toBe(false);
  });

  it('on the add-on, a transfer-typed row nothing marks unpaired may be linked; ordinary money never is', () => {
    expect(linkedState(leg(), addon)).toBe('maybe');
    expect(linkedState(leg({ flowExternal: true }), addon)).toBe(false);
    expect(linkedState(leg({ notes: '↔️ In-transit transfer · X · TRN-1', flowExternal: undefined }), addon)).toBe(false);
    expect(linkedState(fix(), addon)).toBe(false);
  });

  it('for a row the snapshot read unpaired, only a mark a linker leaves — or no metadata at all — makes it maybe', () => {
    const seen = { ...addon, unpairedWhenRead: true };
    expect(linkedState(leg({ flowExternal: null }), seen)).toBe(false);
    expect(linkedState(leg({ flowExternal: false }), seen)).toBe('maybe');
    expect(linkedState(leg({ flowExternal: undefined }), seen)).toBe('maybe');
    expect(linkedState(leg({ flowExternal: true }), seen)).toBe(false);
  });
});
```

**Create `shared/audit-link.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import type { HealthIssue, HealthLeg } from './audit-health';
import {
  checkLinkPair, legFingerprint, linkablePair, linkablePairs, linkPairs, linkRunLine, pairHandle, pairsHandle,
  LINK_CARD_OUT, LINK_CHANGED, LINK_DONE, LINK_UNREACHABLE, type LinkIo, type LinkPair, type ReadRow,
} from './audit-link';
import type { ChangeDraft } from './change-entries';
import type { FixRow } from './fix-row';
import type { LinkLeg } from './sync-host';
import { emptySyncOverrides, setTxOverride, SYNC_OVERRIDES_UNREADABLE_MESSAGE } from './sync-overrides';
import { accountTxKey } from './transfers';

const NOW = new Date('2026-10-14T15:00:00Z');
const OUT_KEY = accountTxKey('sfin-chk', 'TRN-1');
const IN_KEY = accountTxKey('sfin-ally', 'TRN-2');
const LEG: HealthLeg = {
  activityId: 'out-1', accountId: 'wf-chk', accountName: 'PNC Checking', txKey: OUT_KEY, date: '2026-10-04', absCents: 60000,
  type: 'TRANSFER_OUT', currency: 'USD', description: 'TRANSFER TO ALLY',
};
const OTHER: HealthLeg = {
  activityId: 'in-1', accountId: 'wf-ally', accountName: 'Ally Savings', txKey: IN_KEY, date: '2026-10-05', absCents: 60000,
  type: 'DEPOSIT', currency: 'USD', description: 'FROM PNC',
};
const issue = (over: Partial<Extract<HealthIssue, { kind: 'incomplete-leg' }>> = {}): HealthIssue => ({
  kind: 'incomplete-leg', key: 'leg:out-1', leg: LEG, problem: null, owner: 'you', match: 'one', counterpart: OTHER, ...over,
});
const PAIR: LinkPair = { key: 'leg:out-1', leg: LEG, counterpart: OTHER };

/** A row as a host re-reads it, the way its Health leg showed it. */
const row = (l: HealthLeg, over: Partial<FixRow> = {}): FixRow => ({
  id: l.activityId, accountId: l.accountId, accountName: l.accountName, accountType: 'CASH', type: l.type, date: l.date,
  absCents: l.absCents, feeCents: 0, currency: 'USD', notes: `${l.description} · ${l.txKey!.split('\u0000')[1]}`,
  subtype: null, flowExternal: null, grouped: false, ...over,
});
const read = (a: Partial<FixRow> = {}, b: Partial<FixRow> = {}): [ReadRow, ReadRow] => [
  { row: row(LEG, a), linked: false }, { row: row(OTHER, b), linked: false },
];
const none = emptySyncOverrides();

/** Pair i: its own ids, keys and amount. */
const pairN = (i: number): LinkPair => ({
  key: `leg:out-${i}`,
  leg: { ...LEG, activityId: `out-${i}`, txKey: accountTxKey('sfin-chk', `TRN-o${i}`), absCents: 1000 + i },
  counterpart: { ...OTHER, activityId: `in-${i}`, txKey: accountTxKey('sfin-ally', `TRN-i${i}`), absCents: 1000 + i },
});

function fakeIo(over: Partial<LinkIo> = {}) {
  const links: Array<[LinkLeg, LinkLeg]> = [];
  const recorded: ChangeDraft[] = [];
  const io: LinkIo = {
    read: vi.fn(async (p: LinkPair): Promise<[ReadRow, ReadRow]> => [{ row: row(p.leg), linked: false }, { row: row(p.counterpart), linked: false }]),
    overrides: vi.fn(async () => ({ overrides: none, unreadable: false })),
    link: vi.fn(async (legs: [LinkLeg, LinkLeg]) => {
      links.push(legs);
      return { linked: true, groupId: `wf-transfer-${links.length}`, activityIds: [`new-${legs[0].wfId}`, `new-${legs[1].wfId}`] as [string, string] };
    }),
    restore: vi.fn(async () => ({ created: [], updated: [], errors: [] })),
    remember: vi.fn(async () => {}),
    record: vi.fn(async (d: ChangeDraft) => { recorded.push(d); }),
    log: vi.fn(),
    ...over,
  };
  return { io, links, recorded };
}

describe('what the Health list offers to link', () => {
  it('offers a leg of yours, not linked at all, with exactly one other half, both from the bank feed', () => {
    expect(linkablePair(issue())).toEqual(PAIR);
    for (const over of [
      { owner: 'add-on' as const }, { match: 'many' as const, counterpart: null }, { problem: { kind: 'legs' as const, count: 1 } },
      { counterpart: null }, { leg: { ...LEG, txKey: null } }, { counterpart: { ...OTHER, txKey: null } },
    ]) {
      expect(linkablePair(issue(over))).toBeNull();
    }
    const late: HealthIssue = { kind: 'late-start', key: 'late-start:s', activityId: 's', accountId: 'a', accountName: 'A', date: '2026-10-02', earliest: '2026-10-01', cents: 1 };
    expect(linkablePairs([issue(), late, issue({ owner: 'add-on' })])).toEqual([PAIR]);
    expect(linkablePairs(null)).toEqual([]);
  });

  it('fingerprints what was shown: the handle moves when a leg’s account, amount, date or type does', () => {
    expect(pairHandle(PAIR)).toMatch(/^[0-9a-f]{16}$/);
    expect(pairsHandle([PAIR, pairN(2)])).toMatch(/^[0-9a-f]{8}$/);
    for (const over of [{ accountId: 'x' }, { absCents: 1 }, { date: '2026-10-06' }, { type: 'TRANSFER_IN' }]) {
      expect(legFingerprint({ ...LEG, ...over })).not.toBe(legFingerprint(LEG));
    }
    const renamed: HealthLeg = { ...LEG, description: 'renamed' };
    expect(legFingerprint(renamed)).toBe(legFingerprint(LEG));
    expect(pairsHandle([PAIR, pairN(2)])).not.toBe(pairsHandle([PAIR, pairN(3)]));
  });
});

describe('checkLinkPair', () => {
  it('links money out first, a counterpart stored as ordinary money typed as the transfer it is, each with its own note', () => {
    expect(checkLinkPair(PAIR, read(), none)).toEqual({
      ok: true,
      legs: [
        { wfId: 'out-1', accountId: 'wf-chk', txId: 'TRN-1', activityType: 'TRANSFER_OUT', date: '2026-10-04', absCents: 60000, currency: 'USD', comment: 'TRANSFER TO ALLY · TRN-1' },
        { wfId: 'in-1', accountId: 'wf-ally', txId: 'TRN-2', activityType: 'TRANSFER_IN', date: '2026-10-05', absCents: 60000, currency: 'USD', comment: 'FROM PNC · TRN-2' },
      ],
      rows: [row(LEG), row(OTHER)],
      keys: [OUT_KEY, IN_KEY],
    });
    // A card payment: the leg is the card's money in, the counterpart the checking withdrawal.
    const card: LinkPair = {
      key: 'leg:in-9',
      leg: { ...OTHER, activityId: 'in-9', type: 'TRANSFER_IN', accountId: 'wf-card' },
      counterpart: { ...LEG, activityId: 'out-9', type: 'WITHDRAWAL' },
    };
    const check = checkLinkPair(card, [{ row: row(card.leg, { accountType: 'CREDIT_CARD' }), linked: false }, { row: row(card.counterpart), linked: false }], none);
    expect(check.ok && check.legs.map((l) => [l.wfId, l.activityType])).toEqual([['out-9', 'TRANSFER_OUT'], ['in-9', 'TRANSFER_IN']]);
  });

  it.each([
    ['gone', [null, read()[1]]],
    ['moved to another account', read({ accountId: 'wf-other' })],
    ['a new amount', read({}, { absCents: 59999 })],
    ['a new date', read({ date: '2026-10-03' })],
    ['a new type', read({}, { type: 'CREDIT' })],
    ['pending', read({ notes: 'TRANSFER TO ALLY · TRN-1 · pending' })],
    ['an in-transit placeholder', read({ notes: '↔️ In-transit transfer · TRANSFER TO ALLY · TRN-1' })],
    ['an opening balance', read({}, { notes: 'Starting balance · sfin-ally' })],
    ['a correction', read({}, { notes: 'Balance adjustment · sfin-ally · 2026-10-05' })],
    ['a different bank transaction', read({ notes: 'TRANSFER TO ALLY · TRN-77' })],
  ] as Array<[string, [ReadRow | null, ReadRow | null]]>)('refuses a row that is %s', (_why, now) => {
    expect(checkLinkPair(PAIR, now, none)).toEqual({ ok: false, reason: LINK_CHANGED });
  });

  it('refuses a row that is linked, or may be, and a leg you said is not a transfer', () => {
    const [a, b] = read();
    expect(checkLinkPair(PAIR, [{ ...a, linked: 'confirmed' }, b], none)).toEqual({ ok: false, reason: LINK_CHANGED });
    expect(checkLinkPair(PAIR, [a, { ...b, linked: 'maybe' }], none)).toEqual({ ok: false, reason: LINK_CHANGED });
    const told = setTxOverride(none, IN_KEY, 'notTransfer', NOW, { label: 'FROM PNC · Ally Savings' });
    expect(checkLinkPair(PAIR, read(), told)).toEqual({ ok: false, reason: LINK_CHANGED });
  });

  it('refuses money leaving a card unless the card already stores it as a transfer out (Wealthfolio 3.10)', () => {
    const fromCard: LinkPair = {
      key: 'leg:in-c', leg: { ...OTHER, activityId: 'in-c', type: 'TRANSFER_IN' }, counterpart: { ...LEG, activityId: 'out-c', accountId: 'wf-card', type: 'WITHDRAWAL' },
    };
    const now = (type: string): [ReadRow, ReadRow] => [
      { row: row(fromCard.leg), linked: false },
      { row: row({ ...fromCard.counterpart, type }, { accountType: 'CREDIT_CARD' }), linked: false },
    ];
    expect(checkLinkPair(fromCard, now('WITHDRAWAL'), none)).toEqual({ ok: false, reason: LINK_CARD_OUT });
    const stored = { ...fromCard, counterpart: { ...fromCard.counterpart, type: 'TRANSFER_OUT' } };
    expect(checkLinkPair(stored, now('TRANSFER_OUT'), none).ok).toBe(true);
  });
});

describe('linkPairs', () => {
  it('links one pair, records it as yours with both legs, remembers it, and says "Linked."', async () => {
    const f = fakeIo();
    expect(await linkPairs([PAIR], f.io)).toEqual({ total: 1, linked: 1, changed: 0, failed: 0, done: ['leg:out-1'], message: LINK_DONE });
    expect(f.links).toHaveLength(1);
    expect(f.io.remember).toHaveBeenCalledWith([OUT_KEY, IN_KEY], 'wf-transfer-1');
    expect(f.recorded[0]).toMatchObject({
      actor: 'you', kind: 'transfer-link', undoable: true, summary: 'Linked TRANSFER TO ALLY and FROM PNC as one transfer',
      subject: { txKeys: [OUT_KEY, IN_KEY], activityIds: ['new-out-1', 'new-in-1'], amountCents: -60000 },
      before: { activityIds: ['out-1', 'in-1'] },
      after: { legs: [{ accountName: 'PNC Checking', sfinAccountId: 'sfin-chk' }, { accountName: 'Ally Savings', sfinAccountId: 'sfin-ally' }] },
    });
  });

  it('writes nothing for a row that changed between the snapshot and the click', async () => {
    const f = fakeIo({ read: vi.fn(async () => read({}, { absCents: 61000 })) });
    expect((await linkPairs([PAIR], f.io)).message).toBe(LINK_CHANGED);
    expect(f.io.link).not.toHaveBeenCalled();
    expect(f.io.record).not.toHaveBeenCalled();
  });

  it.each([
    ['a pending leg', { read: vi.fn(async () => read({ notes: 'TRANSFER TO ALLY · TRN-1 · pending' })) }],
    ['a row the add-on cannot rule out as linked', { read: vi.fn(async () => { const [a, b] = read(); return [a, { ...b, linked: 'maybe' }] as [ReadRow, ReadRow]; }) }],
    ['a notTransfer override', { overrides: vi.fn(async () => ({ overrides: setTxOverride(none, OUT_KEY, 'notTransfer', NOW), unreadable: false })) }],
  ] as Array<[string, Partial<LinkIo>]>)('refuses %s and writes nothing', async (_why, over) => {
    const f = fakeIo(over);
    expect((await linkPairs([PAIR], f.io)).message).toBe(LINK_CHANGED);
    expect(f.io.link).not.toHaveBeenCalled();
  });

  it('Link all goes on past a pair that changed and one that failed, and counts each', async () => {
    const pairs = [pairN(1), pairN(2), pairN(3), pairN(4)];
    const f = fakeIo({
      read: vi.fn(async (p: LinkPair): Promise<[ReadRow, ReadRow]> => [
        { row: row(p.leg, p.key === 'leg:out-2' ? { absCents: 1 } : {}), linked: false }, { row: row(p.counterpart), linked: false },
      ]),
    });
    const link = f.io.link;
    f.io.link = vi.fn(async (legs: [LinkLeg, LinkLeg]) => {
      if (legs[0].wfId === 'out-3') throw new Error('socket hang up');
      return link(legs);
    });
    const run = await linkPairs(pairs, f.io);
    expect(run).toMatchObject({ total: 4, linked: 2, changed: 1, failed: 1, done: ['leg:out-1', 'leg:out-4'] });
    expect(run.message).toBe("Linked 2 of 4 — 1 had changed since, 1 couldn't be linked.");
    expect(f.links.map((l) => l[0].wfId)).toEqual(['out-1', 'out-4']);
    expect(f.recorded).toHaveLength(2);
  });

  it('words a run', () => {
    expect(linkRunLine({ total: 4, linked: 3, changed: 1, failed: 0 })).toBe('Linked 3 of 4 — 1 had changed since.');
    expect(linkRunLine({ total: 3, linked: 3, changed: 0, failed: 0 })).toBe('Linked all 3.');
    expect(linkRunLine({ total: 1, linked: 1, changed: 0, failed: 0 })).toBe(LINK_DONE);
    expect(linkRunLine({ total: 0, linked: 0, changed: 0, failed: 0 })).toBe(LINK_CHANGED);
  });

  it('puts both rows back exactly when Wealthfolio refuses the re-create after the delete went through', async () => {
    const f = fakeIo({ link: vi.fn(async () => ({ linked: false, problems: ['save (create): not supported for this account'] })) });
    const run = await linkPairs([PAIR], f.io);
    expect(run.message).toBe('Wealthfolio refused the link (not supported for this account). Both rows are back as they were.');
    expect(f.io.restore).toHaveBeenCalledWith([
      { accountId: 'wf-chk', activityType: 'TRANSFER_OUT', activityDate: '2026-10-04', amount: 600, currency: 'USD', comment: 'TRANSFER TO ALLY · TRN-1' },
      { accountId: 'wf-ally', activityType: 'DEPOSIT', activityDate: '2026-10-05', symbol: { symbol: '$CASH-USD' }, amount: 600, currency: 'USD', comment: 'FROM PNC · TRN-2' },
    ]);
    expect(f.io.record).not.toHaveBeenCalled();
    const lost = fakeIo({
      link: vi.fn(async () => ({ linked: false, problems: ['save (create): no'] })),
      restore: vi.fn(async () => ({ created: [], updated: [], errors: [{ action: 'create', message: 'down' }] })),
    });
    expect((await linkPairs([PAIR], lost.io)).message)
      .toBe("Wealthfolio refused the link (no), and the two rows couldn't be put back — the next sync brings back any the bank still sends.");
    const kept = fakeIo({ link: vi.fn(async () => ({ linked: false, problems: ['delete (delete): not found', 'save (create): no'] })) });
    expect((await linkPairs([PAIR], kept.io)).message).toBe("Couldn't link them: delete (delete): not found.");
    expect(kept.io.restore).not.toHaveBeenCalled();
  });

  it('never lets the log or the ledger cost the link', async () => {
    const f = fakeIo({ record: vi.fn(async () => { throw new Error('log down'); }), remember: vi.fn(async () => { throw new Error('ledger corrupt'); }) });
    expect((await linkPairs([PAIR], f.io)).message).toBe(LINK_DONE);
    expect(f.io.log).toHaveBeenCalledTimes(2);
  });

  it('reads and writes nothing when the overrides cannot be read', async () => {
    const f = fakeIo({ overrides: vi.fn(async () => ({ overrides: none, unreadable: true })) });
    expect((await linkPairs([PAIR, pairN(2)], f.io)).message).toBe(SYNC_OVERRIDES_UNREADABLE_MESSAGE);
    expect(f.io.read).not.toHaveBeenCalled();
    const down = fakeIo({ overrides: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) });
    expect((await linkPairs([PAIR], down.io)).message).toBe(LINK_UNREACHABLE);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/fix-row.test.ts shared/audit-link.test.ts`
Expected: FAIL — `Failed to resolve import "./fix-row"` and `Failed to resolve import "./audit-link"`; no tests run.

- [ ] **Step 3: Implement**

**Create `shared/fix-row.ts`:**

```ts
/**
 * shared/fix-row.ts
 *
 * One stored activity as the fixes (2c R2, spec C) re-read it right before
 * they write: Link (shared/audit-link.ts) and Remove for good
 * (shared/tx-remove.ts). Both hosts read the same shape — Wealthfolio's
 * ActivityDetails, through the add-on SDK's exact-id search or the
 * companion's REST search — so one reader serves both. Pure.
 */
import { maybeLinkedTransfer } from './change-undo-run.js';
import { flowExternalOf, isTransferType } from './sync-core.js';
import type { ActivityWrite } from './sync-host.js';

export interface FixRow {
  id: string;
  accountId: string;
  /** Raw. */
  accountName: string;
  /** Upper-case: 'CASH', 'CREDIT_CARD', … ('' when unknown). */
  accountType: string;
  /** Upper-case. */
  type: string;
  /** YYYY-MM-DD: the UTC day of the stored instant. */
  date: string;
  absCents: number;
  feeCents: number;
  /** Upper-case. */
  currency: string;
  /** The stored note, raw. */
  notes: string;
  subtype: string | null;
  /** `metadata.flow.is_external`: true/false; null when unset; undefined
   *  when the host did not report metadata (unknown, never "unset"). */
  flowExternal: boolean | null | undefined;
  /** The host reported a transfer group id on the row. */
  grouped: boolean;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const cents = (v: unknown) => Math.round(Math.abs(Number(v ?? 0)) * 100) || 0;
/** The day the add-on's story shows (src/utils/tx-story.ts): the stored instant's UTC day. */
function isoDay(v: unknown): string {
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? String(v ?? '').slice(0, 10) : d.toISOString().slice(0, 10);
}

/** An ActivityDetails row as the fixes read it; null when it lacks an id, an
 *  account, a type, a date or a currency. `accountType` comes from the
 *  host's account list. */
export function fixRowOf(raw: unknown, accountType: string): FixRow | null {
  if (!isRecord(raw)) return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  const accountId = typeof raw.accountId === 'string' ? raw.accountId : '';
  const type = typeof raw.activityType === 'string' ? raw.activityType.toUpperCase() : '';
  const date = raw.date === null || raw.date === undefined ? '' : isoDay(raw.date);
  const currency = typeof raw.currency === 'string' ? raw.currency.toUpperCase() : '';
  if (!id || !accountId || !type || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !currency) return null;
  const notes = typeof raw.comment === 'string' ? raw.comment : typeof raw.notes === 'string' ? raw.notes : '';
  return {
    id, accountId, accountName: typeof raw.accountName === 'string' ? raw.accountName : '', accountType: accountType.toUpperCase(),
    type, date, absCents: cents(raw.amount), feeCents: cents(raw.fee), currency, notes,
    subtype: typeof raw.subtype === 'string' && raw.subtype.trim() !== '' ? raw.subtype : null,
    flowExternal: 'metadata' in raw ? flowExternalOf(raw.metadata) : undefined,
    grouped: typeof raw.sourceGroupId === 'string' && raw.sourceGroupId.trim() !== '',
  };
}

/**
 * The row as the create request that writes it again, exactly: the same
 * shape the sync's `recreatePayload` keeps for a removed duplicate
 * (shared/sync-core.ts). A transfer leg carries no symbol (see
 * `isTransferType`); everything else resolves the cash asset by symbol.
 */
export function recreateWrite(row: FixRow): ActivityWrite {
  return {
    accountId: row.accountId,
    activityType: row.type,
    activityDate: row.date,
    ...(isTransferType(row.type) ? {} : { symbol: { symbol: `$CASH-${row.currency}` } }),
    amount: row.absCents / 100,
    ...(row.feeCents ? { fee: row.feeCents / 100 } : {}),
    currency: row.currency,
    comment: row.notes,
    ...(row.subtype ? { subtype: row.subtype } : {}),
    ...(typeof row.flowExternal === 'boolean' ? { metadata: JSON.stringify({ flow: { is_external: row.flowExternal } }) } : {}),
  };
}

/** Half of a linked transfer: known to be, possibly (the add-on cannot always tell), or not. */
export type LinkedState = 'confirmed' | 'maybe' | false;

/**
 * How sure a host is that a row is half of a linked pair.
 *  - A group id on the row, or the add-on's own `linked_groups` ledger: confirmed.
 *  - A host that reads groups (the companion): nothing else is.
 *  - The add-on, which cannot count on reading groups back: change-undo-run.ts's
 *    rule (`maybeLinkedTransfer`) — a transfer-typed row nothing marks as unpaired
 *    may be. With `unpairedWhenRead` (Link: the companion read this row from the
 *    database, unpaired, for the snapshot) a row may be linked only if a linker
 *    that keeps its id has marked it since: Wealthfolio's own link stamps
 *    `flow.is_external: false` on both rows (storage-sqlite activities
 *    repository.rs:1103-1108 at v3.8.0), and every other linker re-creates
 *    both rows under new ids. Metadata the host did not report may be either.
 */
export function linkedState(row: FixRow, how: { readsGroups: boolean; ledgerKnows: boolean; unpairedWhenRead?: boolean }): LinkedState {
  if (row.grouped || how.ledgerKnows) return 'confirmed';
  if (how.readsGroups || !isTransferType(row.type)) return false;
  if (how.unpairedWhenRead) return row.flowExternal === false || row.flowExternal === undefined ? 'maybe' : false;
  const metadata = row.flowExternal === undefined ? {}
    : { metadata: row.flowExternal === null ? null : JSON.stringify({ flow: { is_external: row.flowExternal } }) };
  return maybeLinkedTransfer({ id: row.id, accountId: row.accountId, activityType: row.type, date: row.date, amount: null, comment: row.notes, ...metadata })
    ? 'maybe' : false;
}
```

**Create `shared/audit-link.ts`:**

```ts
/**
 * shared/audit-link.ts
 *
 * Link, from the Health list (2c R2, spec C1): a Health leg with exactly one
 * likely other half is linked to it in one tap — the list is the preview.
 * "Link all N" links every pair the list shows, one at a time. Pure decisions
 * and a host-neutral runner; each host lends its reads and writes
 * (companion/src/audit-fix-host.ts, src/utils/audit-fix.ts).
 *
 * Right before each pair's write both rows are re-read by id, and nothing is
 * written — "It has changed since — nothing was linked." — when either row
 * changed account, amount, date or type; is linked, or may be (the add-on);
 * carries a `notTransfer` override; is pending (the sync never pairs one); is
 * the add-on's own in-transit placeholder, opening balance or correction; or
 * no longer carries the tx id its Health leg named. Money leaving a card is
 * refused on its own words: Wealthfolio 3.8 and 3.9 accept no TRANSFER_OUT on
 * a card (v1.55), and a WITHDRAWAL is never half of a valid pair. A card row
 * already stored as a TRANSFER_OUT (3.10 accepts one) links like any other.
 *
 * The write is the sync's own linker, `linkPairByRecreate`, through the
 * host's `linkPair` (shared/link-pair.ts). It DELETES both rows and then
 * re-creates them as one marked group. Wealthfolio applies a bulk request all
 * or nothing (activities_service.rs, bulk_mutate_activities), so a re-create
 * it refuses wrote nothing while the delete already went through: the runner
 * then writes both rows back exactly as they were (`recreateWrite`) and says so.
 *
 * Each link is a `transfer-link` change entry with actor `you`, so the change
 * log's Undo — `notTransfer` on both legs, which the next sync acts on — and
 * Redo work unchanged. On the add-on the pair also goes into its
 * `linked_groups` ledger: its sync cannot read groups back, and the ledger is
 * how it knows to leave both legs as stored. Neither the log nor the ledger
 * ever costs the link.
 */
import type { HealthIssue, HealthLeg } from './audit-health.js';
import { isCorrectionNote, isPendingNote, isPlaceholderNote, isStartingBalanceNote } from './audit-ledger.js';
import { transferLinkChange, type ChangeDraft, type LinkLegFacts } from './change-entries.js';
import { recreateWrite, type FixRow, type LinkedState } from './fix-row.js';
import { findingHandle } from './handle.js';
import { descriptionFromComment, txIdFromComment } from './sync-core.js';
import type { ActivityWrite, LinkLeg, LinkResult, SaveManyResult } from './sync-host.js';
import { hasTxOverride, SYNC_OVERRIDES_UNREADABLE_MESSAGE, type LoadedSyncOverrides, type SyncOverrides } from './sync-overrides.js';

export const LINK_BUTTON = 'Link';
export const linkAllButton = (n: number): string => `Link all ${n}`;
export const LINK_DONE = 'Linked.';
export const LINK_CHANGED = 'It has changed since — nothing was linked.';
export const LINK_CARD_OUT = "Wealthfolio doesn't take a transfer out of a credit card, so these two can't be linked here.";
export const LINK_UNREACHABLE = "Couldn't reach Wealthfolio — nothing was linked.";

/** A Health leg and its one likely other half, as the list shows them. */
export interface LinkPair {
  /** The Health issue's key. */
  key: string;
  leg: HealthLeg;
  counterpart: HealthLeg;
}

/** The pair a Health issue offers to link, or null: a leg of yours, not
 *  linked at all, with exactly one likely other half, both from the bank
 *  feed (each needs its tx key: the change log's Undo works by it). */
export function linkablePair(issue: HealthIssue): LinkPair | null {
  if (issue.kind !== 'incomplete-leg' || issue.owner !== 'you' || issue.problem !== null || issue.match !== 'one') return null;
  if (!issue.counterpart || !issue.leg.txKey || !issue.counterpart.txKey) return null;
  return { key: issue.key, leg: issue.leg, counterpart: issue.counterpart };
}

export function linkablePairs(issues: readonly HealthIssue[] | null | undefined): LinkPair[] {
  return (issues ?? []).map(linkablePair).filter((p): p is LinkPair => p !== null);
}

/** What a leg looked like when it was shown: its id, account, amount, date and type. */
export const legFingerprint = (l: Pick<HealthLeg, 'activityId' | 'accountId' | 'absCents' | 'date' | 'type'>): string =>
  findingHandle([l.activityId, l.accountId, l.absCents, l.date, l.type].join('\u001f'));
/** A pair as a button carries it: both legs' fingerprints, 16 hex. */
export const pairHandle = (p: LinkPair): string => `${legFingerprint(p.leg)}${legFingerprint(p.counterpart)}`;
/** Every pair a list showed, as "Link all" carries them: 8 hex. */
export const pairsHandle = (pairs: readonly LinkPair[]): string => findingHandle(pairs.map(pairHandle).join(','));

/** A row re-read right before the write, and whether it is linked. */
export interface ReadRow {
  row: FixRow;
  linked: LinkedState;
}

export type LinkCheck =
  | { ok: true; legs: [LinkLeg, LinkLeg]; rows: [FixRow, FixRow]; keys: [string, string] }
  | { ok: false; reason: string };

const OUT_TYPES = new Set(['TRANSFER_OUT', 'WITHDRAWAL']);
const IN_TYPES = new Set(['TRANSFER_IN', 'DEPOSIT', 'CREDIT']);
const changed: LinkCheck = { ok: false, reason: LINK_CHANGED };

/**
 * The pair as it stands now (leg first, then the counterpart; null: gone)
 * against how it was shown. The legs come back money-out first, typed
 * TRANSFER_OUT and TRANSFER_IN — a counterpart stored as ordinary money gets
 * the right type — with their own notes, so each keeps its bank text and id.
 */
export function checkLinkPair(pair: LinkPair, now: readonly [ReadRow | null, ReadRow | null], overrides: SyncOverrides): LinkCheck {
  const shown = [pair.leg, pair.counterpart] as const;
  for (let i = 0; i < 2; i++) {
    const read = now[i];
    const was = shown[i];
    if (!read) return changed;
    const { row } = read;
    if (row.id !== was.activityId || row.accountId !== was.accountId || row.absCents !== was.absCents || row.date !== was.date || row.type !== was.type) {
      return changed;
    }
    if (read.linked) return changed;
    if (isPendingNote(row.notes) || isPlaceholderNote(row.notes) || isStartingBalanceNote(row.notes) || isCorrectionNote(row.notes)) return changed;
    const txId = txIdFromComment(row.notes);
    if (!was.txKey || !txId || !was.txKey.endsWith(`\u0000${txId}`)) return changed;
    if (hasTxOverride(overrides, was.txKey, 'notTransfer')) return changed;
  }
  const outAt = pair.leg.type === 'TRANSFER_OUT' ? 0 : 1;
  const out = now[outAt]!.row;
  const into = now[1 - outAt]!.row;
  if (!OUT_TYPES.has(out.type) || !IN_TYPES.has(into.type) || out.accountId === into.accountId || out.currency !== into.currency) return changed;
  if (out.accountType === 'CREDIT_CARD' && out.type !== 'TRANSFER_OUT') return { ok: false, reason: LINK_CARD_OUT };
  const leg = (row: FixRow, activityType: string): LinkLeg => ({
    wfId: row.id, accountId: row.accountId, txId: txIdFromComment(row.notes)!, activityType, date: row.date,
    absCents: row.absCents, currency: row.currency, comment: row.notes,
  });
  return {
    ok: true,
    legs: [leg(out, 'TRANSFER_OUT'), leg(into, 'TRANSFER_IN')],
    rows: [out, into],
    keys: [shown[outAt].txKey!, shown[1 - outAt].txKey!],
  };
}

/** What a host lends the runner. */
export interface LinkIo {
  /** Both rows by id, now (leg first; null: gone). Rejects when unreachable. */
  read(pair: LinkPair): Promise<[ReadRow | null, ReadRow | null]>;
  /** The overrides document (`loadSyncOverrides`). */
  overrides(): Promise<LoadedSyncOverrides>;
  /** The host's `linkPair`: `linkPairByRecreate`. */
  link(legs: [LinkLeg, LinkLeg]): Promise<LinkResult>;
  /** Writes rows back (the host's `saveMany` creates). */
  restore(writes: ActivityWrite[]): Promise<SaveManyResult>;
  /** The add-on: put the pair in `linked_groups`. Absent on the companion. */
  remember?(keys: [string, string], groupId: string): Promise<void>;
  /** Appends to the change log through the host's own writer. */
  record(draft: ChangeDraft): Promise<void>;
  log(msg: string): void;
}

export interface LinkRun {
  total: number;
  linked: number;
  changed: number;
  failed: number;
  /** The issue keys linked (the app retires their buttons). */
  done: string[];
  /** What to say, in place. */
  message: string;
}

type One = { kind: 'linked' } | { kind: 'changed' } | { kind: 'failed'; message: string };

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function linkOne(pair: LinkPair, io: LinkIo, overrides: SyncOverrides): Promise<One> {
  let now: [ReadRow | null, ReadRow | null];
  try {
    now = await io.read(pair);
  } catch (err) {
    io.log(`Link ${pair.key}: reading the rows failed: ${errorText(err)}`);
    return { kind: 'failed', message: LINK_UNREACHABLE };
  }
  const check = checkLinkPair(pair, now, overrides);
  if (!check.ok) return check.reason === LINK_CHANGED ? { kind: 'changed' } : { kind: 'failed', message: check.reason };

  let result: LinkResult;
  try {
    result = await io.link(check.legs);
  } catch (err) {
    io.log(`Link ${pair.key}: ${errorText(err)}`);
    return { kind: 'failed', message: `Couldn't link them: ${errorText(err)}. Check both accounts in Wealthfolio.` };
  }
  if (!result.linked || !result.groupId) {
    const problems = result.problems ?? [];
    io.log(`Link ${pair.key}: ${problems.join('; ') || 'not linked'}`);
    const refused = problems.find((p) => p.startsWith('save ('));
    if (refused && !problems.some((p) => p.startsWith('delete ('))) {
      const why = refused.replace(/^save \([^)]*\): /, '');
      try {
        const back = await io.restore(check.rows.map(recreateWrite));
        if (back.errors.length === 0) return { kind: 'failed', message: `Wealthfolio refused the link (${why}). Both rows are back as they were.` };
        io.log(`Link ${pair.key}: putting the rows back failed: ${back.errors.map((e) => e.message).join('; ')}`);
      } catch (err) {
        io.log(`Link ${pair.key}: putting the rows back failed: ${errorText(err)}`);
      }
      return {
        kind: 'failed',
        message: `Wealthfolio refused the link (${why}), and the two rows couldn't be put back — the next sync brings back any the bank still sends.`,
      };
    }
    return { kind: 'failed', message: `Couldn't link them: ${problems[0] ?? 'Wealthfolio did not say why'}.` };
  }

  const [out, into] = check.rows;
  if (io.remember) {
    try {
      await io.remember(check.keys, result.groupId);
    } catch (err) {
      io.log(`Link ${pair.key}: linked, but linked_groups was not updated: ${errorText(err)}`);
    }
  }
  const facts = (row: FixRow, key: string, amountCents: number, newId?: string): LinkLegFacts => ({
    account: { sfinId: key.slice(0, key.indexOf('\u0000')), wfId: row.accountId, name: row.accountName },
    txKey: key,
    description: descriptionFromComment(row.notes),
    amountCents,
    date: row.date,
    oldActivityId: row.id,
    ...(newId ? { newActivityId: newId } : {}),
  });
  try {
    await io.record(transferLinkChange(
      facts(out, check.keys[0], -out.absCents, result.activityIds?.[0]),
      facts(into, check.keys[1], into.absCents, result.activityIds?.[1]),
      'you',
    ));
  } catch (err) {
    // The log never costs the work.
    io.log(`Link ${pair.key}: linked, but the change log was not written: ${errorText(err)}`);
  }
  return { kind: 'linked' };
}

/** "Linked." / "Linked all 4." / "Linked 3 of 4 — 1 had changed since." */
export function linkRunLine(r: Pick<LinkRun, 'total' | 'linked' | 'changed' | 'failed'>): string {
  if (r.total === 0) return LINK_CHANGED;
  if (r.linked === r.total) return r.total === 1 ? LINK_DONE : `Linked all ${r.total}.`;
  const why = [
    r.changed > 0 ? `${r.changed} had changed since` : null,
    r.failed > 0 ? `${r.failed} couldn't be linked` : null,
  ].filter(Boolean).join(', ');
  return `Linked ${r.linked} of ${r.total} — ${why}.`;
}

/**
 * Links each pair, one at a time: one failure never stops the rest, and the
 * result counts them. One pair says exactly what happened to it. Nothing is
 * read or written when the overrides document cannot be read (a pair's
 * `notTransfer` could not be checked).
 */
export async function linkPairs(pairs: readonly LinkPair[], io: LinkIo): Promise<LinkRun> {
  const run: LinkRun = { total: pairs.length, linked: 0, changed: 0, failed: 0, done: [], message: '' };
  let loaded: LoadedSyncOverrides;
  try {
    loaded = await io.overrides();
  } catch (err) {
    io.log(`Link: reading the overrides failed: ${errorText(err)}`);
    return { ...run, message: LINK_UNREACHABLE };
  }
  if (loaded.unreadable) return { ...run, message: SYNC_OVERRIDES_UNREADABLE_MESSAGE };
  let last = '';
  for (const pair of pairs) {
    let one: One;
    try {
      one = await linkOne(pair, io, loaded.overrides);
    } catch (err) {
      io.log(`Link ${pair.key}: ${errorText(err)}`);
      one = { kind: 'failed', message: `Couldn't link them: ${errorText(err)}.` };
    }
    if (one.kind === 'linked') {
      run.linked += 1;
      run.done.push(pair.key);
    } else if (one.kind === 'changed') run.changed += 1;
    else run.failed += 1;
    last = one.kind === 'linked' ? LINK_DONE : one.kind === 'changed' ? LINK_CHANGED : one.message;
  }
  return { ...run, message: pairs.length === 1 ? last : linkRunLine(run) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/fix-row.test.ts shared/audit-link.test.ts`
Expected: PASS — 32 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/fix-row.test.ts shared/audit-link.test.ts shared/fix-row.ts shared/audit-link.ts
git commit -m "Audits R2: Link — the pair Health offers, re-read and checked before the sync's linker, both rows written back if Wealthfolio refuses

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Remove for good — the second tap: skip first, then delete

Spec C2 and ruling Y3, pure. `removalOffered` (a story offers the action: a posted row from the bank feed, not one the sync manages, not half of a transfer as far as the story knows), `removalFingerprint` (what the confirm screen showed), and `removeForGood`: re-read the row; refuse, each in its own words and writing nothing, a row that changed since, half of a linked or maybe-linked transfer, a held transfer, a starting balance or a correction, a row not from the bank feed, a pending row; put the tx id on the skip list through the corrupt-safe edit, under every feed of the row's account; delete the row; when the delete fails, take back off the list exactly the keys this run added and say so; record `transaction-removed` with the full create payload. The last test runs the whole round trip on the fake host: remove, then the change log's Undo re-creates the exact row and takes it off the skip list.

**Files:**
- Create: `shared/tx-remove.ts`, `shared/tx-remove.test.ts`

**Interfaces:**
- Consumes: Task 2 (`transactionRemovedChange`; `runChangeUndo` in the round trip); Task 3 (`FixRow`, `LinkedState`, `recreateWrite`, `fixRowOf`); `editSkippedTransactions`, `withSkipped`, `withoutSkipped` (shared/skipped-transactions.ts); `signedCents`, `TxStoryFacts` (shared/tx-story.ts).
- Produces:

```ts
// shared/tx-remove.ts
export const REMOVE_ACTION: string; export const REMOVE_CONFIRM: string; export const REMOVE_BUTTON: string; export const REMOVE_CANCEL: string;
export const REMOVE_DONE: string; export const REMOVE_CHANGED: string; export const REMOVE_UNLINK_FIRST: string; export const REMOVE_MANAGED: string;
export const REMOVE_NOT_FEED: string; export const REMOVE_PENDING: string; export const REMOVE_SKIP_UNREADABLE: string; export const REMOVE_UNREACHABLE: string;
export const REMOVE_SKIP_NOTE: string; // 'Removed for good'
export interface ShownRow { activityId: string; note: string; absCents: number; date: string; activityType: string; accountName: string }
export const removalFingerprint: (r: ShownRow) => string; // 8 hex
export function removalOffered(facts: TxStoryFacts): boolean;
export interface RemoveIo {
  read(activityId: string): Promise<FixRow | null>;
  feeds(wfAccountId: string): Promise<string[]>;
  linked(row: FixRow, txKeys: string[]): Promise<LinkedState>;
  secrets: { get: SecretGet; set: SecretSet };
  remove(activityId: string): Promise<void>;
  record(draft: ChangeDraft): Promise<void>;
  log(msg: string): void;
}
export interface RemoveOutcome { ok: boolean; message: string }
export function removeForGood(activityId: string, fingerprint: string, io: RemoveIo, now: Date): Promise<RemoveOutcome>;
```

- [ ] **Step 1: Write the failing tests**

**Create `shared/tx-remove.test.ts`:**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stampChange, type ChangeDraft, type ChangeEntry } from './change-entries';
import type { ChangeLogItem } from './change-log';
import { runChangeUndo, type UndoIo } from './change-undo-run';
import { createFakeHost } from './fake-host';
import { fixRowOf, type FixRow } from './fix-row';
import { parseSkippedTransactionsStrict, SKIPPED_TRANSACTIONS_SECRET_KEY } from './skipped-transactions';
import type { HostActivity } from './sync-host';
import { accountTxKey } from './transfers';
import type { TxStoryFacts } from './tx-story';
import {
  removalFingerprint, removalOffered, removeForGood, REMOVE_CHANGED, REMOVE_DONE, REMOVE_MANAGED, REMOVE_NOT_FEED, REMOVE_PENDING,
  REMOVE_SKIP_NOTE, REMOVE_SKIP_UNREADABLE, REMOVE_UNLINK_FIRST, REMOVE_UNREACHABLE, type RemoveIo,
} from './tx-remove';

const NOW = new Date('2026-10-14T15:00:00Z');
const NOTE = 'MOBILE DEPOSIT · TRN-600';
const ROW: FixRow = {
  id: 'dup-1', accountId: 'wf-chk', accountName: 'PNC Checking', accountType: 'CASH', type: 'DEPOSIT', date: '2026-10-09',
  absCents: 60000, feeCents: 0, currency: 'USD', notes: NOTE, subtype: null, flowExternal: null, grouped: false,
};
const shown = (r: FixRow = ROW) => removalFingerprint({
  activityId: r.id, note: r.notes, absCents: r.absCents, date: r.date, activityType: r.type, accountName: r.accountName,
});
const FP = shown();
const KEY = accountTxKey('sfin-chk', 'TRN-600');

function fakeIo(over: Partial<RemoveIo> = {}, secrets: Record<string, string> = {}) {
  const data = new Map(Object.entries(secrets));
  const calls: string[] = [];
  const recorded: ChangeDraft[] = [];
  const io: RemoveIo = {
    read: vi.fn(async () => ROW),
    feeds: vi.fn(async () => ['sfin-chk']),
    linked: vi.fn(async () => false as const),
    secrets: {
      get: async (k) => data.get(k) ?? null,
      set: vi.fn(async (k: string, v: string) => { calls.push(`set ${k}`); data.set(k, v); }),
    },
    remove: vi.fn(async (id: string) => { calls.push(`remove ${id}`); }),
    record: vi.fn(async (d: ChangeDraft) => { recorded.push(d); }),
    log: vi.fn(),
    ...over,
  };
  const skipped = () => {
    const p = parseSkippedTransactionsStrict(data.get(SKIPPED_TRANSACTIONS_SECRET_KEY));
    return p.kind === 'ok' ? p.list : p.kind;
  };
  return { io, calls, recorded, skipped };
}

describe('removalOffered', () => {
  const facts = (over: Partial<TxStoryFacts> = {}, note = NOTE): TxStoryFacts => ({
    row: { activityId: 'dup-1', note, absCents: 60000, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking' },
    feed: { sfinAccountId: 'sfin-chk' }, partner: null, now: NOW, ...over,
  });

  it('offers it on a posted row from the bank feed that is not half of a transfer', () => {
    expect(removalOffered(facts())).toBe(true);
  });

  it.each([
    ['not from a feed', facts({ feed: null })],
    ['an unread mapping', facts({ failed: ['mapping'] })],
    ['an unread other half', facts({ failed: ['partner'] })],
    ['half of a transfer', facts({ partner: { accountName: 'Ally' } })],
    ['maybe half of a transfer', facts({ partner: undefined })],
    ['no tx id', facts({}, 'Typed by hand')],
    ['pending', facts({}, `${NOTE} · pending`)],
    ['a held transfer', facts({}, `↔️ In-transit transfer · ${NOTE}`)],
    ['a starting balance', facts({}, 'Starting balance · sfin-chk')],
    ['a correction', facts({}, 'Balance adjustment · sfin-chk · 2026-10-09')],
  ])('not on %s', (_why, f) => {
    expect(removalOffered(f)).toBe(false);
  });

  it('fingerprints what the story showed', () => {
    for (const over of [{ absCents: 1 }, { date: '2026-10-10' }, { type: 'WITHDRAWAL' }, { notes: 'X · TRN-600' }, { accountName: 'Other' }]) {
      expect(shown({ ...ROW, ...over })).not.toBe(FP);
    }
  });
});

describe('removeForGood', () => {
  it('skips first, then deletes, and records the row’s full create payload as yours', async () => {
    const f = fakeIo({}, { [SKIPPED_TRANSACTIONS_SECRET_KEY]: JSON.stringify([{ account: 'sfin-x', txId: 'KEEP' }]) });
    expect(await removeForGood('dup-1', FP, f.io, NOW)).toEqual({ ok: true, message: REMOVE_DONE });
    expect(f.calls).toEqual([`set ${SKIPPED_TRANSACTIONS_SECRET_KEY}`, 'remove dup-1']);
    expect(f.skipped()).toEqual([
      { account: 'sfin-x', txId: 'KEEP' }, { account: 'sfin-chk', txId: 'TRN-600', note: REMOVE_SKIP_NOTE, at: NOW.toISOString() },
    ]);
    expect(f.recorded).toEqual([expect.objectContaining({
      actor: 'you', kind: 'transaction-removed', undoable: true, summary: 'Removed MOBILE DEPOSIT for good',
      account: { sfinId: 'sfin-chk', wfId: 'wf-chk', name: 'PNC Checking' },
      subject: { txKeys: [KEY], activityIds: ['dup-1'], description: 'MOBILE DEPOSIT', amountCents: 60000, date: '2026-10-09' },
      before: {
        activityId: 'dup-1',
        activity: { accountId: 'wf-chk', activityType: 'DEPOSIT', activityDate: '2026-10-09', symbol: { symbol: '$CASH-USD' }, amount: 600, currency: 'USD', comment: NOTE },
      },
    })]);
  });

  it('skips the id under every feed that maps to the account', async () => {
    const f = fakeIo({ feeds: vi.fn(async () => ['sfin-chk', 'sfin-old']) });
    await removeForGood('dup-1', FP, f.io, NOW);
    expect(f.recorded[0].subject.txKeys).toEqual([KEY, accountTxKey('sfin-old', 'TRN-600')]);
    expect(f.skipped()).toHaveLength(2);
  });

  it.each([
    ['it changed since the story showed it', { read: vi.fn(async () => ({ ...ROW, absCents: 60100 })) }, REMOVE_CHANGED],
    ['it is gone', { read: vi.fn(async () => null) }, REMOVE_CHANGED],
    ['it is half of a linked transfer', { linked: vi.fn(async () => 'confirmed' as const) }, REMOVE_UNLINK_FIRST],
    ['it may be half of a linked transfer', { linked: vi.fn(async () => 'maybe' as const) }, REMOVE_UNLINK_FIRST],
    ['no feed maps to its account', { feeds: vi.fn(async () => []) }, REMOVE_NOT_FEED],
    ['Wealthfolio cannot be reached', { read: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) }, REMOVE_UNREACHABLE],
  ] as Array<[string, Partial<RemoveIo>, string]>)('writes nothing when %s', async (_why, over, message) => {
    const f = fakeIo(over);
    expect(await removeForGood('dup-1', FP, f.io, NOW)).toEqual({ ok: false, message });
    expect(f.calls).toEqual([]);
    expect(f.recorded).toEqual([]);
  });

  it.each([
    ['a held transfer', `↔️ In-transit transfer · ${NOTE}`, REMOVE_MANAGED],
    ['a starting balance', 'Starting balance · sfin-chk', REMOVE_MANAGED],
    ['a correction', 'Balance adjustment · sfin-chk · 2026-10-09', REMOVE_MANAGED],
    ['a row typed by hand', 'Typed by hand', REMOVE_NOT_FEED],
    ['a pending row', `${NOTE} · pending`, REMOVE_PENDING],
  ])('refuses %s', async (_why, notes, message) => {
    const row = { ...ROW, notes };
    const f = fakeIo({ read: vi.fn(async () => row) });
    expect(await removeForGood('dup-1', shown(row), f.io, NOW)).toEqual({ ok: false, message });
    expect(f.calls).toEqual([]);
  });

  it('deletes nothing when the skip list is corrupt', async () => {
    const f = fakeIo({}, { [SKIPPED_TRANSACTIONS_SECRET_KEY]: '{not json' });
    expect(await removeForGood('dup-1', FP, f.io, NOW)).toEqual({ ok: false, message: REMOVE_SKIP_UNREADABLE });
    expect(f.io.remove).not.toHaveBeenCalled();
    expect(f.skipped()).toBe('corrupt');
  });

  it('takes back off the skip list only what it added when the delete fails', async () => {
    const f = fakeIo({ remove: vi.fn(async () => { throw new Error('locked'); }), feeds: vi.fn(async () => ['sfin-chk', 'sfin-old']) },
      { [SKIPPED_TRANSACTIONS_SECRET_KEY]: JSON.stringify([{ account: 'sfin-old', txId: 'TRN-600', note: 'earlier' }]) });
    expect(await removeForGood('dup-1', FP, f.io, NOW)).toEqual({ ok: false, message: "Couldn't remove it (locked) — nothing was changed." });
    expect(f.skipped()).toEqual([{ account: 'sfin-old', txId: 'TRN-600', note: 'earlier' }]);
    expect(f.recorded).toEqual([]);
  });

  it('says so when it cannot take the key back off either', async () => {
    const f = fakeIo({ remove: vi.fn(async () => { throw new Error('locked'); }) });
    let writes = 0;
    f.io.secrets.set = vi.fn(async () => { writes += 1; if (writes > 1) throw new Error('disk'); });
    expect((await removeForGood('dup-1', FP, f.io, NOW)).message)
      .toBe("Couldn't remove it (locked), and it stays on the skip list — the bank feed won't import it again until it's taken off.");
  });

  it('never lets the log cost the removal', async () => {
    const f = fakeIo({ record: vi.fn(async () => { throw new Error('log down'); }) });
    expect(await removeForGood('dup-1', FP, f.io, NOW)).toEqual({ ok: true, message: REMOVE_DONE });
    expect(f.io.log).toHaveBeenCalledTimes(1);
  });
});

describe('remove, then Undo, on a host', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-creates the exact row and takes it off the skip list', async () => {
    const original: HostActivity = { id: 'dup-1', accountId: 'wf-chk', activityType: 'DEPOSIT', date: '2026-10-09', amount: 600, comment: NOTE, sourceGroupId: null };
    const fh = createFakeHost({ mapping: { 'sfin-chk': 'wf-chk' }, accountTypes: { 'wf-chk': 'CASH' }, existing: new Map([['wf-chk', [original]]]) });
    const data = new Map<string, string>();
    const log: ChangeEntry[] = [];
    const secrets = { get: async (k: string) => data.get(k) ?? null, set: async (k: string, v: string) => { data.set(k, v); } };
    const record = async (d: ChangeDraft) => { log.unshift(stampChange(d, 'addon', NOW)); };
    const io: RemoveIo = {
      read: async (id) => {
        const a = fh.activities.get('wf-chk')!.find((r) => r.id === id);
        return a ? fixRowOf({ ...a, currency: 'USD', accountName: 'PNC Checking' }, 'CASH') : null;
      },
      feeds: async () => ['sfin-chk'],
      linked: async () => false,
      secrets,
      remove: async (id) => { await fh.host.saveMany({ deleteIds: [id] }); },
      record,
      log: () => {},
    };
    expect((await removeForGood('dup-1', FP, io, NOW)).ok).toBe(true);
    expect(fh.activities.get('wf-chk')).toEqual([]);

    const undoIo: UndoIo = { host: fh.host, secrets, record, where: { host: 'addon', companionVersion: '1.61.0' } };
    const entry = log[0] as ChangeLogItem;
    expect(await runChangeUndo(entry, log, 'undo', undoIo, 'plain', NOW)).toMatchObject({ ok: true });
    const [back] = fh.activities.get('wf-chk')!;
    expect(back).toMatchObject({ accountId: 'wf-chk', activityType: 'DEPOSIT', date: '2026-10-09', amount: 600, comment: NOTE });
    expect(parseSkippedTransactionsStrict(data.get(SKIPPED_TRANSACTIONS_SECRET_KEY))).toEqual({ kind: 'ok', list: [] });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run shared/tx-remove.test.ts`
Expected: FAIL — `Failed to resolve import "./tx-remove"`; no tests run.

- [ ] **Step 3: Implement**

**Create `shared/tx-remove.ts`:**

```ts
/**
 * shared/tx-remove.ts
 *
 * "Remove for good…" on a transaction's story (2c R2, spec C2), for a row the
 * bank reported twice (live, 2026-10-09: PNC sent one $600 deposit in its old
 * and its new wording). Two taps: the first explains, the second removes.
 * Pure decisions and a host-neutral runner; each host lends its reads and
 * writes (companion/src/audit-fix-host.ts, src/utils/audit-fix.ts).
 *
 * Right before writing, the row is re-read, and nothing is written when it
 * changed since the story showed it, or it is: half of a linked transfer, or
 * may be (the add-on cannot always tell); a held transfer, a starting balance
 * or a correction (the sync manages those); not from the bank feed (no tx id,
 * or an account no feed maps to); or still pending — SimpleFin often gives a
 * pending transaction a new id when it posts (shared/reconcile.ts), so a
 * skipped pending id would not keep the posted copy out.
 *
 * Order (ruling Y3): the tx id goes on the skip list FIRST, through the
 * corrupt-safe edit, under every feed that maps to the row's account; then the
 * row is deleted. A delete that fails takes back off the list exactly the
 * keys this run added. The change entry keeps the row's full create payload:
 * Undo writes it back and takes the keys off the list, Redo removes it again
 * (shared/change-undo.ts). The log never costs the removal.
 */
import { isCorrectionNote, isPendingNote, isPlaceholderNote, isStartingBalanceNote } from './audit-ledger.js';
import { transactionRemovedChange, type ChangeDraft } from './change-entries.js';
import { recreateWrite, type FixRow, type LinkedState } from './fix-row.js';
import { findingHandle } from './handle.js';
import { editSkippedTransactions, withoutSkipped, withSkipped, type SkippedTransaction } from './skipped-transactions.js';
import type { SecretGet, SecretSet } from './subscription-prefs.js';
import { descriptionFromComment, txIdFromComment } from './sync-core.js';
import { accountTxKey } from './transfers.js';
import { signedCents, type TxStoryFacts } from './tx-story.js';

export const REMOVE_ACTION = 'Remove for good…';
export const REMOVE_CONFIRM = 'Deletes this row and stops the bank feed importing it again. Undo puts it back.';
export const REMOVE_BUTTON = 'Remove';
export const REMOVE_CANCEL = 'Cancel';
export const REMOVE_DONE = "Removed. The bank feed won't import it again — Undo in the change log puts it back.";
export const REMOVE_CHANGED = 'It has changed since — nothing was removed.';
export const REMOVE_UNLINK_FIRST = 'Unlink it first.';
export const REMOVE_MANAGED = "The sync manages this row (a held transfer, a starting balance or a correction), so it can't be removed here.";
export const REMOVE_NOT_FEED = 'Only a transaction from your bank feed can be removed here.';
export const REMOVE_PENDING = "It's still pending — remove it once it posts.";
export const REMOVE_SKIP_UNREADABLE = "Couldn't save the skip list — nothing was changed.";
export const REMOVE_UNREACHABLE = "Couldn't reach Wealthfolio — nothing was removed.";
/** The note a skip-list entry written by a removal carries. */
export const REMOVE_SKIP_NOTE = 'Removed for good';

/** What a story showed of its row (shared/tx-story.ts `TxStoryRow`). */
export interface ShownRow {
  activityId: string;
  note: string;
  absCents: number;
  date: string;
  activityType: string;
  accountName: string;
}

/** The row as the story showed it, as the Remove button carries it: 8 hex. */
export const removalFingerprint = (r: ShownRow): string =>
  findingHandle([r.activityId, r.accountName, r.absCents, r.date, r.activityType.toUpperCase(), r.note].join('\u001f'));

const shownOf = (row: FixRow): ShownRow => ({
  activityId: row.id, note: row.notes, absCents: row.absCents, date: row.date, activityType: row.type, accountName: row.accountName,
});

const isManaged = (note: string) => isPlaceholderNote(note) || isStartingBalanceNote(note) || isCorrectionNote(note);

/** Whether a story offers "Remove for good…": a posted row from the bank
 *  feed, not one the sync manages, and not half of a transfer as far as the
 *  story knows. The second tap checks everything again. */
export function removalOffered(facts: TxStoryFacts): boolean {
  const note = facts.row.note ?? '';
  const failed = new Set(facts.failed ?? []);
  if (!facts.feed || failed.has('mapping') || failed.has('partner')) return false;
  if (!txIdFromComment(note) || isPendingNote(note) || isManaged(note)) return false;
  return facts.partner === null;
}

/** What a host lends the runner. */
export interface RemoveIo {
  /** The row by id, now; null when gone. Rejects when unreachable. */
  read(activityId: string): Promise<FixRow | null>;
  /** The SimpleFin accounts that sync into this Wealthfolio account ([] when
   *  none). Rejects when the mapping cannot be read. */
  feeds(wfAccountId: string): Promise<string[]>;
  /** Whether the row is half of a linked transfer, as sure as the host can be. */
  linked(row: FixRow, txKeys: string[]): Promise<LinkedState>;
  secrets: { get: SecretGet; set: SecretSet };
  /** Deletes the row; rejects when Wealthfolio refuses. */
  remove(activityId: string): Promise<void>;
  /** Appends to the change log through the host's own writer. */
  record(draft: ChangeDraft): Promise<void>;
  log(msg: string): void;
}

export interface RemoveOutcome {
  ok: boolean;
  message: string;
}

const refuse = (message: string): RemoveOutcome => ({ ok: false, message });
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The second tap. `fingerprint` is `removalFingerprint` of the row as the confirm screen showed it. */
export async function removeForGood(activityId: string, fingerprint: string, io: RemoveIo, now: Date): Promise<RemoveOutcome> {
  let row: FixRow | null;
  let txId: string | null;
  let feeds: string[];
  try {
    row = await io.read(activityId);
    if (!row || removalFingerprint(shownOf(row)) !== fingerprint) return refuse(REMOVE_CHANGED);
    if (isManaged(row.notes)) return refuse(REMOVE_MANAGED);
    txId = txIdFromComment(row.notes);
    feeds = txId ? await io.feeds(row.accountId) : [];
    if (!txId || feeds.length === 0) return refuse(REMOVE_NOT_FEED);
    if (isPendingNote(row.notes)) return refuse(REMOVE_PENDING);
    if (await io.linked(row, feeds.map((f) => accountTxKey(f, txId!)))) return refuse(REMOVE_UNLINK_FIRST);
  } catch (err) {
    io.log(`Remove ${activityId}: ${errorText(err)}`);
    return refuse(REMOVE_UNREACHABLE);
  }
  const id = txId;
  const keys = feeds.map((f) => accountTxKey(f, id));

  // 1. The skip list first. Only what this run adds is ever taken back.
  let added: SkippedTransaction[] = [];
  try {
    await editSkippedTransactions(io.secrets.get, io.secrets.set, (list) => {
      added = feeds
        .filter((f) => !list.some((s) => s.account === f && s.txId === id))
        .map((f) => ({ account: f, txId: id, note: REMOVE_SKIP_NOTE, at: now.toISOString() }));
      return added.reduce(withSkipped, list);
    });
  } catch (err) {
    io.log(`Remove ${activityId}: the skip list was not saved: ${errorText(err)}`);
    return refuse(REMOVE_SKIP_UNREADABLE);
  }

  // 2. Then the row.
  try {
    await io.remove(row.id);
  } catch (err) {
    const why = errorText(err);
    io.log(`Remove ${activityId}: the delete failed: ${why}`);
    try {
      if (added.length > 0) {
        await editSkippedTransactions(io.secrets.get, io.secrets.set, (list) => added.reduce((l, s) => withoutSkipped(l, s.account, s.txId), list));
      }
    } catch (again) {
      io.log(`Remove ${activityId}: taking it back off the skip list failed: ${errorText(again)}`);
      return refuse(`Couldn't remove it (${why}), and it stays on the skip list — the bank feed won't import it again until it's taken off.`);
    }
    return refuse(`Couldn't remove it (${why}) — nothing was changed.`);
  }

  // 3. The change log, which never costs the removal.
  try {
    await io.record(transactionRemovedChange({
      account: { sfinId: feeds[0], wfId: row.accountId, name: row.accountName },
      txKeys: keys,
      activityId: row.id,
      description: descriptionFromComment(row.notes),
      amountCents: signedCents({ absCents: row.absCents, activityType: row.type, accountType: row.accountType }),
      date: row.date,
      payload: { ...recreateWrite(row) },
    }));
  } catch (err) {
    io.log(`Remove ${activityId}: removed, but the change log was not written: ${errorText(err)}`);
  }
  return { ok: true, message: REMOVE_DONE };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run shared/tx-remove.test.ts`
Expected: PASS — 30 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add shared/tx-remove.test.ts shared/tx-remove.ts
git commit -m "Audits R2: Remove for good — skip first, then delete, the skip taken back if the delete fails, logged with the row's payload

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The companion's hosts for both fixes

Y1a, Y2 and Y3 on the companion. Rows are re-read live over REST by exact id (`activityIdFilter`, as `/why` reads a story's row), with their accounts' types; each carries its group, so on the companion a row is linked or not — never "maybe". Writes go through `RestSyncHost`, whose `linkPair` is `linkPairByRecreate`; entries land in the companion's bucket of the change log through `recordCompanionChanges`. A row's feeds come from `account_mapping`, the overrides from `loadSyncOverrides`.

**Files:**
- Create: `companion/src/audit-fix-host.ts`, `companion/src/audit-fix-host.test.ts`

**Interfaces:**
- Consumes: Task 3 (`LinkIo`, `LinkPair`, `ReadRow`, `FixRow`, `fixRowOf`, `linkedState`); Task 4 (`RemoveIo`); `RestSyncHost` (companion/src/rest-host.ts); `recordCompanionChanges`, `SecretClient` (companion/src/change-log-host.ts); `sfinIdsFor` (shared/tx-story.ts).
- Produces:

```ts
// companion/src/audit-fix-host.ts
export type FixClient = SecretClient & Pick<WealthfolioClient, 'searchActivities' | 'getAccounts' | 'saveMany'>;
export function companionLinkIo(client: FixClient, log: (msg: string) => void): LinkIo;
export function companionRemoveIo(client: FixClient, log: (msg: string) => void): RemoveIo;
```

- [ ] **Step 1: Write the failing tests**

**Create `companion/src/audit-fix-host.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import type { HealthLeg } from '../../shared/audit-health.js';
import { linkPairs, LINK_CHANGED, LINK_DONE, type LinkPair } from '../../shared/audit-link.js';
import type { ChangeBucket } from '../../shared/change-log.js';
import { SKIPPED_TRANSACTIONS_SECRET_KEY } from '../../shared/skipped-transactions.js';
import { accountTxKey } from '../../shared/transfers.js';
import { removalFingerprint, removeForGood, REMOVE_DONE, REMOVE_UNLINK_FIRST } from '../../shared/tx-remove.js';
import { companionLinkIo, companionRemoveIo, type FixClient } from './audit-fix-host.js';

const NOW = new Date('2026-10-14T15:00:00Z');

type Row = Record<string, unknown> & { id: string; accountId: string };

/** Wealthfolio over REST, in memory: the exact-id search, accounts, the bulk endpoint and the add-on's secrets. */
function fakeClient(rows: Row[], secrets: Record<string, string> = {}) {
  const data = new Map(Object.entries(secrets));
  const saved: Array<Record<string, any>> = [];
  let next = 0;
  const client = {
    getAddonSecret: vi.fn(async (_addon: string, k: string) => data.get(k) ?? null),
    setAddonSecret: vi.fn(async (_addon: string, k: string, v: string) => { data.set(k, v); }),
    getAccounts: vi.fn(async () => [{ id: 'wf-chk', accountType: 'CASH' }, { id: 'wf-card', accountType: 'CREDIT_CARD' }]),
    searchActivities: vi.fn(async (b: { activityIdFilter?: string[] }) => rows.filter((r) => b.activityIdFilter?.includes(r.id)) as any),
    saveMany: vi.fn(async (req: Record<string, any>) => {
      saved.push(req);
      for (const id of req.deleteIds ?? []) rows.splice(rows.findIndex((r) => r.id === id), 1);
      const created = (req.creates ?? []).map((w: Record<string, any>) => {
        next += 1;
        const r: Row = {
          id: `new-${next}`, accountId: w.accountId, activityType: w.activityType, date: `${w.activityDate}T00:00:00+00:00`,
          amount: String(w.amount), currency: w.currency, comment: w.comment, sourceGroupId: w.sourceGroupId ?? null, metadata: w.metadata ?? null,
        };
        rows.push(r);
        return r;
      });
      return { created, updated: [], errors: [] };
    }),
  };
  /** The companion's bucket of the change log, whatever month the clock says. */
  const logged = () => [...data].filter(([k, v]) => k.startsWith('change_log:companion:') && v).flatMap(([, v]) => (JSON.parse(v) as ChangeBucket).entries);
  return { client: client as unknown as FixClient & typeof client, data, rows, saved, logged };
}

const detail = (over: Row): Row => ({
  activityType: 'WITHDRAWAL', date: '2026-10-08T00:00:00+00:00', amount: '464.60', currency: 'USD', sourceGroupId: null, metadata: null,
  accountName: 'PNC Checking', ...over,
});
const OUT = detail({ id: 'out-1', accountId: 'wf-chk', comment: 'CITI AUTOPAY · TRN-1' });
const INTO = detail({ id: 'in-1', accountId: 'wf-card', activityType: 'TRANSFER_IN', accountName: 'Citi Card', comment: 'PAYMENT THANK YOU · TRN-2' });
const leg = (r: Row, txKey: string): HealthLeg => ({
  activityId: r.id, accountId: r.accountId, accountName: String(r.accountName), txKey, date: '2026-10-08', absCents: 46460,
  type: String(r.activityType), currency: 'USD', description: String(r.comment).split(' · ')[0],
});
/** Health's view: the card's payment is the leg, the checking withdrawal its other half. */
const PAIR: LinkPair = { key: 'leg:in-1', leg: leg(INTO, accountTxKey('sfin-card', 'TRN-2')), counterpart: leg(OUT, accountTxKey('sfin-chk', 'TRN-1')) };

describe('Link on the companion', () => {
  it('re-reads both rows live, links them through the sync’s linker, and logs it as yours in Telegram', async () => {
    const f = fakeClient([{ ...OUT }, { ...INTO }]);
    const log = vi.fn();
    expect((await linkPairs([PAIR], companionLinkIo(f.client, log))).message).toBe(LINK_DONE);
    expect(f.client.searchActivities).toHaveBeenCalledWith({ page: 0, pageSize: 1, activityIdFilter: ['in-1'] });
    expect(f.saved[0].deleteIds).toEqual(['out-1', 'in-1']);
    const creates = f.saved[1].creates as Array<Record<string, unknown>>;
    expect(creates.map((w) => [w.accountId, w.activityType, w.comment])).toEqual([
      ['wf-chk', 'TRANSFER_OUT', 'CITI AUTOPAY · TRN-1'], ['wf-card', 'TRANSFER_IN', 'PAYMENT THANK YOU · TRN-2'],
    ]);
    expect(creates[0].sourceGroupId).toBe(creates[1].sourceGroupId);
    expect(f.logged()).toEqual([expect.objectContaining({
      writer: 'companion', actor: 'you', kind: 'transfer-link', subject: expect.objectContaining({ activityIds: ['new-1', 'new-2'] }),
    })]);
    expect(log).not.toHaveBeenCalled();
  });

  it('reads a grouped row as linked, and writes nothing', async () => {
    const f = fakeClient([{ ...OUT, sourceGroupId: 'wf-transfer-x' }, { ...INTO }]);
    expect((await linkPairs([PAIR], companionLinkIo(f.client, vi.fn()))).message).toBe(LINK_CHANGED);
    expect(f.saved).toEqual([]);
  });
});

describe('Remove for good on the companion', () => {
  const DUP = detail({ id: 'dup-1', accountId: 'wf-chk', activityType: 'DEPOSIT', amount: '600', date: '2026-10-09T00:00:00+00:00', comment: 'MOBILE DEPOSIT · TRN-600' });
  const FP = removalFingerprint({ activityId: 'dup-1', note: 'MOBILE DEPOSIT · TRN-600', absCents: 60000, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking' });
  const mapping = { account_mapping: JSON.stringify({ 'sfin-chk': 'wf-chk' }) };

  it('skips it under its feed, deletes it over REST, and logs the removal as yours', async () => {
    const f = fakeClient([{ ...DUP }], mapping);
    expect(await removeForGood('dup-1', FP, companionRemoveIo(f.client, vi.fn()), NOW)).toEqual({ ok: true, message: REMOVE_DONE });
    expect(JSON.parse(f.data.get(SKIPPED_TRANSACTIONS_SECRET_KEY)!)).toEqual([
      { account: 'sfin-chk', txId: 'TRN-600', note: 'Removed for good', at: NOW.toISOString() },
    ]);
    expect(f.saved).toEqual([{ deleteIds: ['dup-1'] }]);
    expect(f.rows).toEqual([]);
    expect(f.logged()).toEqual([expect.objectContaining({ writer: 'companion', actor: 'you', kind: 'transaction-removed' })]);
  });

  it('refuses a grouped row', async () => {
    const f = fakeClient([{ ...DUP, sourceGroupId: 'wf-transfer-x' }], mapping);
    expect(await removeForGood('dup-1', FP, companionRemoveIo(f.client, vi.fn()), NOW)).toEqual({ ok: false, message: REMOVE_UNLINK_FIRST });
    expect(f.saved).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd companion && npx vitest run src/audit-fix-host.test.ts`
Expected: FAIL — `Cannot find module './audit-fix-host.js'`; no tests run.

- [ ] **Step 3: Implement**

**Create `companion/src/audit-fix-host.ts`:**

```ts
/**
 * companion/src/audit-fix-host.ts
 *
 * The companion's half of the fixes (2c R2, spec C): what Link
 * (shared/audit-link.ts) and Remove for good (shared/tx-remove.ts) read and
 * write, bound to one Wealthfolio client. Rows are re-read live over REST by
 * exact id (`activityIdFilter`); each carries its group, so on the companion
 * a row is linked or not — never "maybe". Writes go through `RestSyncHost`,
 * whose `linkPair` is the sync's own `linkPairByRecreate`, and entries land
 * in the companion's bucket of the change log through its one writer.
 */
import type { LinkIo, LinkPair, ReadRow } from '../../shared/audit-link.js';
import { fixRowOf, linkedState, type FixRow } from '../../shared/fix-row.js';
import { loadSyncOverrides } from '../../shared/sync-overrides.js';
import type { RemoveIo } from '../../shared/tx-remove.js';
import { sfinIdsFor } from '../../shared/tx-story.js';
import { recordCompanionChanges, type SecretClient } from './change-log-host.js';
import { RestSyncHost } from './rest-host.js';
import type { WealthfolioClient } from './wealthfolio.js';

const ADDON_ID = 'simplefin-sync';

/** What the fixes need of a `WealthfolioClient`. */
export type FixClient = SecretClient & Pick<WealthfolioClient, 'searchActivities' | 'getAccounts' | 'saveMany'>;

const accountTypes = async (client: FixClient) =>
  new Map((await client.getAccounts()).map((a) => [a.id, String(a.accountType ?? '')]));

/** One row by id, as the fixes read it; null when it is gone. */
async function readFixRow(client: FixClient, activityId: string, types: Map<string, string>): Promise<FixRow | null> {
  const items = await client.searchActivities({ page: 0, pageSize: 1, activityIdFilter: [activityId] });
  const hit = items.find((a) => a.id === activityId);
  return hit ? fixRowOf(hit, types.get(hit.accountId) ?? '') : null;
}

const restHost = (client: FixClient) => new RestSyncHost(client as unknown as WealthfolioClient);

export function companionLinkIo(client: FixClient, log: (msg: string) => void): LinkIo {
  const host = restHost(client);
  return {
    read: async (pair: LinkPair) => {
      const types = await accountTypes(client);
      const one = async (activityId: string): Promise<ReadRow | null> => {
        const row = await readFixRow(client, activityId, types);
        return row ? { row, linked: linkedState(row, { readsGroups: true, ledgerKnows: false }) } : null;
      };
      return [await one(pair.leg.activityId), await one(pair.counterpart.activityId)];
    },
    overrides: () => loadSyncOverrides((k) => client.getAddonSecret(ADDON_ID, k)),
    link: (legs) => host.linkPair(legs),
    restore: (writes) => host.saveMany({ creates: writes }),
    record: (draft) => recordCompanionChanges(client, [draft]),
    log,
  };
}

export function companionRemoveIo(client: FixClient, log: (msg: string) => void): RemoveIo {
  const host = restHost(client);
  return {
    read: async (activityId) => readFixRow(client, activityId, await accountTypes(client)),
    feeds: async (wfAccountId) => {
      const raw = await client.getAddonSecret(ADDON_ID, 'account_mapping');
      return sfinIdsFor(raw ? (JSON.parse(raw) as Record<string, string>) : {}, wfAccountId);
    },
    linked: async (row) => linkedState(row, { readsGroups: true, ledgerKnows: false }),
    secrets: {
      get: (k) => client.getAddonSecret(ADDON_ID, k),
      set: (k, v) => client.setAddonSecret(ADDON_ID, k, v),
    },
    remove: async (activityId) => {
      const res = await host.saveMany({ deleteIds: [activityId] });
      if (res.errors.length > 0) throw new Error(res.errors.map((e) => e.message).join('; '));
    },
    record: (draft) => recordCompanionChanges(client, [draft]),
    log,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd companion && npx vitest run src/audit-fix-host.test.ts`
Expected: PASS — 4 tests.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add companion/src/audit-fix-host.test.ts companion/src/audit-fix-host.ts
git commit -m "Audits R2: the companion re-reads both fixes' rows live over REST and writes through the sync's host

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `/audit` → Health: Link and Link all, in place

Spec C1 in Telegram (Y2, Y5). With `link` in the deps — `buildAuditMenu` wires `linkPairs` over `companionLinkIo` — the Health list shows "Likely the other half: …" under each leg it offers to link (the list is the preview), a "Link N" button per pair and "Link all N" for two or more; an issue's own screen gets "Link". A tap re-reads Health and links only the pair — or, for Link all, the very set of pairs — whose legs still read exactly as the button carried them; otherwise it says "It has changed since — nothing was linked." and writes nothing. Either way the screen re-reads: Health again, with the result on top. Without `link` every screen is as R1 drew it, so R1's tests stand unchanged; the index test drives a real tap through the listener's deps over a fake REST client.

**Files:**
- Modify: `companion/src/audit-menu.ts`, `companion/src/index.ts`, `companion/src/index.test.ts`
- Create: `companion/src/audit-menu-link.test.ts`

**Interfaces:**
- Consumes: Task 3 (`linkablePair`, `linkablePairs`, `pairHandle`, `pairsHandle`, `linkAllButton`, `LINK_BUTTON`, `LINK_CHANGED`, `linkPairs`, `LinkPair`, `LinkRun`); Task 5 (`companionLinkIo`); `healthLegLine` (shared/audit-health.ts).
- Produces:

```ts
// companion/src/audit-menu.ts
export type AuditView = /* … */ | { kind: 'link'; handle: string /* pairHandle */ } | { kind: 'link-all'; handle: string /* pairsHandle */ };
export interface HealthScreenOptions { link?: boolean; result?: string }
export function renderAuditHealth(report: HealthReport, opts?: HealthScreenOptions): MenuScreen;
export function renderAuditIssue(raw: HealthIssue, opts?: HealthScreenOptions): MenuScreen;
// AuditMenuDeps gains: link?(pairs: LinkPair[]): Promise<LinkRun>;
```

- [ ] **Step 1: Write the failing tests**

**Create `companion/src/audit-menu-link.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { healthIssues, type HealthReport } from '../../shared/audit-health.js';
import type { AuditLedgerRow } from '../../shared/audit-ledger.js';
import { linkablePairs, pairHandle, pairsHandle, LINK_CHANGED, type LinkPair, type LinkRun } from '../../shared/audit-link.js';
import { escapeMarkdown } from '../../shared/telegram.js';
import {
  auditData, createAuditMenu, parseAuditData, renderAuditHealth, renderAuditIssue, type AuditMenuDeps, type MenuScreen,
} from './audit-menu.js';

const BANK = 'SQ *COFFEE_CLUB [2]';
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const allData = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
const labels = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.text);
const button = (s: MenuScreen, text: string) => s.keyboard.inline_keyboard.flat().find((b) => b.text === text)!.callback_data;

const row = (over: Partial<AuditLedgerRow>): AuditLedgerRow => ({
  id: 'r', accountId: 'wf-chk', date: '2026-10-04', currency: 'USD', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', status: 'POSTED',
  absCents: 0, group: '', assetId: '', external: false, phantomCash: false, notes: 'ROW · TRN-0', ...over,
});
const ACCOUNTS = [{ id: 'wf-chk', name: 'PNC Checking', type: 'CASH', archived: false }, { id: 'wf-ally', name: 'Ally', type: 'CASH', archived: false }];
const MAPPING = { 'sfin-chk': 'wf-chk', 'sfin-ally': 'wf-ally' };
/** Two transfers out of checking, each with one likely other half in Ally, and one with none. */
function ledgerRows(outADate = '2026-10-04'): AuditLedgerRow[] {
  return [
    row({ id: 'outA', absCents: 60000, date: outADate, notes: `${BANK} · TRN-1` }),
    row({ id: 'inA', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', absCents: 60000, date: '2026-10-05', notes: 'FROM PNC · TRN-2' }),
    row({ id: 'outB', absCents: 2500, date: '2026-10-06', notes: 'ZELLE TO SAVINGS · TRN-3' }),
    row({ id: 'inB', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', absCents: 2500, date: '2026-10-06', notes: 'ZELLE FROM PNC · TRN-4' }),
    row({ id: 'lone', absCents: 777, date: '2026-10-07', notes: 'TO SOMEWHERE · TRN-5' }),
  ];
}
const report = (outADate?: string): HealthReport & { reached: boolean } => ({
  ...healthIssues({ ledger: { accounts: ACCOUNTS, rows: ledgerRows(outADate) }, mapping: MAPPING }), reached: true,
});

function deps(over: Partial<AuditMenuDeps> = {}): AuditMenuDeps & { link: ReturnType<typeof vi.fn> } {
  const link = vi.fn(async (pairs: LinkPair[]): Promise<LinkRun> => ({
    total: pairs.length, linked: pairs.length, changed: 0, failed: 0, done: pairs.map((p) => p.key),
    message: pairs.length === 1 ? 'Linked.' : `Linked all ${pairs.length}.`,
  }));
  return {
    balances: vi.fn(),
    headline: vi.fn(),
    health: vi.fn(async () => report()),
    link,
    now: () => new Date(2026, 9, 14, 12, 0),
    log: vi.fn(),
    ...over,
  } as AuditMenuDeps & { link: ReturnType<typeof vi.fn> };
}
const ui = () => ({ edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) });
const edited = (u: ReturnType<typeof ui>) => u.edit.mock.calls.at(-1) as unknown as [string, MenuScreen['keyboard']];

describe('Link on the Health list', () => {
  it('shows each leg’s likely other half under it, a Link per pair and Link all, and Back last', () => {
    const screen = renderAuditHealth(report(), { link: true });
    expect(screen.text).toContain(`1. ${escapeMarkdown(`${BANK} · $600.00 · PNC Checking · Oct 4`)}`);
    expect(screen.text).toContain(`   ${escapeMarkdown('Likely the other half: FROM PNC · $600.00 · Ally · Oct 5')}`);
    expect(labels(screen)).toEqual(['1', '2', '3', 'Link 1', 'Link 2', 'Link all 2', '⬅️ Back']);
    const pairs = linkablePairs(report().issues);
    expect(allData(screen).slice(3, 6)).toEqual([
      auditData({ kind: 'link', handle: pairHandle(pairs[0]) }), auditData({ kind: 'link', handle: pairHandle(pairs[1]) }),
      auditData({ kind: 'link-all', handle: pairsHandle(pairs) }),
    ]);
  });

  it('keeps every button within 64 bytes — the longest is 23', () => {
    const r = report();
    const data = [...allData(renderAuditHealth(r, { link: true })), ...allData(renderAuditIssue(r.issues![0], { link: true }))];
    expect(data.every((d) => bytes(d) <= 64)).toBe(true);
    expect(Math.max(...data.map(bytes))).toBe(23);
    for (const d of data) expect(auditData(parseAuditData(d)!)).toBe(d);
  });

  it('offers no Link without a linker, and none on a leg with no single other half', () => {
    expect(labels(renderAuditHealth(report()))).toEqual(['1', '2', '3', '⬅️ Back']);
    const r = report();
    expect(labels(renderAuditIssue(r.issues![2], { link: true }))).toEqual(['⬅️ Back']);
    expect(labels(renderAuditIssue(r.issues![0], { link: true }))).toEqual(['Link', '⬅️ Back']);
  });

  it('a Link tap re-reads Health, links that one pair, and shows the list again with the result', async () => {
    const d = deps();
    const menu = createAuditMenu(d);
    const u = ui();
    await menu.onCallback({ data: 'cz:au:i' }, u);
    await menu.onCallback({ data: button({ text: '', keyboard: edited(u)[1] }, 'Link 1') }, u);
    expect(d.link).toHaveBeenCalledWith([linkablePairs(report().issues)[0]]);
    expect(d.health).toHaveBeenCalledTimes(3);
    const [text] = edited(u);
    expect(text.startsWith('🔎 *Health*\nLinked.\n1. ')).toBe(true);
  });

  it('links nothing when a leg changed between the list and the tap', async () => {
    const d = deps();
    const menu = createAuditMenu(d);
    const u = ui();
    await menu.onCallback({ data: 'cz:au:i' }, u);
    const tap = button({ text: '', keyboard: edited(u)[1] }, 'Link 1');
    d.health = vi.fn(async () => report('2026-10-03'));
    await menu.onCallback({ data: tap }, u);
    expect(d.link).not.toHaveBeenCalled();
    expect(edited(u)[0]).toContain(`🔎 *Health*\n${escapeMarkdown(LINK_CHANGED)}\n`);
  });

  it('Link all links every pair the list showed — and nothing when the list has changed since', async () => {
    const d = deps();
    const menu = createAuditMenu(d);
    const u = ui();
    await menu.onCallback({ data: 'cz:au:i' }, u);
    const all = button({ text: '', keyboard: edited(u)[1] }, 'Link all 2');
    await menu.onCallback({ data: all }, u);
    expect(d.link).toHaveBeenCalledWith(linkablePairs(report().issues));
    expect(edited(u)[0].startsWith('🔎 *Health*\nLinked all 2.\n')).toBe(true);
    const later = deps({ health: vi.fn(async () => report('2026-10-03')) });
    const v = ui();
    await createAuditMenu(later).onCallback({ data: all }, v);
    expect(later.link).not.toHaveBeenCalled();
    expect(edited(v)[0]).toContain(escapeMarkdown(LINK_CHANGED));
  });

  it('answers a Link tap quietly when the menu cannot link', async () => {
    const d = deps({ link: undefined });
    const u = ui();
    await createAuditMenu(d).onCallback({ data: `cz:au:l${'0'.repeat(16)}` }, u);
    expect(u.answer).toHaveBeenCalledWith();
    expect(u.edit).not.toHaveBeenCalled();
  });
});
```

Edit 1 of 1 in `companion/src/index.test.ts` — replace:

```ts
      // This fake client has no valuations: Wealthfolio's figure is unknown, and the reply says why.
      expect(text).toContain("⚠️ Couldn't read Wealthfolio's balances, so cash accounts aren't compared.");
    });
  });
```

with:

```ts
      // This fake client has no valuations: Wealthfolio's figure is unknown, and the reply says why.
      expect(text).toContain("⚠️ Couldn't read Wealthfolio's balances, so cash accounts aren't compared.");
    });

    it('Link on the Health list re-reads both rows over REST and links them through the sync’s linker', async () => {
      const { getNativeAuditLedger } = await import('./sqlite-audit.js');
      const leg = (over: Record<string, unknown>) => ({
        accountId: 'wf-1', date: '2026-10-04', currency: 'USD', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', status: 'POSTED', absCents: 60000,
        group: '', assetId: '', external: false, phantomCash: false, notes: 'TRANSFER TO SAVE · TRN-1', ...over,
      });
      const ledger = {
        accounts: [{ id: 'wf-1', name: 'Checking', type: 'CASH', archived: false }, { id: 'wf-2', name: 'Save', type: 'CASH', archived: false }],
        rows: [leg({ id: 'out-1' }), leg({ id: 'in-1', accountId: 'wf-2', rawType: 'DEPOSIT', type: 'DEPOSIT', date: '2026-10-05', notes: 'FROM CHECKING · TRN-2' })],
      };
      // The list's read and the tap's read see the pair; the read after the link sees it gone.
      vi.mocked(getNativeAuditLedger).mockReturnValueOnce(ledger as any).mockReturnValueOnce(ledger as any);
      const { client } = clientFor([['account_mapping', JSON.stringify({ 'sfin-1': 'wf-1', 'sfin-2': 'wf-2' })]]);
      const stored = [
        { id: 'out-1', accountId: 'wf-1', activityType: 'TRANSFER_OUT', date: '2026-10-04T00:00:00+00:00', amount: '600', currency: 'USD', comment: 'TRANSFER TO SAVE · TRN-1', sourceGroupId: null, metadata: null },
        { id: 'in-1', accountId: 'wf-2', activityType: 'DEPOSIT', date: '2026-10-05T00:00:00+00:00', amount: '600', currency: 'USD', comment: 'FROM CHECKING · TRN-2', sourceGroupId: null, metadata: null },
      ];
      client.getAccounts = vi.fn(async () => [{ id: 'wf-1', accountType: 'CASH' }, { id: 'wf-2', accountType: 'CASH' }]);
      client.searchActivities = vi.fn(async (b: { activityIdFilter?: string[] }) => stored.filter((r) => b.activityIdFilter?.includes(r.id)));
      client.saveMany = vi.fn(async (req: { creates?: Array<Record<string, unknown>> }) => ({
        created: (req.creates ?? []).map((w, i) => ({ id: `new-${i}`, accountId: w.accountId, comment: w.comment, sourceGroupId: w.sourceGroupId })),
        updated: [], errors: [],
      }));
      const deps = buildTelegramListenerDeps(client);
      const u = ui();
      await deps.onMenuCallback!({ data: 'cz:au:i', chatId: 1, messageId: 2 }, u);
      const [, kb] = u.edit.mock.calls[0] as unknown as [string, { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }];
      const link = kb.inline_keyboard.flat().find((b) => b.text === 'Link 1')!.callback_data;
      await deps.onMenuCallback!({ data: link, chatId: 1, messageId: 2 }, u);
      expect(client.searchActivities).toHaveBeenCalledWith({ page: 0, pageSize: 1, activityIdFilter: ['out-1'] });
      expect(client.saveMany.mock.calls[0][0]).toMatchObject({ deleteIds: ['out-1', 'in-1'] });
      expect((client.saveMany.mock.calls[1][0] as { creates: Array<Record<string, unknown>> }).creates.map((w) => w.activityType)).toEqual(['TRANSFER_OUT', 'TRANSFER_IN']);
      expect((u.edit.mock.calls[1] as unknown as [string])[0].startsWith('🔎 *Health*\nLinked.\n')).toBe(true);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd companion && npx vitest run src/audit-menu-link.test.ts`
Expected: FAIL — 6 of the 7 tests (no preview line, no Link buttons, the longest button is 15); `answers a Link tap quietly when the menu cannot link` already passes — an unknown `cz:au:` tap is already answered quietly.

Run: `cd companion && npx vitest run src/index.test.ts -t "Link on the Health list"`
Expected: FAIL — 1 test (the list has no "Link 1" button).

- [ ] **Step 3: Implement**

Edit 1 of 8 in `companion/src/audit-menu.ts` — replace:

```ts
 *   i              what Health flags, in place
 *   x<handle>      one issue, in place, Back to Health
 * `<handle>` is `findingHandle` of the account's Wealthfolio id, of
 * `reason:<kind>`, or of the issue's key — 8 hex, so the longest button is
 * 15 bytes. Nothing else may start with `cz:au`.
```

with:

```ts
 *   i              what Health flags, in place
 *   x<handle>      one issue, in place, Back to Health
 *   l<pair>        R2: link one pair, then Health again, in place
 *   L<handle>      R2: link every pair the Health list showed, then Health again
 * `<handle>` is `findingHandle` of the account's Wealthfolio id, of
 * `reason:<kind>`, of the issue's key, or of every pair a list showed — 8
 * hex; `<pair>` is both legs' fingerprints (shared/audit-link.ts), 16 hex, so
 * the longest button is 23 bytes. Nothing else may start with `cz:au`.
 *
 * Link (2c R2) appears only when the deps can link (`link`): on the Health
 * list, under each leg with one likely other half, that half, a "Link N" per
 * pair and "Link all N" for two or more; on the issue's own screen, "Link".
 * The list is the preview: a tap re-reads Health and links only a pair whose
 * legs still read exactly as the button carried them.
```

Edit 2 of 8 in `companion/src/audit-menu.ts` — replace:

```ts
import {
  healthCount, healthIssueLines, healthIssues, healthIssueTitle, HEALTH_NONE, type HealthIssue, type HealthLeg,
  type HealthReport,
} from '../../shared/audit-health.js';
```

with:

```ts
import {
  healthCount, healthIssueLines, healthIssues, healthIssueTitle, healthLegLine, HEALTH_NONE, type HealthIssue, type HealthLeg,
  type HealthReport,
} from '../../shared/audit-health.js';
import {
  linkablePair, linkablePairs, linkAllButton, pairHandle, pairsHandle, LINK_BUTTON, LINK_CHANGED, type LinkPair, type LinkRun,
} from '../../shared/audit-link.js';
```

Edit 3 of 8 in `companion/src/audit-menu.ts` — replace:

```ts
  | { kind: 'health' }
  | { kind: 'issue'; handle: string };
```

with:

```ts
  | { kind: 'health' }
  | { kind: 'issue'; handle: string }
  /** `handle`: `pairHandle`, 16 hex. */
  | { kind: 'link'; handle: string }
  /** `handle`: `pairsHandle` of every pair the list showed. */
  | { kind: 'link-all'; handle: string };
```

Edit 4 of 8 in `companion/src/audit-menu.ts` — replace:

```ts
    case 'issue': return `${AUDIT_CALLBACK_PREFIX}x${view.handle}`;
  }
}
```

with:

```ts
    case 'issue': return `${AUDIT_CALLBACK_PREFIX}x${view.handle}`;
    case 'link': return `${AUDIT_CALLBACK_PREFIX}l${view.handle}`;
    case 'link-all': return `${AUDIT_CALLBACK_PREFIX}L${view.handle}`;
  }
}
```

Edit 5 of 8 in `companion/src/audit-menu.ts` — replace:

```ts
  if (s === 'i') return { kind: 'health' };
  const m = /^([asrx])([0-9a-f]{8})$/.exec(s);
```

with:

```ts
  if (s === 'i') return { kind: 'health' };
  const link = /^l([0-9a-f]{16})$/.exec(s);
  if (link) return { kind: 'link', handle: link[1] };
  const all = /^L([0-9a-f]{8})$/.exec(s);
  if (all) return { kind: 'link-all', handle: all[1] };
  const m = /^([asrx])([0-9a-f]{8})$/.exec(s);
```

Edit 6 of 8 in `companion/src/audit-menu.ts` — replace:

```ts
export function renderAuditHealth(report: HealthReport): MenuScreen {
  const lines = ['🔎 *Health*'];
  const numbers: Button[] = [];
  if (report.issues && report.issues.length === 0 && !report.more) lines.push(escapeMarkdown(HEALTH_NONE));
  if (report.issues) {
    const { shown, hidden } = listed(report.issues, report.more);
    shown.forEach((issue, i) => {
      lines.push(`${i + 1}. ${escapeMarkdown(healthIssueTitle(clipIssue(issue)))}`);
      numbers.push({ text: String(i + 1), callback_data: auditData({ kind: 'issue', handle: issueHandle(issue) }) });
    });
    if (hidden > 0) lines.push(`…and ${hidden} more`);
  }
  lines.push(...noteLines(report.notes));
  const rows: Button[][] = [];
  for (let i = 0; i < numbers.length; i += 4) rows.push(numbers.slice(i, i + 4));
  rows.push(back({ kind: 'menu' }));
  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}

export function renderAuditIssue(raw: HealthIssue): MenuScreen {
  const issue = clipIssue(raw);
  const lines = ['🔎 *Health*', escapeMarkdown(healthIssueTitle(issue)), ...healthIssueLines(issue).map(escapeMarkdown)];
  return { text: lines.join('\n'), keyboard: { inline_keyboard: [back({ kind: 'health' })] } };
}
```

with:

```ts
/** R2: what the Health screens add when the deps can link. `result`: what the last tap did. */
export interface HealthScreenOptions {
  link?: boolean;
  result?: string;
}

/** The pairs a Health list shows: the issues it lists, linkable. */
const shownPairs = (report: HealthReport): LinkPair[] => linkablePairs((report.issues ?? []).slice(0, AUDIT_LIST_MAX));

export function renderAuditHealth(report: HealthReport, opts: HealthScreenOptions = {}): MenuScreen {
  const lines = ['🔎 *Health*'];
  if (opts.result) lines.push(escapeMarkdown(opts.result));
  const numbers: Button[] = [];
  const links: Button[] = [];
  if (report.issues && report.issues.length === 0 && !report.more) lines.push(escapeMarkdown(HEALTH_NONE));
  if (report.issues) {
    const { shown, hidden } = listed(report.issues, report.more);
    shown.forEach((issue, i) => {
      lines.push(`${i + 1}. ${escapeMarkdown(healthIssueTitle(clipIssue(issue)))}`);
      numbers.push({ text: String(i + 1), callback_data: auditData({ kind: 'issue', handle: issueHandle(issue) }) });
      const pair = opts.link ? linkablePair(issue) : null;
      if (pair) {
        // The list is the preview: the pair the button links.
        lines.push(`   ${escapeMarkdown(`Likely the other half: ${healthLegLine(clipLeg(pair.counterpart))}`)}`);
        links.push({ text: `${LINK_BUTTON} ${i + 1}`, callback_data: auditData({ kind: 'link', handle: pairHandle(pair) }) });
      }
    });
    if (hidden > 0) lines.push(`…and ${hidden} more`);
  }
  lines.push(...noteLines(report.notes));
  const rows: Button[][] = [];
  for (let i = 0; i < numbers.length; i += 4) rows.push(numbers.slice(i, i + 4));
  for (let i = 0; i < links.length; i += 4) rows.push(links.slice(i, i + 4));
  if (links.length >= 2) {
    rows.push([{ text: linkAllButton(links.length), callback_data: auditData({ kind: 'link-all', handle: pairsHandle(shownPairs(report)) }) }]);
  }
  rows.push(back({ kind: 'menu' }));
  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}

export function renderAuditIssue(raw: HealthIssue, opts: HealthScreenOptions = {}): MenuScreen {
  const issue = clipIssue(raw);
  const lines = ['🔎 *Health*', escapeMarkdown(healthIssueTitle(issue)), ...healthIssueLines(issue).map(escapeMarkdown)];
  const pair = opts.link ? linkablePair(raw) : null;
  const rows: Button[][] = pair ? [[{ text: LINK_BUTTON, callback_data: auditData({ kind: 'link', handle: pairHandle(pair) }) }]] : [];
  rows.push(back({ kind: 'health' }));
  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}
```

Edit 7 of 8 in `companion/src/audit-menu.ts` — replace:

```ts
  health(): Promise<HealthReport & { reached: boolean }>;
  now(): Date;
  log(msg: string): void;
}
```

with:

```ts
  health(): Promise<HealthReport & { reached: boolean }>;
  /** R2: link these pairs (shared/audit-link.ts `linkPairs`). Absent: no Link buttons. */
  link?(pairs: LinkPair[]): Promise<LinkRun>;
  now(): Date;
  log(msg: string): void;
}
```

Edit 8 of 8 in `companion/src/audit-menu.ts` — replace:

```ts
          case 'health': {
            const report = await deps.health();
            return void await show(renderAuditHealth(report));
          }
          case 'issue': {
            const report = await deps.health();
            if (!report.issues) return void await show(renderAuditHealth(report));
            const issue = report.issues.find((i) => issueHandle(i) === view.handle);
            if (!issue) return void await ui.answer(AUDIT_ISSUE_GONE);
            return void await show(renderAuditIssue(issue));
          }
```

with:

```ts
          case 'health': {
            const report = await deps.health();
            return void await show(renderAuditHealth(report, { link: !!deps.link }));
          }
          case 'issue': {
            const report = await deps.health();
            if (!report.issues) return void await show(renderAuditHealth(report, { link: !!deps.link }));
            const issue = report.issues.find((i) => issueHandle(i) === view.handle);
            if (!issue) return void await ui.answer(AUDIT_ISSUE_GONE);
            return void await show(renderAuditIssue(issue, { link: !!deps.link }));
          }
          case 'link':
          case 'link-all': {
            if (!deps.link) return void await ui.answer();
            const report = await deps.health();
            if (!report.issues) return void await show(renderAuditHealth(report, { link: true }));
            // Only pairs whose legs still read as the button carried them.
            const shown = shownPairs(report);
            const pairs = view.kind === 'link'
              ? shown.filter((p) => pairHandle(p) === view.handle)
              : pairsHandle(shown) === view.handle ? shown : [];
            if (pairs.length === 0) return void await show(renderAuditHealth(report, { link: true, result: LINK_CHANGED }));
            const run = await deps.link(pairs);
            // The screen re-reads: the list shows what is left.
            return void await show(renderAuditHealth(await deps.health(), { link: true, result: run.message }));
          }
```

Edit 1 of 2 in `companion/src/index.ts` — replace:

```ts
import { auditMenuDeps, auditStatusKeyboard, createAuditMenu, type AuditMenu } from './audit-menu.js';
```

with:

```ts
import { auditMenuDeps, auditStatusKeyboard, createAuditMenu, type AuditMenu } from './audit-menu.js';
import { companionLinkIo } from './audit-fix-host.js';
import { linkPairs } from '../../shared/audit-link.js';
```

Edit 2 of 2 in `companion/src/index.ts` — replace:

```ts
export function buildAuditMenu(wfClient: WealthfolioClient): AuditMenu {
  return createAuditMenu(auditMenuDeps(companionAuditReaders(wfClient, wealthfolioDbPath()), log));
}
```

with:

```ts
export function buildAuditMenu(wfClient: WealthfolioClient): AuditMenu {
  return createAuditMenu({
    ...auditMenuDeps(companionAuditReaders(wfClient, wealthfolioDbPath()), log),
    // R2: Link on the Health list, through the sync's own linker.
    link: (pairs) => linkPairs(pairs, companionLinkIo(wfClient, log)),
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd companion && npx vitest run src/audit-menu-link.test.ts src/audit-menu.test.ts src/index.test.ts`
Expected: PASS — 320 tests.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add companion/src/audit-menu-link.test.ts companion/src/index.test.ts companion/src/audit-menu.ts companion/src/index.ts
git commit -m "Audits R2: Link and Link all on /audit's Health list — the list is the preview, every tap re-reads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `/why`: Remove for good…, two taps, in place

Spec C2 in Telegram (Y3, Y5). With `remove` in the deps — `buildWhyMenu` wires `removeForGood` over `companionRemoveIo` — a story whose row qualifies (`removalOffered`) gets "Remove for good…" (`cz:wy:d<id>`), as a story sent as a new message does. The first tap edits the story in place into the confirm screen: its title and account, the exact words, **Remove** (`cz:wy:D<id>:<fingerprint>`) and **Cancel** (back to the story, `t<id>:c`). Remove says what happened in place, with nothing left to tap; a refusal shows the story again, re-read, with "⚠️ <why>" on top (or "⚠️ <why>" alone when the row is gone). Without `remove` every story is as 2b drew it.

**Files:**
- Modify: `companion/src/why-menu.ts`, `companion/src/index.ts`, `companion/src/index.test.ts`
- Create: `companion/src/why-menu-remove.test.ts`

**Interfaces:**
- Consumes: Task 4 (`removalFingerprint`, `removalOffered`, `removeForGood`, the `REMOVE_*` copy, `RemoveOutcome`); Task 5 (`companionRemoveIo`).
- Produces:

```ts
// companion/src/why-menu.ts
export type WhyView = /* … */ | { kind: 'remove-ask'; activityId: string } | { kind: 'remove'; activityId: string; fingerprint: string };
export interface StoryScreenOptions { removable?: boolean; notice?: string }
export function renderWhyStory(story: TxStory, activityId: string, back: StoryBack, opts?: StoryScreenOptions): MenuScreen;
export function renderWhyRemoveConfirm(story: TxStory, activityId: string, fingerprint: string): MenuScreen;
// WhyMenuDeps gains: remove?(activityId: string, fingerprint: string, now: Date): Promise<RemoveOutcome>;
```

- [ ] **Step 1: Write the failing tests**

**Create `companion/src/why-menu-remove.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { escapeMarkdown } from '../../shared/telegram.js';
import { buildTxStory, TX_STORY_GONE, type TxStoryFacts } from '../../shared/tx-story.js';
import {
  removalFingerprint, REMOVE_CHANGED, REMOVE_CONFIRM, REMOVE_DONE, type RemoveOutcome,
} from '../../shared/tx-remove.js';
import { createWhyMenu, parseWhyData, renderWhyRemoveConfirm, renderWhyStory, whyData, type MenuScreen, type WhyMenuDeps } from './why-menu.js';
import type { StoryOutcome } from './tx-story-host.js';

const ID = '0f8fad5b-d9cb-469f-a165-708677289501';
const NOW = new Date('2026-10-14T16:00:00Z');
const BANK = 'SQ *COFFEE_CLUB [2]';
const bytes = (s: string) => Buffer.byteLength(s, 'utf8');
const allData = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.callback_data);
const labels = (s: MenuScreen) => s.keyboard.inline_keyboard.flat().map((b) => b.text);

const facts = (over: Partial<TxStoryFacts> = {}, note = `${BANK} · TRN-600`): TxStoryFacts => ({
  now: NOW,
  row: { activityId: ID, note, absCents: 60000, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking' },
  feed: { sfinAccountId: 'sfin-chk' }, partner: null, history: [], ...over,
});
const ok = (f: TxStoryFacts = facts()): StoryOutcome => ({ kind: 'ok', story: buildTxStory(f), facts: f });
const FP = removalFingerprint(facts().row);

function deps(over: Partial<WhyMenuDeps> = {}): WhyMenuDeps {
  return {
    search: vi.fn(),
    story: vi.fn(async () => ok()),
    read: vi.fn(),
    remove: vi.fn(async (): Promise<RemoveOutcome> => ({ ok: true, message: REMOVE_DONE })),
    now: () => NOW,
    log: vi.fn(),
    ...over,
  };
}
const ui = () => ({ edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) });
const edited = (u: ReturnType<typeof ui>) => u.edit.mock.calls.at(-1) as unknown as [string, MenuScreen['keyboard']];

describe('the cz:wy: remove buttons', () => {
  it('parse back, and the longest fits 64 bytes with a 36-character id', () => {
    const ask = whyData({ kind: 'remove-ask', activityId: ID });
    const remove = whyData({ kind: 'remove', activityId: ID, fingerprint: FP });
    expect(parseWhyData(ask)).toEqual({ kind: 'remove-ask', activityId: ID });
    expect(parseWhyData(remove)).toEqual({ kind: 'remove', activityId: ID, fingerprint: FP });
    const confirm = renderWhyRemoveConfirm(buildTxStory(facts()), ID, FP);
    const data = [ask, ...allData(confirm)];
    expect(Math.max(...data.map(bytes))).toBe(52);
    for (const bad of [`cz:wy:D${ID}`, `cz:wy:D${ID}:XYZ`, 'cz:wy:d']) expect(parseWhyData(bad)).toBeNull();
  });
});

describe('Remove for good… on a /why story', () => {
  it('shows on a story that qualifies, only when the menu can remove', async () => {
    const story = buildTxStory(facts());
    expect(labels(renderWhyStory(story, ID, { kind: 'none' }, { removable: true }))).toEqual(['Remove for good…']);
    const u = ui();
    await createWhyMenu(deps()).onCallback({ data: whyData({ kind: 'story', activityId: ID, back: { kind: 'changes' } }) }, u);
    expect(edited(u)[1].inline_keyboard.flat().map((b) => b.callback_data)).toContain(`cz:wy:d${ID}`);
    const v = ui();
    await createWhyMenu(deps({ remove: undefined })).onCallback({ data: whyData({ kind: 'story', activityId: ID, back: { kind: 'changes' } }) }, v);
    expect(edited(v)[1].inline_keyboard.flat().map((b) => b.text)).not.toContain('Remove for good…');
    const w = ui();
    await createWhyMenu(deps({ story: vi.fn(async () => ok(facts({}, `${BANK} · TRN-600 · pending`))) }))
      .onCallback({ data: whyData({ kind: 'story', activityId: ID, back: { kind: 'changes' } }) }, w);
    expect(edited(w)[1].inline_keyboard.flat().map((b) => b.text)).not.toContain('Remove for good…');
  });

  it('the first tap edits the story into the confirm screen: the exact words, Remove, and Cancel back to the story', async () => {
    const d = deps();
    const u = ui();
    await createWhyMenu(d).onCallback({ data: `cz:wy:d${ID}` }, u);
    const [text, kb] = edited(u);
    expect(text).toBe([`🔎 ${escapeMarkdown(`${BANK} · $600.00 · Oct 9`)}`, 'PNC Checking', '', escapeMarkdown(REMOVE_CONFIRM)].join('\n'));
    expect(kb.inline_keyboard).toEqual([
      [{ text: 'Remove', callback_data: `cz:wy:D${ID}:${FP}` }],
      [{ text: 'Cancel', callback_data: `cz:wy:t${ID}:c` }],
    ]);
    expect(d.remove).not.toHaveBeenCalled();
    const back = ui();
    await createWhyMenu(d).onCallback({ data: kb.inline_keyboard[1][0].callback_data }, back);
    expect(edited(back)[0].startsWith(`🔎 ${escapeMarkdown(`${BANK} · $600.00 · Oct 9`)}\nPNC Checking\n`)).toBe(true);
  });

  it('Remove removes it and says so in place, with nothing left to tap', async () => {
    const d = deps();
    const u = ui();
    await createWhyMenu(d).onCallback({ data: `cz:wy:D${ID}:${FP}` }, u);
    expect(d.remove).toHaveBeenCalledWith(ID, FP, NOW);
    expect(edited(u)).toEqual([`🔎 ${escapeMarkdown(REMOVE_DONE)}`, { inline_keyboard: [] }]);
  });

  it('a refused Remove shows the story again, as it is now, with why on top', async () => {
    const d = deps({ remove: vi.fn(async () => ({ ok: false, message: REMOVE_CHANGED })) });
    const u = ui();
    await createWhyMenu(d).onCallback({ data: `cz:wy:D${ID}:${FP}` }, u);
    const [text] = edited(u);
    expect(text.startsWith(`⚠️ ${escapeMarkdown(REMOVE_CHANGED)}\n🔎 `)).toBe(true);
    const gone = deps({ remove: vi.fn(async () => ({ ok: false, message: REMOVE_CHANGED })), story: vi.fn(async (): Promise<StoryOutcome> => ({ kind: 'gone' })) });
    const v = ui();
    await createWhyMenu(gone).onCallback({ data: `cz:wy:D${ID}:${FP}` }, v);
    expect(edited(v)).toEqual([`⚠️ ${escapeMarkdown(REMOVE_CHANGED)}`, { inline_keyboard: [] }]);
  });

  it('answers a first tap on a row that is gone', async () => {
    const u = ui();
    await createWhyMenu(deps({ story: vi.fn(async (): Promise<StoryOutcome> => ({ kind: 'gone' })) })).onCallback({ data: `cz:wy:d${ID}` }, u);
    expect(u.answer).toHaveBeenCalledWith(TX_STORY_GONE);
    expect(u.edit).not.toHaveBeenCalled();
  });
});
```

Edit 1 of 1 in `companion/src/index.test.ts` — replace:

```ts
      await deps.onMenuCallback!({ data: 'cz:wy:s0:kroger', chatId: 1, messageId: 2 }, ui);
      expect((ui.edit.mock.calls[0] as unknown as [string])[0]).toBe('🔎 *Why is this here?* kroger\n\nTap one to see its story.');
    });
  });
```

with:

```ts
      await deps.onMenuCallback!({ data: 'cz:wy:s0:kroger', chatId: 1, messageId: 2 }, ui);
      expect((ui.edit.mock.calls[0] as unknown as [string])[0]).toBe('🔎 *Why is this here?* kroger\n\nTap one to see its story.');
    });

    it('Remove on a story skips it and deletes it over REST', async () => {
      const { removalFingerprint } = await import('../../shared/tx-remove.js');
      const { client, secrets } = clientFor([['account_mapping', JSON.stringify({ 'sfin-1': 'wf-1' })]]);
      const dup = {
        id: 'dup-1', accountId: 'wf-1', accountName: 'PNC Checking', activityType: 'DEPOSIT', date: '2026-10-09T00:00:00+00:00', amount: '600',
        currency: 'USD', comment: 'MOBILE DEPOSIT · TRN-600', sourceGroupId: null, metadata: null,
      };
      client.getAccounts = vi.fn(async () => [{ id: 'wf-1', accountType: 'CASH' }]);
      client.searchActivities = vi.fn(async (b: { activityIdFilter?: string[] }) => [dup].filter((r) => b.activityIdFilter?.includes(r.id)));
      client.saveMany = vi.fn(async () => ({ created: [], updated: [], errors: [] }));
      const fp = removalFingerprint({ activityId: 'dup-1', note: dup.comment, absCents: 60000, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking' });
      const deps = buildTelegramListenerDeps(client);
      const ui = { edit: vi.fn(async () => {}), answer: vi.fn(async () => {}), send: vi.fn(async () => {}) };
      await deps.onMenuCallback!({ data: `cz:wy:Ddup-1:${fp}`, chatId: 1, messageId: 2 }, ui);
      expect(JSON.parse(secrets.get('skipped_transactions')!)).toEqual([expect.objectContaining({ account: 'sfin-1', txId: 'TRN-600' })]);
      expect(client.saveMany).toHaveBeenCalledWith(expect.objectContaining({ deleteIds: ['dup-1'] }));
      expect((ui.edit.mock.calls[0] as unknown as [string])[0]).toBe(`🔎 ${escapeMarkdown("Removed. The bank feed won't import it again — Undo in the change log puts it back.")}`);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd companion && npx vitest run src/why-menu-remove.test.ts`
Expected: FAIL — all 6 tests.

Run: `cd companion && npx vitest run src/index.test.ts -t "Remove on a story"`
Expected: FAIL — 1 test (nothing is written to the skip list).

- [ ] **Step 3: Implement**

Edit 1 of 11 in `companion/src/why-menu.ts` — replace:

```ts
 *   r<handle>:<page>           a sync's imports, in place
 * `<id>` is an activity id; `<handle>` is `findingHandle(runId)`. A query is
 * cut to WHY_QUERY_MAX_BYTES so the longest story button fits 64 bytes.
```

with:

```ts
 *   r<handle>:<page>           a sync's imports, in place
 *   d<id>                      R2: "Remove for good…" — the confirm screen, in place
 *   D<id>:<fingerprint>        R2: remove it, then say what happened, in place
 * `<id>` is an activity id; `<handle>` is `findingHandle(runId)`;
 * `<fingerprint>` is `removalFingerprint` of the row as the confirm screen
 * showed it (shared/tx-remove.ts), 8 hex. A query is cut to
 * WHY_QUERY_MAX_BYTES so the longest story button fits 64 bytes; the longest
 * remove button is 52.
 *
 * "Remove for good…" (2c R2) shows on a story only when the deps can remove
 * (`remove`) and the row qualifies (`removalOffered`). Its first tap edits
 * the story into the confirm screen — Remove, or Cancel back to the story —
 * and Remove re-reads the row and refuses, in place, if it changed since.
```

Edit 2 of 11 in `companion/src/why-menu.ts` — replace:

```ts
import { TX_STORY_GONE, TX_STORY_NO_HISTORY, TX_STORY_UNREACHABLE, TX_STORY_WHAT_HAPPENED, type TxStory } from '../../shared/tx-story.js';
```

with:

```ts
import { TX_STORY_GONE, TX_STORY_NO_HISTORY, TX_STORY_UNREACHABLE, TX_STORY_WHAT_HAPPENED, type TxStory } from '../../shared/tx-story.js';
import {
  removalFingerprint, removalOffered, REMOVE_ACTION, REMOVE_BUTTON, REMOVE_CANCEL, REMOVE_CONFIRM, type RemoveOutcome,
} from '../../shared/tx-remove.js';
```

Edit 3 of 11 in `companion/src/why-menu.ts` — replace:

```ts
  /** `fresh`: from the import notice — sent as a new message. */
  | { kind: 'run'; run: string; page: number; fresh: boolean };
```

with:

```ts
  /** `fresh`: from the import notice — sent as a new message. */
  | { kind: 'run'; run: string; page: number; fresh: boolean }
  /** R2: the confirm screen of "Remove for good…". */
  | { kind: 'remove-ask'; activityId: string }
  /** R2: remove it, if it still reads as the confirm screen showed it. */
  | { kind: 'remove'; activityId: string; fingerprint: string };
```

Edit 4 of 11 in `companion/src/why-menu.ts` — replace:

```ts
    case 'run': return `${WHY_CALLBACK_PREFIX}r${view.run}${view.fresh ? '' : `:${view.page}`}`;
```

with:

```ts
    case 'run': return `${WHY_CALLBACK_PREFIX}r${view.run}${view.fresh ? '' : `:${view.page}`}`;
    case 'remove-ask': return `${WHY_CALLBACK_PREFIX}d${view.activityId}`;
    case 'remove': return `${WHY_CALLBACK_PREFIX}D${view.activityId}:${view.fingerprint}`;
```

Edit 5 of 11 in `companion/src/why-menu.ts` — replace:

```ts
  m = /^t([^:\s]{1,64}):r([0-9a-f]{8}):(\d{1,3})$/.exec(s);
  if (m) return { kind: 'story', activityId: m[1], back: { kind: 'run', run: m[2], page: Number(m[3]) } };
  return null;
}
```

with:

```ts
  m = /^t([^:\s]{1,64}):r([0-9a-f]{8}):(\d{1,3})$/.exec(s);
  if (m) return { kind: 'story', activityId: m[1], back: { kind: 'run', run: m[2], page: Number(m[3]) } };
  m = /^d([^:\s]{1,64})$/.exec(s);
  if (m) return { kind: 'remove-ask', activityId: m[1] };
  m = /^D([^:\s]{1,64}):([0-9a-f]{8})$/.exec(s);
  if (m) return { kind: 'remove', activityId: m[1], fingerprint: m[2] };
  return null;
}
```

Edit 6 of 11 in `companion/src/why-menu.ts` — replace:

```ts
export function renderWhyStory(story: TxStory, activityId: string, back: StoryBack): MenuScreen {
  const lines = [`🔎 ${escapeMarkdown(story.title)}`];
```

with:

```ts
/** R2: what a story screen adds. `removable`: offer "Remove for good…";
 *  `notice`: why the last tap did nothing, on top. */
export interface StoryScreenOptions {
  removable?: boolean;
  notice?: string;
}

/** "Remove for good…", first tap: the story's row and what Remove does. */
export function renderWhyRemoveConfirm(story: TxStory, activityId: string, fingerprint: string): MenuScreen {
  const lines = [`🔎 ${escapeMarkdown(story.title)}`];
  if (story.accountLine) lines.push(escapeMarkdown(story.accountLine));
  lines.push('', escapeMarkdown(REMOVE_CONFIRM));
  return {
    text: lines.join('\n'),
    keyboard: {
      inline_keyboard: [
        [{ text: REMOVE_BUTTON, callback_data: whyData({ kind: 'remove', activityId, fingerprint }) }],
        [{ text: REMOVE_CANCEL, callback_data: whyData({ kind: 'story', activityId, back: { kind: 'changes' } }) }],
      ],
    },
  };
}

export function renderWhyStory(story: TxStory, activityId: string, back: StoryBack, opts: StoryScreenOptions = {}): MenuScreen {
  const lines = [...(opts.notice ? [`⚠️ ${escapeMarkdown(opts.notice)}`] : []), `🔎 ${escapeMarkdown(story.title)}`];
```

Edit 7 of 11 in `companion/src/why-menu.ts` — replace:

```ts
  const keyboard: Button[][] = [];
  for (let i = 0; i < numbers.length; i += 4) keyboard.push(numbers.slice(i, i + 4));
  if (back.kind === 'search') keyboard.push([{ text: '⬅️ Back', callback_data: whyData({ kind: 'search', page: back.page, query: back.query }) }]);
```

with:

```ts
  const keyboard: Button[][] = [];
  for (let i = 0; i < numbers.length; i += 4) keyboard.push(numbers.slice(i, i + 4));
  if (opts.removable) keyboard.push([{ text: REMOVE_ACTION, callback_data: whyData({ kind: 'remove-ask', activityId }) }]);
  if (back.kind === 'search') keyboard.push([{ text: '⬅️ Back', callback_data: whyData({ kind: 'search', page: back.page, query: back.query }) }]);
```

Edit 8 of 11 in `companion/src/why-menu.ts` — replace:

```ts
  /** The change log, for a sync's imports. Rejects when unreachable. */
  read(now: Date): Promise<ChangeLogRead>;
  now(): Date;
  log(msg: string): void;
}
```

with:

```ts
  /** The change log, for a sync's imports. Rejects when unreachable. */
  read(now: Date): Promise<ChangeLogRead>;
  /** R2: remove a row for good (shared/tx-remove.ts `removeForGood`). Absent: never offered. */
  remove?(activityId: string, fingerprint: string, now: Date): Promise<RemoveOutcome>;
  now(): Date;
  log(msg: string): void;
}
```

Edit 9 of 11 in `companion/src/why-menu.ts` — replace:

```ts
export function createWhyMenu(deps: WhyMenuDeps): WhyMenu {
  const runImports = (read: ChangeLogRead, handle: string) =>
    read.entries.filter((e) => e.kind === 'import' && e.run && whyRunHandle(e.run) === handle && !!e.subject.activityIds?.[0]);
```

with:

```ts
export function createWhyMenu(deps: WhyMenuDeps): WhyMenu {
  const runImports = (read: ChangeLogRead, handle: string) =>
    read.entries.filter((e) => e.kind === 'import' && e.run && whyRunHandle(e.run) === handle && !!e.subject.activityIds?.[0]);
  /** R2: a story offers "Remove for good…" only when this menu can remove. */
  const removable = (out: Extract<StoryOutcome, { kind: 'ok' }>) => !!deps.remove && removalOffered(out.facts);
```

Edit 10 of 11 in `companion/src/why-menu.ts` — replace:

```ts
      if (out.kind === 'gone') return void await send(TX_STORY_GONE);
      await sendScreen(send, renderWhyStory(out.story, out.movedTo ?? activityId, { kind: 'none' }));
    },
```

with:

```ts
      if (out.kind === 'gone') return void await send(TX_STORY_GONE);
      await sendScreen(send, renderWhyStory(out.story, out.movedTo ?? activityId, { kind: 'none' }, { removable: removable(out) }));
    },
```

Edit 11 of 11 in `companion/src/why-menu.ts` — replace:

```ts
            // A row that moved (a link re-created it) is the one its history lines come back to.
            return void await show(renderWhyStory(out.story, out.movedTo ?? view.activityId, view.back), view.back.kind === 'none');
          }
```

with:

```ts
            // A row that moved (a link re-created it) is the one its history lines come back to.
            return void await show(
              renderWhyStory(out.story, out.movedTo ?? view.activityId, view.back, { removable: removable(out) }),
              view.back.kind === 'none',
            );
          }
          case 'remove-ask': {
            if (!deps.remove) return void await ui.answer();
            const out = await deps.story(view.activityId, now);
            if (out.kind === 'unreachable') return void await ui.answer(TX_STORY_UNREACHABLE);
            if (out.kind === 'gone') return void await ui.answer(TX_STORY_GONE);
            return void await show(renderWhyRemoveConfirm(out.story, out.movedTo ?? view.activityId, removalFingerprint(out.facts.row)), false);
          }
          case 'remove': {
            if (!deps.remove) return void await ui.answer();
            const result = await deps.remove(view.activityId, view.fingerprint, now);
            if (result.ok) return void await show({ text: `🔎 ${escapeMarkdown(result.message)}`, keyboard: { inline_keyboard: [] } }, false);
            // Refused: the story again, as it is now, with why on top.
            const out = await deps.story(view.activityId, now);
            if (out.kind !== 'ok') return void await show({ text: `⚠️ ${escapeMarkdown(result.message)}`, keyboard: { inline_keyboard: [] } }, false);
            return void await show(renderWhyStory(out.story, out.movedTo ?? view.activityId, { kind: 'changes' }, {
              removable: removable(out), notice: result.message,
            }), false);
          }
```

Edit 1 of 2 in `companion/src/index.ts` — replace:

```ts
import { companionLinkIo } from './audit-fix-host.js';
import { linkPairs } from '../../shared/audit-link.js';
```

with:

```ts
import { companionLinkIo, companionRemoveIo } from './audit-fix-host.js';
import { linkPairs } from '../../shared/audit-link.js';
import { removeForGood } from '../../shared/tx-remove.js';
```

Edit 2 of 2 in `companion/src/index.ts` — replace:

```ts
    story: (activityId, now) => companionTxStory(readers(), activityId, now),
    read: (now) => readCompanionChangeLog(wfClient, now),
    now: () => new Date(),
    log,
  });
}
```

with:

```ts
    story: (activityId, now) => companionTxStory(readers(), activityId, now),
    read: (now) => readCompanionChangeLog(wfClient, now),
    // R2: "Remove for good…" on a story.
    remove: (activityId, fingerprint, now) => removeForGood(activityId, fingerprint, companionRemoveIo(wfClient, log), now),
    now: () => new Date(),
    log,
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd companion && npx vitest run src/why-menu-remove.test.ts src/why-menu.test.ts src/index.test.ts`
Expected: PASS — 344 tests.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add companion/src/why-menu-remove.test.ts companion/src/index.test.ts companion/src/why-menu.ts companion/src/index.ts
git commit -m "Audits R2: Remove for good… on /why's story — explain, then Remove or Cancel, refused in place when it changed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The app's Checks card: Link and Link all

Spec C1 in the app (Y2, Y6). `src/utils/audit-fix.ts` lends `linkPairs` the add-on's reads and writes: both rows by exact id through the SDK with their accounts' types; "linked" from a group the SDK reports or `linked_groups` (confirmed), else the snapshot-narrowed "maybe" rule (Deviations); writes through `AddonSyncHost`; the pair added to `linked_groups`, re-read right before the write and never written over when it cannot be read; entries through the store's writer. The Checks card (`HealthView` given a `fix`) offers Link under each linkable leg and Link all for two or more: one action at a time (a ref guard, every button disabled and `aria-busy`), the result in a `role="status"` line followed by "Changes show here after the next sync.", the buttons of the pairs it linked gone; then the page reads the snapshot again (`onAuditChanged`). SettingsTab builds the linker — it has `ctx` and `store`.

**Files:**
- Create: `src/utils/audit-fix.ts`, `src/utils/audit-fix.test.ts`, `src/components/AuditFix.test.tsx`, `src/pages/audit-fix-app.test.tsx`
- Modify: `src/components/AuditViews.tsx`, `src/components/ui.tsx`, `src/tabs/SettingsTab.tsx`, `src/pages/SyncPage.tsx`

**Interfaces:**
- Consumes: Task 3 (`linkPairs`, `linkablePair`, `linkablePairs`, `linkAllButton`, `LINK_BUTTON`, `LINK_UNREACHABLE`, `LinkIo`, `LinkPair`, `LinkRun`, `ReadRow`, `fixRowOf`, `linkedState`, `FixRow`); `AddonSyncHost` (src/utils/addon-host.ts); `SecretsStore`'s `readSyncOverrides`, `getLinkedGroups`, `setLinkedGroups`, `recordChange`, `getAuditSnapshot`.
- Produces:

```ts
// src/utils/audit-fix.ts
export type FixStore = Partial<Pick<SecretsStore, 'readSyncOverrides' | 'getLinkedGroups' | 'setLinkedGroups' | 'recordChange'>>;
export function addonLinkIo(ctx: AddonContext, store: FixStore, log?: (msg: string) => void): LinkIo;
export function linkFromApp(ctx: AddonContext, store: FixStore, pairs: LinkPair[]): Promise<LinkRun>;
// src/components/AuditViews.tsx
export const AUDIT_AFTER_SYNC: string; // 'Changes show here after the next sync.'
export interface HealthFix { link: (pairs: LinkPair[]) => Promise<LinkRun>; onFixed?: () => void }
export function HealthView(props: { report: HealthReport; fix?: HealthFix }): JSX.Element;
export function ChecksCard(props: AuditSource & Partial<HealthFix>): JSX.Element;
// src/tabs/SettingsTab.tsx — Props gains: onAuditChanged?: () => void;
```

- [ ] **Step 1: Write the failing tests**

**Create `src/utils/audit-fix.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import type { HealthLeg } from '../../shared/audit-health';
import { LINK_CHANGED, LINK_DONE, LINK_UNREACHABLE, type LinkPair } from '../../shared/audit-link';
import { emptySyncOverrides } from '../../shared/sync-overrides';
import { accountTxKey } from '../../shared/transfers';
import { linkFromApp, type FixStore } from './audit-fix';

const OUT_KEY = accountTxKey('sfin-chk', 'TRN-1');
const IN_KEY = accountTxKey('sfin-card', 'TRN-2');
type Row = Record<string, unknown> & { id: string; accountId: string };
const detail = (over: Row): Row => ({
  activityType: 'WITHDRAWAL', date: '2026-10-08T00:00:00.000Z', amount: '464.60', currency: 'USD', accountName: 'PNC Checking', metadata: null, ...over,
});
const OUT = detail({ id: 'out-1', accountId: 'wf-chk', comment: 'CITI AUTOPAY · TRN-1' });
const INTO = detail({ id: 'in-1', accountId: 'wf-card', activityType: 'TRANSFER_IN', accountName: 'Citi Card', comment: 'PAYMENT THANK YOU · TRN-2' });
const leg = (r: Row, txKey: string): HealthLeg => ({
  activityId: r.id, accountId: r.accountId, accountName: String(r.accountName), txKey, date: '2026-10-08', absCents: 46460,
  type: String(r.activityType), currency: 'USD', description: String(r.comment).split(' · ')[0],
});
/** The snapshot's view: the card's payment is the leg, the checking withdrawal its other half. */
const PAIR: LinkPair = { key: 'leg:in-1', leg: leg(INTO, IN_KEY), counterpart: leg(OUT, OUT_KEY) };

/** The add-on SDK, in memory: the exact-id search, accounts and the bulk endpoint. */
function fakeCtx(rows: Row[]) {
  const saved: Array<Record<string, any>> = [];
  let next = 0;
  const ctx = {
    api: {
      accounts: { getAll: vi.fn(async () => [{ id: 'wf-chk', accountType: 'CASH' }, { id: 'wf-card', accountType: 'CREDIT_CARD' }]) },
      activities: {
        search: vi.fn(async (_page: number, _size: number, filters: { activityIds?: string[] }) => ({
          data: rows.filter((r) => filters.activityIds?.includes(r.id)), meta: { totalRowCount: 0 },
        })),
        saveMany: vi.fn(async (req: Record<string, any>) => {
          saved.push(req);
          for (const id of req.deleteIds ?? []) rows.splice(rows.findIndex((r) => r.id === id), 1);
          const created = (req.creates ?? []).map((w: Record<string, any>) => {
            next += 1;
            return { id: `new-${next}`, accountId: w.accountId, notes: w.comment, sourceGroupId: w.sourceGroupId ?? null };
          });
          return { created, updated: [], errors: [] };
        }),
      },
    },
  };
  return { ctx: ctx as any, saved };
}
const fakeStore = (over: FixStore = {}): FixStore & Record<string, any> => ({
  readSyncOverrides: vi.fn(async () => ({ overrides: emptySyncOverrides(), unreadable: false })),
  getLinkedGroups: vi.fn(async () => ({})),
  setLinkedGroups: vi.fn(async () => {}),
  recordChange: vi.fn(async () => {}),
  ...over,
});

describe('Link from the app', () => {
  it('re-reads both rows by id, links them through the SDK, remembers the pair, and records it as yours', async () => {
    const f = fakeCtx([{ ...OUT }, { ...INTO }]);
    const store = fakeStore();
    expect((await linkFromApp(f.ctx, store, [PAIR])).message).toBe(LINK_DONE);
    expect(f.ctx.api.activities.search).toHaveBeenCalledWith(0, 1, { activityIds: ['in-1'] }, '');
    expect(f.saved[0].deleteIds).toEqual(['out-1', 'in-1']);
    const creates = f.saved[1].creates as Array<Record<string, unknown>>;
    expect(creates.map((w) => w.activityType)).toEqual(['TRANSFER_OUT', 'TRANSFER_IN']);
    expect(store.setLinkedGroups).toHaveBeenCalledWith({ [OUT_KEY]: creates[0].sourceGroupId, [IN_KEY]: creates[0].sourceGroupId });
    expect(store.recordChange).toHaveBeenCalledWith(expect.objectContaining({ actor: 'you', kind: 'transfer-link' }));
  });

  it('refuses a pair its ledger already knows, and a row a link has marked since the snapshot', async () => {
    const known = fakeCtx([{ ...OUT }, { ...INTO }]);
    expect((await linkFromApp(known.ctx, fakeStore({ getLinkedGroups: vi.fn(async () => ({ [IN_KEY]: 'wf-transfer-x' })) }), [PAIR])).message).toBe(LINK_CHANGED);
    expect(known.saved).toEqual([]);
    const marked = fakeCtx([{ ...OUT }, { ...INTO, metadata: { flow: { is_external: false } } }]);
    expect((await linkFromApp(marked.ctx, fakeStore(), [PAIR])).message).toBe(LINK_CHANGED);
    expect(marked.saved).toEqual([]);
  });

  it('refuses a row whose amount changed between the snapshot and the click, and writes nothing', async () => {
    const f = fakeCtx([{ ...OUT, amount: '464.70' }, { ...INTO }]);
    const store = fakeStore();
    expect((await linkFromApp(f.ctx, store, [PAIR])).message).toBe(LINK_CHANGED);
    expect(f.saved).toEqual([]);
    expect(store.recordChange).not.toHaveBeenCalled();
  });

  it('never overwrites a ledger it cannot read', async () => {
    const f = fakeCtx([{ ...OUT }, { ...INTO }]);
    const store = fakeStore({ getLinkedGroups: vi.fn(async () => { throw new SyntaxError('Unexpected token'); }) });
    expect((await linkFromApp(f.ctx, store, [PAIR])).message).toBe(LINK_DONE);
    expect(store.setLinkedGroups).not.toHaveBeenCalled();
  });

  it('links nothing when the overrides cannot be read', async () => {
    const f = fakeCtx([{ ...OUT }, { ...INTO }]);
    expect((await linkFromApp(f.ctx, fakeStore({ readSyncOverrides: undefined }), [PAIR])).message).toBe(LINK_UNREACHABLE);
    expect(f.saved).toEqual([]);
  });
});
```

**Create `src/components/AuditFix.test.tsx`:**

```tsx
import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { healthIssues } from '../../shared/audit-health';
import type { AuditLedgerRow } from '../../shared/audit-ledger';
import { linkablePairs, type LinkPair, type LinkRun } from '../../shared/audit-link';
import { buildAuditSnapshot, parseAuditSnapshot, type AuditSnapshotRead } from '../../shared/audit-snapshot';
import { AUDIT_AFTER_SYNC, ChecksCard } from './AuditViews';

const EMOJI = /\p{Extended_Pictographic}/u;
const NOW = new Date(2026, 9, 14, 12, 0);
const row = (over: Partial<AuditLedgerRow>): AuditLedgerRow => ({
  id: 'r', accountId: 'wf-chk', date: '2026-10-04', currency: 'USD', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', status: 'POSTED',
  absCents: 0, group: '', assetId: '', external: false, phantomCash: false, notes: 'ROW · TRN-0', ...over,
});
const ledger = {
  accounts: [{ id: 'wf-chk', name: 'PNC Checking', type: 'CASH', archived: false }, { id: 'wf-ally', name: 'Ally', type: 'CASH', archived: false }],
  rows: [
    row({ id: 'outA', absCents: 60000, notes: 'TRANSFER TO ALLY · TRN-1' }),
    row({ id: 'inA', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', absCents: 60000, date: '2026-10-05', notes: 'FROM PNC · TRN-2' }),
    row({ id: 'outB', absCents: 2500, date: '2026-10-06', notes: 'ZELLE TO SAVINGS · TRN-3' }),
    row({ id: 'inB', accountId: 'wf-ally', rawType: 'DEPOSIT', type: 'DEPOSIT', absCents: 2500, date: '2026-10-06', notes: 'ZELLE FROM PNC · TRN-4' }),
    row({ id: 'lone', absCents: 777, date: '2026-10-07', notes: 'TO SOMEWHERE · TRN-5' }),
  ],
};
const health = healthIssues({ ledger, mapping: { 'sfin-chk': 'wf-chk', 'sfin-ally': 'wf-ally' } });
const read: AuditSnapshotRead = parseAuditSnapshot(JSON.stringify(buildAuditSnapshot({
  balances: { accounts: [], notes: [] },
  headline: { month: '2026-10', reportCents: null, wealthfolioCents: null, unexplainedCents: null, reasons: null, notes: [] },
  health,
}, new Date(2026, 9, 14, 10, 0))));
const PAIRS = linkablePairs(health.issues);

const linked = (pairs: LinkPair[], message = pairs.length === 1 ? 'Linked.' : `Linked all ${pairs.length}.`): LinkRun => ({
  total: pairs.length, linked: pairs.length, changed: 0, failed: 0, done: pairs.map((p) => p.key), message,
});
const card = (link?: (pairs: LinkPair[]) => Promise<LinkRun>, onFixed = vi.fn()) =>
  render(<ChecksCard read={read} companionVersion="1.61.0" now={NOW} link={link} onFixed={onFixed} />);

describe('Link on the Checks card', () => {
  it('offers Link under each leg with one other half, and Link all for two or more', () => {
    card(vi.fn());
    expect(screen.getAllByRole('button', { name: 'Link' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Link all 2' })).toBeInTheDocument();
  });

  it('offers no Link without a linker', () => {
    card(undefined);
    expect(screen.queryByRole('button', { name: /^Link/ })).toBeNull();
  });

  it('runs one action at a time, every button disabled and busy, then says what happened and that it shows after the next sync', async () => {
    let finish!: (r: LinkRun) => void;
    const link = vi.fn(() => new Promise<LinkRun>((r) => { finish = r; }));
    const onFixed = vi.fn();
    card(link, onFixed);
    const first = screen.getAllByRole('button', { name: 'Link' })[0];
    fireEvent.click(first);
    fireEvent.click(first);
    fireEvent.click(screen.getByRole('button', { name: 'Link all 2' }));
    expect(link).toHaveBeenCalledTimes(1);
    expect(link).toHaveBeenCalledWith([PAIRS[0]]);
    for (const b of screen.getAllByRole('button', { name: /^Link/ })) {
      expect(b).toBeDisabled();
      expect(b).toHaveAttribute('aria-busy', 'true');
    }
    await act(async () => { finish(linked([PAIRS[0]])); });
    expect(screen.getByText(`Linked. ${AUDIT_AFTER_SYNC}`)).toBeInTheDocument();
    // That pair's button is gone; one pair is left, so no Link all.
    expect(screen.getAllByRole('button', { name: 'Link' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Link all/ })).toBeNull();
    expect(onFixed).toHaveBeenCalledTimes(1);
  });

  it('Link all links every pair it lists, and says how it went', async () => {
    const link = vi.fn(async (pairs: LinkPair[]) => ({ ...linked(pairs.slice(0, 1)), total: 2, changed: 1, message: 'Linked 1 of 2 — 1 had changed since.' }));
    card(link);
    fireEvent.click(screen.getByRole('button', { name: 'Link all 2' }));
    expect(link).toHaveBeenCalledWith(PAIRS);
    expect(await screen.findByText(`Linked 1 of 2 — 1 had changed since. ${AUDIT_AFTER_SYNC}`)).toBeInTheDocument();
  });

  it('says Wealthfolio could not be reached when the link throws, with no emoji anywhere', async () => {
    const { container } = card(vi.fn(async () => { throw new Error('offline'); }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Link' })[0]);
    expect(await screen.findByText(`Couldn't reach Wealthfolio — nothing was linked. ${AUDIT_AFTER_SYNC}`)).toBeInTheDocument();
    expect(EMOJI.test(container.textContent ?? '')).toBe(false);
  });

  it('changes nothing once the card is gone', async () => {
    let finish!: (r: LinkRun) => void;
    const onFixed = vi.fn();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = card(vi.fn(() => new Promise<LinkRun>((r) => { finish = r; })), onFixed);
    fireEvent.click(screen.getAllByRole('button', { name: 'Link' })[0]);
    unmount();
    await act(async () => { finish(linked([PAIRS[0]])); });
    await waitFor(() => expect(onFixed).not.toHaveBeenCalled());
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
```

**Create `src/pages/audit-fix-app.test.tsx`:**

```tsx
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { SyncPage } from './SyncPage';
import { makeProps } from './test-props';
import { AUDIT_AFTER_SYNC } from '../components/AuditViews';
import { healthIssues } from '../../shared/audit-health';
import type { AuditLedgerRow } from '../../shared/audit-ledger';
import { buildAuditSnapshot, parseAuditSnapshot } from '../../shared/audit-snapshot';
import { emptySyncOverrides } from '../../shared/sync-overrides';

/**
 * Link through the page (2c R2, spec C1): Settings → Checks links a pair with
 * the add-on's own host, then reads the snapshot again.
 */
vi.mock('recharts', () => {
  const stub = (name: string) => (p: any) => React.createElement('div', { 'data-recharts': name }, p?.children ?? null);
  return {
    Area: stub('Area'), AreaChart: stub('AreaChart'), Bar: stub('Bar'), BarChart: stub('BarChart'),
    CartesianGrid: stub('CartesianGrid'), Cell: stub('Cell'), Line: stub('Line'),
    LineChart: stub('LineChart'), Pie: stub('Pie'), PieChart: stub('PieChart'),
    XAxis: stub('XAxis'), YAxis: stub('YAxis'),
  };
});
vi.mock('@wealthfolio/ui/chart', () => ({
  ChartContainer: (p: any) => React.createElement('div', null, p.children),
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
  ChartLegend: () => null,
  ChartLegendContent: () => null,
  ChartStyle: () => null,
}));
vi.mock('../utils/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/sync')>();
  return { INTERVAL_SKIP_MESSAGE: actual.INTERVAL_SKIP_MESSAGE, runSync: vi.fn(async () => ({ imported: 0, skipped: 0, errors: [] })) };
});

const AT = new Date(2026, 9, 14, 10, 0);
const LATER = new Date(2026, 9, 14, 12, 0);
const row = (over: Partial<AuditLedgerRow>): AuditLedgerRow => ({
  id: 'r', accountId: 'wf-b', date: '2026-10-04', currency: 'USD', rawType: 'TRANSFER_OUT', type: 'TRANSFER_OUT', status: 'POSTED',
  absCents: 60000, group: '', assetId: '', external: false, phantomCash: false, notes: 'TO SAVINGS · TRN-6', ...over,
});
/** test-props' Spend (sfin-2 → wf-b) sent $600 to Growth (sfin-1 → wf-a), and neither side is linked. */
const ledger = {
  accounts: [{ id: 'wf-a', name: 'Growth', type: 'CASH', archived: false }, { id: 'wf-b', name: 'Spend', type: 'CASH', archived: false }],
  rows: [row({ id: 'out' }), row({ id: 'in', accountId: 'wf-a', rawType: 'DEPOSIT', type: 'DEPOSIT', date: '2026-10-05', notes: 'FROM SPEND · TRN-7' })],
};
const read = () => parseAuditSnapshot(JSON.stringify(buildAuditSnapshot({
  balances: { accounts: [], notes: [] },
  headline: { month: '2026-10', reportCents: null, wealthfolioCents: null, unexplainedCents: null, reasons: null, notes: [] },
  health: healthIssues({ ledger, mapping: { 'sfin-1': 'wf-a', 'sfin-2': 'wf-b' } }),
}, AT)));
const stored = () => [
  { id: 'out', accountId: 'wf-b', accountName: 'Spend', activityType: 'TRANSFER_OUT', date: '2026-10-04T00:00:00.000Z', amount: '600', currency: 'USD', comment: 'TO SAVINGS · TRN-6', metadata: null },
  { id: 'in', accountId: 'wf-a', accountName: 'Growth', activityType: 'DEPOSIT', date: '2026-10-05T00:00:00.000Z', amount: '600', currency: 'USD', comment: 'FROM SPEND · TRN-7', metadata: null },
];

describe('Settings → Checks → Link', () => {
  it('links the pair through the add-on, says so, and reads the snapshot again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(LATER);
    onTestFinished(() => { vi.useRealTimers(); });
    const props = makeProps();
    const rows = stored();
    props.ctx.api.accounts.getAll = vi.fn(async () => [{ id: 'wf-a', name: 'Growth', accountType: 'CASH' }, { id: 'wf-b', name: 'Spend', accountType: 'CASH' }]);
    props.ctx.api.activities = {
      search: vi.fn(async (_p: number, _s: number, f: { activityIds?: string[] }) => ({ data: rows.filter((r) => f.activityIds?.includes(r.id)), meta: { totalRowCount: 0 } })),
      saveMany: vi.fn(async (req: { creates?: Array<Record<string, unknown>> }) => ({
        created: (req.creates ?? []).map((w, i) => ({ id: `new-${i}`, accountId: w.accountId, notes: w.comment, sourceGroupId: w.sourceGroupId })),
        updated: [], errors: [],
      })),
    };
    props.store.getUiState = vi.fn(async () => ({ activeTab: 'settings' }));
    props.store.getOpenCards = vi.fn(async () => ({ checks: true }));
    props.store.getCompanionVersion = vi.fn(async () => '1.61.0');
    props.store.getAuditSnapshot = vi.fn(async () => read());
    props.store.readSyncOverrides = vi.fn(async () => ({ overrides: emptySyncOverrides(), unreadable: false }));
    props.store.getLinkedGroups = vi.fn(async () => ({}));
    props.store.setLinkedGroups = vi.fn(async () => {});
    props.store.recordChange = vi.fn(async () => {});
    render(<SyncPage {...props} />);
    const link = await screen.findByRole('button', { name: 'Link' });
    const reads = props.store.getAuditSnapshot.mock.calls.length;
    fireEvent.click(link);
    expect(await screen.findByText(`Linked. ${AUDIT_AFTER_SYNC}`)).toBeInTheDocument();
    expect(props.ctx.api.activities.saveMany).toHaveBeenCalledWith({ deleteIds: ['out', 'in'] });
    expect(props.store.recordChange).toHaveBeenCalledWith(expect.objectContaining({ actor: 'you', kind: 'transfer-link' }));
    await waitFor(() => expect(props.store.getAuditSnapshot).toHaveBeenCalledTimes(reads + 1));
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/utils/audit-fix.test.ts src/components/AuditFix.test.tsx src/pages/audit-fix-app.test.tsx`
Expected: FAIL — `src/utils/audit-fix.test.ts` cannot resolve `./audit-fix`; 5 of the 6 card tests fail (no Link buttons — `offers no Link without a linker` already passes), and so does the page test.

- [ ] **Step 3: Implement**

**Create `src/utils/audit-fix.ts`:**

```ts
/**
 * src/utils/audit-fix.ts
 *
 * The add-on's half of the fixes (2c R2, spec C): what Link
 * (shared/audit-link.ts) reads and writes through the add-on SDK. Rows are
 * re-read by exact id — Wealthfolio 3.8's `activityIds` search filter, the
 * read the story uses (src/utils/tx-story.ts) — and written through
 * `AddonSyncHost`, whose `linkPair` is the sync's own `linkPairByRecreate`.
 *
 * The add-on cannot count on reading a row's group back, so a row is
 * confirmed linked by a group the host does report or by the add-on's own
 * `linked_groups` ledger; otherwise `linkedState`'s rule for a row the
 * snapshot read unpaired decides "maybe". A pair linked here goes into that
 * ledger too: it is how the add-on's sync knows to leave both legs as stored.
 * Every store method is optional-called.
 */
import type { ActivitySearchFilters, AddonContext } from '@wealthfolio/addon-sdk';
import type { HealthLeg } from '../../shared/audit-health';
import { linkPairs, type LinkIo, type LinkPair, type LinkRun, type ReadRow } from '../../shared/audit-link';
import { fixRowOf, linkedState, type FixRow } from '../../shared/fix-row';
import { txIdFromComment } from '../../shared/sync-core';
import { AddonSyncHost } from './addon-host';
import type { SecretsStore } from './secrets';

/** The store methods the fixes use, every one optional. */
export type FixStore = Partial<Pick<SecretsStore,
  'readSyncOverrides' | 'getLinkedGroups' | 'setLinkedGroups' | 'recordChange'>>;

const warn = (msg: string) => console.warn(`[simplefin-sync] ${msg}`);

const accountTypes = async (ctx: AddonContext) =>
  new Map((await ctx.api.accounts.getAll()).map((a) => [a.id, String(a.accountType ?? '')]));

/** One row by id, as the fixes read it; null when it is gone. */
async function readFixRow(ctx: AddonContext, activityId: string, types: Map<string, string>): Promise<FixRow | null> {
  const filters = { activityIds: [activityId] } as ActivitySearchFilters;
  const res = await ctx.api.activities.search(0, 1, filters, '');
  const hit = (res.data ?? []).find((a) => a.id === activityId);
  return hit ? fixRowOf(hit, types.get(hit.accountId) ?? '') : null;
}

/** The add-on's ledger of pairs; null when it cannot be read (no evidence either way). */
async function ledgerOf(store: FixStore): Promise<Record<string, string> | null> {
  try {
    return (await store.getLinkedGroups?.()) ?? {};
  } catch {
    return null;
  }
}

const ledgerKnows = (ledger: Record<string, string> | null, keys: readonly string[], txId: string | null) =>
  !!ledger && (keys.some((k) => ledger[k] !== undefined) || (!!txId && ledger[txId] !== undefined));

export function addonLinkIo(ctx: AddonContext, store: FixStore, log: (msg: string) => void = warn): LinkIo {
  const host = new AddonSyncHost(ctx);
  return {
    read: async (pair: LinkPair) => {
      const types = await accountTypes(ctx);
      const ledger = await ledgerOf(store);
      const one = async (leg: HealthLeg): Promise<ReadRow | null> => {
        const row = await readFixRow(ctx, leg.activityId, types);
        if (!row) return null;
        const knows = ledgerKnows(ledger, leg.txKey ? [leg.txKey] : [], txIdFromComment(row.notes));
        return { row, linked: linkedState(row, { readsGroups: false, ledgerKnows: knows, unpairedWhenRead: true }) };
      };
      return [await one(pair.leg), await one(pair.counterpart)];
    },
    overrides: async () => {
      const loaded = await store.readSyncOverrides?.();
      if (!loaded) throw new Error("the overrides couldn't be read");
      return loaded;
    },
    link: (legs) => host.linkPair(legs),
    restore: (writes) => host.saveMany({ creates: writes }),
    remember: async (keys, groupId) => {
      if (!store.getLinkedGroups || !store.setLinkedGroups) return;
      // Re-read right before the write (the add-on's sync writes it too); a
      // ledger that cannot be read throws here and is never overwritten.
      const ledger = await store.getLinkedGroups();
      await store.setLinkedGroups({ ...ledger, [keys[0]]: groupId, [keys[1]]: groupId });
    },
    record: async (draft) => {
      await store.recordChange?.(draft);
    },
    log,
  };
}

/** Link from Settings → Checks. */
export function linkFromApp(ctx: AddonContext, store: FixStore, pairs: LinkPair[]): Promise<LinkRun> {
  return linkPairs(pairs, addonLinkIo(ctx, store));
}
```

Edit 1 of 4 in `src/components/AuditViews.tsx` — replace:

```tsx
import React, { useState } from 'react';
```

with:

```tsx
import React, { useEffect, useRef, useState } from 'react';
```

Edit 2 of 4 in `src/components/AuditViews.tsx` — replace:

```tsx
import { healthCount, healthIssueLines, healthIssueTitle, HEALTH_NONE, type HealthReport } from '../../shared/audit-health';
import { auditSnapshotStatus, AUDIT_CORRUPT, type AuditSnapshotRead } from '../../shared/audit-snapshot';
```

with:

```tsx
import { healthCount, healthIssueLines, healthIssueTitle, HEALTH_NONE, type HealthIssue, type HealthReport } from '../../shared/audit-health';
import {
  linkablePair, linkablePairs, linkAllButton, LINK_BUTTON, LINK_UNREACHABLE, type LinkPair, type LinkRun,
} from '../../shared/audit-link';
import { auditSnapshotStatus, AUDIT_CORRUPT, type AuditSnapshotRead } from '../../shared/audit-snapshot';
import { Button } from './ui';
```

Edit 3 of 4 in `src/components/AuditViews.tsx` — replace:

```tsx
 * bank text is never markup. No emoji (src/pages/copy-policy.test.tsx).
 */
export const AUDIT_HEADLINE_LINK = 'Why is this different from Wealthfolio?';
```

with:

```tsx
 * bank text is never markup. No emoji (src/pages/copy-policy.test.tsx).
 *
 * R2: given a linker, the Checks card offers Link under each Health leg with
 * one likely other half, and Link all for two or more. One action at a time
 * (every button disabled and busy while it runs); the result is said in a
 * status line, and — the card shows a snapshot — that changes show here
 * after the next sync.
 */
export const AUDIT_HEADLINE_LINK = 'Why is this different from Wealthfolio?';
/** After a fix: the card reads the companion's snapshot, which only its next sync renews. */
export const AUDIT_AFTER_SYNC = 'Changes show here after the next sync.';
```

Edit 4 of 4 in `src/components/AuditViews.tsx` — replace:

```tsx
export function HealthView({ report }: { report: HealthReport }) {
  return (
    <div className="sfin-audit-body">
      {report.issues === null && report.notes.length === 0 && <div>{AUDIT_HEALTH_NOT_CHECKED}</div>}
      {report.issues && report.issues.length === 0 && !report.more && <div>{HEALTH_NONE}</div>}
      {report.issues && report.issues.length > 0 && (
        <ul className="sfin-audit-issues">
          {report.issues.map((i) => (
            <li key={i.key} className="sfin-audit-issue">
              <div className="sfin-audit-head">{healthIssueTitle(i)}</div>
              {healthIssueLines(i).map((l, n) => <div key={n} className="sfin-subtle">{l}</div>)}
            </li>
          ))}
        </ul>
      )}
      {report.more ? <div className="sfin-subtle">and {report.more} more</div> : null}
      <AuditNotes notes={report.notes} />
    </div>
  );
}

/** Settings → Checks: what Health flags, and where the checks came from. */
export function ChecksCard(source: AuditSource) {
  return (
    <div className="sfin-audit-checks">
      <AuditBoundary read={source.read}>
        {source.read.kind === 'ok' && <HealthView report={source.read.snapshot.health} />}
```

with:

```tsx
/** R2: what the Checks card can fix. */
export interface HealthFix {
  link: (pairs: LinkPair[]) => Promise<LinkRun>;
  /** After a fix: read the snapshot again. */
  onFixed?: () => void;
}

export function HealthView({ report, fix }: { report: HealthReport; fix?: HealthFix }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  // Pairs linked here: the snapshot lists them until the companion's next sync.
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set());
  // One action per click, even before the re-render that disables the buttons.
  const running = useRef(false);
  // No state updates once the card is gone (a link can outlive it).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const pairOf = (i: HealthIssue) => (fix && !done.has(i.key) ? linkablePair(i) : null);
  const open = fix ? linkablePairs(report.issues).filter((p) => !done.has(p.key)) : [];
  const run = async (pairs: LinkPair[]) => {
    if (!fix || running.current || pairs.length === 0) return;
    running.current = true;
    setBusy(true);
    let message: string;
    let linked: string[] = [];
    try {
      const r = await fix.link(pairs);
      message = r.message;
      linked = r.done;
    } catch {
      message = LINK_UNREACHABLE;
    }
    running.current = false;
    if (!mounted.current) return;
    setDone((d) => new Set([...d, ...linked]));
    setResult(message);
    setBusy(false);
    fix.onFixed?.();
  };
  return (
    <div className="sfin-audit-body">
      {report.issues === null && report.notes.length === 0 && <div>{AUDIT_HEALTH_NOT_CHECKED}</div>}
      {report.issues && report.issues.length === 0 && !report.more && <div>{HEALTH_NONE}</div>}
      {report.issues && report.issues.length > 0 && (
        <ul className="sfin-audit-issues">
          {report.issues.map((i) => {
            const pair = pairOf(i);
            return (
              <li key={i.key} className="sfin-audit-issue">
                <div className="sfin-audit-head">{healthIssueTitle(i)}</div>
                {healthIssueLines(i).map((l, n) => <div key={n} className="sfin-subtle">{l}</div>)}
                {pair && (
                  <div className="sfin-audit-fix">
                    <Button variant="ghost" disabled={busy} aria-busy={busy} onClick={() => run([pair])}>{LINK_BUTTON}</Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {report.more ? <div className="sfin-subtle">and {report.more} more</div> : null}
      {open.length >= 2 && (
        <div className="sfin-audit-fix">
          <Button variant="ghost" disabled={busy} aria-busy={busy} onClick={() => run(open)}>{linkAllButton(open.length)}</Button>
        </div>
      )}
      {/* Mounted from the first render, so what lands in it is announced. */}
      {fix && <div role="status" className="sfin-subtle">{result ? `${result} ${AUDIT_AFTER_SYNC}` : ''}</div>}
      <AuditNotes notes={report.notes} />
    </div>
  );
}

/** Settings → Checks: what Health flags, and where the checks came from.
 *  R2: `link` adds Link; `onFixed` reads the snapshot again after a fix. */
export function ChecksCard({ link, onFixed, ...source }: AuditSource & Partial<HealthFix>) {
  return (
    <div className="sfin-audit-checks">
      <AuditBoundary read={source.read}>
        {source.read.kind === 'ok' && <HealthView report={source.read.snapshot.health} fix={link ? { link, onFixed } : undefined} />}
```

Edit 1 of 1 in `src/components/ui.tsx` — replace:

```tsx
.sfin-audit-link { padding: 0; border: none; background: transparent; color: var(--primary); font: inherit; font-size: var(--sfin-sz-sm); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
```

with:

```tsx
.sfin-audit-link { padding: 0; border: none; background: transparent; color: var(--primary); font: inherit; font-size: var(--sfin-sz-sm); cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
.sfin-audit-fix { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 4px; }
```

Edit 1 of 5 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
  /** 2c: the companion's audit snapshot, for the Checks card and the
   *  account chips. Absent (an older page): neither is shown. */
  auditSnapshot?: AuditSnapshotRead | null;
}
```

with:

```tsx
  /** 2c: the companion's audit snapshot, for the Checks card and the
   *  account chips. Absent (an older page): neither is shown. */
  auditSnapshot?: AuditSnapshotRead | null;
  /** 2c R2: after a fix on the Checks card, the page reads the snapshot again. */
  onAuditChanged?: () => void;
}
```

Edit 2 of 5 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
  accountMapping, balances, sfinNames, wfNames, telegramDraft, onAccountsChanged, auditSnapshot,
}: Props) {
```

with:

```tsx
  accountMapping, balances, sfinNames, wfNames, telegramDraft, onAccountsChanged, auditSnapshot, onAuditChanged,
}: Props) {
```

Edit 3 of 5 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
    : 'Not set';
  const [scheduleHours, setScheduleHours] = useState<number | null>(null);
```

with:

```tsx
    : 'Not set';
  // 2c R2: Link on the Checks card, through the add-on's own host.
  const linkChecks = useCallback((pairs: LinkPair[]) => linkFromApp(ctx, store, pairs), [ctx, store]);
  const [scheduleHours, setScheduleHours] = useState<number | null>(null);
```

Edit 4 of 5 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
import { undoFromApp } from '../utils/change-undo';
```

with:

```tsx
import { undoFromApp } from '../utils/change-undo';
import type { LinkPair } from '../../shared/audit-link';
import { linkFromApp } from '../utils/audit-fix';
```

Edit 5 of 5 in `src/tabs/SettingsTab.tsx` — replace:

```tsx
          <ChecksCard read={auditSnapshot} companionVersion={companionVersion} now={new Date()} />
```

with:

```tsx
          <ChecksCard
            read={auditSnapshot} companionVersion={companionVersion} now={new Date()}
            link={linkChecks} onFixed={onAuditChanged}
          />
```

Edit 1 of 2 in `src/pages/SyncPage.tsx` — replace:

```tsx
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
```

with:

```tsx
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  /** 2c R2: after a fix on the Checks card, read the snapshot again. Only the
   *  companion's next sync renews it, and the card says so. */
  const reloadAudit = useCallback(() => {
    store.getAuditSnapshot?.().then((r) => { if (mounted.current) setAuditSnapshot(r); }).catch(() => {});
  }, [store]);
```

Edit 2 of 2 in `src/pages/SyncPage.tsx` — replace:

```tsx
          telegramDraft={telegramDraft}
          auditSnapshot={auditSnapshot}
        />
```

with:

```tsx
          telegramDraft={telegramDraft}
          auditSnapshot={auditSnapshot}
          onAuditChanged={reloadAudit}
        />
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/utils/audit-fix.test.ts src/components/AuditFix.test.tsx src/pages/audit-fix-app.test.tsx src/components/AuditViews.test.tsx src/pages/audit-app.test.tsx src/pages/copy-policy.test.tsx src/components/theme-styles.test.ts src/tabs/SettingsTab.test.tsx src/pages/SyncPage.test.tsx`
Expected: PASS — 100 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/utils/audit-fix.test.ts src/components/AuditFix.test.tsx src/pages/audit-fix-app.test.tsx src/utils/audit-fix.ts src/components/AuditViews.tsx src/components/ui.tsx src/tabs/SettingsTab.tsx src/pages/SyncPage.tsx
git commit -m "Audits R2: Link on the app's Checks card — one at a time, said in a status line, the snapshot read again

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The app's story: Remove for good…, two clicks

Spec C2 in the app (Y3, Y6). `addonRemoveIo` lends `removeForGood` the SDK's exact-id read, the account mapping's feeds, the add-on's "linked" judgment (a reported group or the ledger confirms; else 2a's rule, so the app refuses any transfer leg nothing marks as unpaired), the add-on's secrets for the skip list, the SDK delete and the store's writer. `appTxStory` says when a story offers the action — `removal`: the row's id and its fingerprint as shown. In `TxStoryView` the first click explains in the exact words and offers Remove and Cancel; Remove runs once, its buttons disabled and busy, its result in a status line; a refusal re-reads the story so it shows what changed, a removal does not (the row is gone, which a re-read would call "changed since"). `useTxStoryActions` supplies `remove`, so Home's search, the needs-a-category list and the budget drill-down all get it.

**Files:**
- Modify: `src/utils/audit-fix.ts`, `src/utils/tx-story.ts`, `src/components/TxStory.tsx`, `src/components/ui.tsx`
- Create: `src/utils/audit-fix-remove.test.ts`, `src/utils/tx-story-remove.test.ts`, `src/components/TxStory-remove.test.tsx`

**Interfaces:**
- Consumes: Task 4 (`removeForGood`, `removalOffered`, `removalFingerprint`, the `REMOVE_*` copy, `RemoveIo`, `RemoveOutcome`); Task 8 (`FixStore` and `src/utils/audit-fix.ts`'s private `readFixRow`, `accountTypes`, `ledgerOf`, `ledgerKnows`, `warn`); `sfinIdsFor` (shared/tx-story.ts).
- Produces:

```ts
// src/utils/audit-fix.ts
export type FixStore = Partial<Pick<SecretsStore, 'readSyncOverrides' | 'getLinkedGroups' | 'setLinkedGroups' | 'recordChange' | 'getAccountMapping'>>;
export function addonRemoveIo(ctx: AddonContext, store: FixStore, log?: (msg: string) => void): RemoveIo;
export function removeFromApp(ctx: AddonContext, store: FixStore, activityId: string, fingerprint: string): Promise<RemoveOutcome>;
// src/utils/tx-story.ts — AppStoryOutcome's ok case gains: removal?: { activityId: string; fingerprint: string };
// src/components/TxStory.tsx — TxStoryActions gains: remove?: (activityId: string, fingerprint: string) => Promise<RemoveOutcome>;
//                             TxStoryView's props gain: removal?: { activityId: string; fingerprint: string };
```

- [ ] **Step 1: Write the failing tests**

**Create `src/utils/audit-fix-remove.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { SKIPPED_TRANSACTIONS_SECRET_KEY } from '../../shared/skipped-transactions';
import {
  removalFingerprint, REMOVE_DONE, REMOVE_NOT_FEED, REMOVE_SKIP_UNREADABLE, REMOVE_UNLINK_FIRST,
} from '../../shared/tx-remove';
import { removeFromApp, type FixStore } from './audit-fix';

type Row = Record<string, unknown> & { id: string; accountId: string };
const DUP: Row = {
  id: 'dup-1', accountId: 'wf-chk', accountName: 'PNC Checking', activityType: 'DEPOSIT', date: '2026-10-09T00:00:00.000Z', amount: '600',
  currency: 'USD', comment: 'MOBILE DEPOSIT · TRN-600', metadata: null,
};
const shown = (r: Row) => removalFingerprint({
  activityId: r.id, note: String(r.comment), absCents: 60000, date: '2026-10-09', activityType: String(r.activityType), accountName: 'PNC Checking',
});

/** The add-on SDK, in memory: the exact-id search, accounts, the bulk endpoint and the add-on's secrets. */
function fakeCtx(rows: Row[], secrets: Record<string, string> = {}) {
  const data = new Map(Object.entries(secrets));
  const ctx = {
    api: {
      accounts: { getAll: vi.fn(async () => [{ id: 'wf-chk', accountType: 'CASH' }]) },
      activities: {
        search: vi.fn(async (_page: number, _size: number, filters: { activityIds?: string[] }) => ({
          data: rows.filter((r) => filters.activityIds?.includes(r.id)), meta: { totalRowCount: 0 },
        })),
        saveMany: vi.fn(async () => ({ created: [], updated: [], errors: [] })),
      },
      secrets: {
        get: vi.fn(async (k: string) => data.get(k) ?? null),
        set: vi.fn(async (k: string, v: string) => { data.set(k, v); }),
      },
    },
  };
  return { ctx: ctx as any, data };
}
const fakeStore = (over: FixStore = {}): FixStore & Record<string, any> => ({
  getAccountMapping: vi.fn(async () => ({ 'sfin-chk': 'wf-chk' })),
  getLinkedGroups: vi.fn(async () => ({})),
  recordChange: vi.fn(async () => {}),
  ...over,
});

describe('Remove for good from the app', () => {
  it('skips it in the add-on’s secrets, deletes it through the SDK, and records it as yours', async () => {
    const f = fakeCtx([DUP]);
    const store = fakeStore();
    expect(await removeFromApp(f.ctx, store, 'dup-1', shown(DUP))).toEqual({ ok: true, message: REMOVE_DONE });
    expect(f.ctx.api.activities.search).toHaveBeenCalledWith(0, 1, { activityIds: ['dup-1'] }, '');
    expect(JSON.parse(f.data.get(SKIPPED_TRANSACTIONS_SECRET_KEY)!)).toEqual([expect.objectContaining({ account: 'sfin-chk', txId: 'TRN-600' })]);
    expect(f.ctx.api.activities.saveMany).toHaveBeenCalledWith({ deleteIds: ['dup-1'] });
    expect(store.recordChange).toHaveBeenCalledWith(expect.objectContaining({ actor: 'you', kind: 'transaction-removed' }));
  });

  it('refuses a transfer leg it cannot rule out as linked, and a row its ledger knows', async () => {
    const leg = { ...DUP, activityType: 'TRANSFER_OUT' };
    const f = fakeCtx([leg]);
    expect(await removeFromApp(f.ctx, fakeStore(), 'dup-1', shown(leg))).toEqual({ ok: false, message: REMOVE_UNLINK_FIRST });
    const g = fakeCtx([DUP]);
    expect(await removeFromApp(g.ctx, fakeStore({ getLinkedGroups: vi.fn(async () => ({ 'sfin-chk\u0000TRN-600': 'wf-transfer-1' })) }), 'dup-1', shown(DUP)))
      .toEqual({ ok: false, message: REMOVE_UNLINK_FIRST });
    expect(f.ctx.api.activities.saveMany).not.toHaveBeenCalled();
    expect(g.ctx.api.activities.saveMany).not.toHaveBeenCalled();
  });

  it('refuses a row in an account no feed maps to', async () => {
    const f = fakeCtx([DUP]);
    expect(await removeFromApp(f.ctx, fakeStore({ getAccountMapping: vi.fn(async () => ({ 'sfin-x': 'wf-other' })) }), 'dup-1', shown(DUP)))
      .toEqual({ ok: false, message: REMOVE_NOT_FEED });
  });

  it('deletes nothing when the skip list is corrupt', async () => {
    const f = fakeCtx([DUP], { [SKIPPED_TRANSACTIONS_SECRET_KEY]: '[{"account":1}]' });
    expect(await removeFromApp(f.ctx, fakeStore(), 'dup-1', shown(DUP))).toEqual({ ok: false, message: REMOVE_SKIP_UNREADABLE });
    expect(f.ctx.api.activities.saveMany).not.toHaveBeenCalled();
  });
});
```

**Create `src/utils/tx-story-remove.test.ts`:**

```ts
import { describe, it, expect, vi } from 'vitest';
import { removalFingerprint } from '../../shared/tx-remove';
import { appTxStory } from './tx-story';

const NOW = new Date('2026-10-14T15:00:00Z');
const row = (over: Record<string, unknown> = {}) => ({
  id: 'dup-1', accountId: 'wf-chk', accountName: 'PNC Checking', activityType: 'DEPOSIT', date: '2026-10-09T00:00:00.000Z', amount: '600',
  currency: 'USD', comment: 'MOBILE DEPOSIT · TRN-600', ...over,
});
const ctx = (r: Record<string, unknown>) => ({
  api: {
    activities: { search: vi.fn(async () => ({ data: [r], meta: { totalRowCount: 1 } })) },
    accounts: { getAll: vi.fn(async () => [{ id: 'wf-chk', name: 'PNC Checking', accountType: 'CASH' }]) },
  },
}) as any;
const store = { getAccountMapping: vi.fn(async () => ({ 'sfin-chk': 'wf-chk' })) };

describe('a story in the app offers "Remove for good…"', () => {
  it('on a row from the bank feed, carrying the row as shown', async () => {
    const out = await appTxStory(ctx(row()), store, { activityId: 'dup-1' }, NOW);
    expect(out.kind === 'ok' && out.removal).toEqual({
      activityId: 'dup-1',
      fingerprint: removalFingerprint({
        activityId: 'dup-1', note: 'MOBILE DEPOSIT · TRN-600', absCents: 60000, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking',
      }),
    });
  });

  it('not on a transfer leg whose other half it cannot see, nor a row typed by hand', async () => {
    const leg = await appTxStory(ctx(row({ activityType: 'TRANSFER_OUT' })), store, { activityId: 'dup-1' }, NOW);
    expect(leg.kind === 'ok' && leg.removal).toBeUndefined();
    const byHand = await appTxStory(ctx(row({ comment: 'Cash for rent' })), store, { activityId: 'dup-1' }, NOW);
    expect(byHand.kind === 'ok' && byHand.removal).toBeUndefined();
  });
});
```

**Create `src/components/TxStory-remove.test.tsx`:**

```tsx
import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { buildTxStory } from '../../shared/tx-story';
import { REMOVE_CHANGED, REMOVE_CONFIRM, REMOVE_DONE, REMOVE_UNREACHABLE, type RemoveOutcome } from '../../shared/tx-remove';
import { TxStoryView, type TxStoryActions } from './TxStory';

const EMOJI = /\p{Extended_Pictographic}/u;
const NOW = new Date('2026-10-14T15:00:00Z');
const story = buildTxStory({
  now: NOW,
  row: { activityId: 'dup-1', note: 'MOBILE DEPOSIT · TRN-600', absCents: 60000, date: '2026-10-09', activityType: 'DEPOSIT', accountName: 'PNC Checking' },
  feed: { sfinAccountId: 'sfin-chk' }, partner: null, history: [],
});
const REMOVAL = { activityId: 'dup-1', fingerprint: 'abcd1234' };
const view = (remove?: TxStoryActions['remove'], onChanged = vi.fn(), removal: typeof REMOVAL | null = REMOVAL) =>
  render(<TxStoryView story={story} entries={[]} actions={{ companionVersion: null, remove }} onChanged={onChanged} removal={removal ?? undefined} />);

describe('Remove for good… in the app', () => {
  it('is offered only with a remover and a row that qualifies', () => {
    view(vi.fn());
    expect(screen.getByRole('button', { name: 'Remove for good…' })).toBeInTheDocument();
  });

  it('is not offered without a remover, or for a row that does not qualify', () => {
    const { unmount } = view(undefined);
    expect(screen.queryByRole('button', { name: 'Remove for good…' })).toBeNull();
    unmount();
    view(vi.fn(), vi.fn(), null);
    expect(screen.queryByRole('button', { name: 'Remove for good…' })).toBeNull();
  });

  it('the first click explains in exact words; Cancel goes back; nothing is removed', () => {
    const remove = vi.fn();
    view(remove);
    fireEvent.click(screen.getByRole('button', { name: 'Remove for good…' }));
    expect(screen.getByText(REMOVE_CONFIRM)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(REMOVE_CONFIRM)).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove for good…' })).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
  });

  it('Remove acts once, busy while it runs, then says so and leaves nothing to click', async () => {
    let finish!: (o: RemoveOutcome) => void;
    const remove = vi.fn(() => new Promise<RemoveOutcome>((r) => { finish = r; }));
    const onChanged = vi.fn();
    const { container } = view(remove, onChanged);
    fireEvent.click(screen.getByRole('button', { name: 'Remove for good…' }));
    const go = screen.getByRole('button', { name: 'Remove' });
    fireEvent.click(go);
    fireEvent.click(go);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('dup-1', 'abcd1234');
    expect(go).toBeDisabled();
    expect(go).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await act(async () => { finish({ ok: true, message: REMOVE_DONE }); });
    expect(screen.getByText(REMOVE_DONE)).toBeInTheDocument();
    expect(container.querySelectorAll('.sfin-why-remove button')).toHaveLength(0);
    expect(onChanged).not.toHaveBeenCalled();
    expect(EMOJI.test(container.textContent ?? '')).toBe(false);
  });

  it('a refusal is said, the story is read again, and it can be tried again', async () => {
    const onChanged = vi.fn();
    view(vi.fn(async () => ({ ok: false, message: REMOVE_CHANGED })), onChanged);
    fireEvent.click(screen.getByRole('button', { name: 'Remove for good…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(REMOVE_CHANGED)).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Remove for good…' })).toBeInTheDocument();
  });

  it('a remover that throws says Wealthfolio could not be reached', async () => {
    view(vi.fn(async () => { throw new Error('offline'); }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove for good…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText(REMOVE_UNREACHABLE)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/utils/audit-fix-remove.test.ts src/utils/tx-story-remove.test.ts src/components/TxStory-remove.test.tsx`
Expected: FAIL — 10 of 12: the 4 app tests (`removeFromApp is not a function`), `on a row from the bank feed, carrying the row as shown` (no `removal`), and 5 of the 6 story tests (no "Remove for good…" button); `not on a transfer leg whose other half it cannot see, nor a row typed by hand` and `is not offered without a remover, or for a row that does not qualify` already pass.

- [ ] **Step 3: Implement**

Edit 1 of 5 in `src/utils/audit-fix.ts` — replace:

```ts
 * The add-on's half of the fixes (2c R2, spec C): what Link
 * (shared/audit-link.ts) reads and writes through the add-on SDK. Rows are
```

with:

```ts
 * The add-on's half of the fixes (2c R2, spec C): what Link
 * (shared/audit-link.ts) and Remove for good (shared/tx-remove.ts) read and
 * write through the add-on SDK. Rows are
```

Edit 2 of 5 in `src/utils/audit-fix.ts` — replace:

```ts
 * ledger too: it is how the add-on's sync knows to leave both legs as stored.
 * Every store method is optional-called.
 */
```

with:

```ts
 * ledger too: it is how the add-on's sync knows to leave both legs as stored.
 * Remove has no snapshot behind it, so a transfer-typed row nothing marks as
 * unpaired may be linked (the change log's own rule) and is refused.
 * Every store method is optional-called.
 */
```

Edit 3 of 5 in `src/utils/audit-fix.ts` — replace:

```ts
import { txIdFromComment } from '../../shared/sync-core';
import { AddonSyncHost } from './addon-host';
```

with:

```ts
import { txIdFromComment } from '../../shared/sync-core';
import { removeForGood, type RemoveIo, type RemoveOutcome } from '../../shared/tx-remove';
import { sfinIdsFor } from '../../shared/tx-story';
import { AddonSyncHost } from './addon-host';
```

Edit 4 of 5 in `src/utils/audit-fix.ts` — replace:

```ts
export type FixStore = Partial<Pick<SecretsStore,
  'readSyncOverrides' | 'getLinkedGroups' | 'setLinkedGroups' | 'recordChange'>>;
```

with:

```ts
export type FixStore = Partial<Pick<SecretsStore,
  'readSyncOverrides' | 'getLinkedGroups' | 'setLinkedGroups' | 'recordChange' | 'getAccountMapping'>>;
```

Edit 5 of 5 in `src/utils/audit-fix.ts` — replace:

```ts
/** Link from Settings → Checks. */
export function linkFromApp(ctx: AddonContext, store: FixStore, pairs: LinkPair[]): Promise<LinkRun> {
  return linkPairs(pairs, addonLinkIo(ctx, store));
}
```

with:

```ts
/** Link from Settings → Checks. */
export function linkFromApp(ctx: AddonContext, store: FixStore, pairs: LinkPair[]): Promise<LinkRun> {
  return linkPairs(pairs, addonLinkIo(ctx, store));
}

export function addonRemoveIo(ctx: AddonContext, store: FixStore, log: (msg: string) => void = warn): RemoveIo {
  const host = new AddonSyncHost(ctx);
  return {
    read: async (activityId) => readFixRow(ctx, activityId, await accountTypes(ctx)),
    feeds: async (wfAccountId) => sfinIdsFor((await store.getAccountMapping?.()) ?? {}, wfAccountId),
    linked: async (row, txKeys) => {
      const ledger = await ledgerOf(store);
      return linkedState(row, { readsGroups: false, ledgerKnows: ledgerKnows(ledger, txKeys, txIdFromComment(row.notes)) });
    },
    secrets: {
      get: (k) => ctx.api.secrets.get(k),
      set: (k, v) => ctx.api.secrets.set(k, v),
    },
    remove: async (activityId) => {
      const res = await host.saveMany({ deleteIds: [activityId] });
      if (res.errors.length > 0) throw new Error(res.errors.map((e) => e.message).join('; '));
    },
    record: async (draft) => {
      await store.recordChange?.(draft);
    },
    log,
  };
}

/** "Remove for good…" from a story in the app. */
export function removeFromApp(ctx: AddonContext, store: FixStore, activityId: string, fingerprint: string): Promise<RemoveOutcome> {
  return removeForGood(activityId, fingerprint, addonRemoveIo(ctx, store), new Date());
}
```

Edit 1 of 3 in `src/utils/tx-story.ts` — replace:

```ts
import {
  buildTxStory, decodeFiler, feedOf, sfinIdsFor, signedCents, withFilingDay, type TxFactName, type TxStory, type TxStoryFacts,
} from '../../shared/tx-story';
```

with:

```ts
import {
  buildTxStory, decodeFiler, feedOf, sfinIdsFor, signedCents, withFilingDay, type TxFactName, type TxStory, type TxStoryFacts,
} from '../../shared/tx-story';
import { removalFingerprint, removalOffered } from '../../shared/tx-remove';
```

Edit 2 of 3 in `src/utils/tx-story.ts` — replace:

```ts
  /** `entries`: the whole change log as read (Undo needs it); [] when unread. */
  | { kind: 'ok'; story: TxStory; entries: ChangeLogItem[] }
```

with:

```ts
  /** `entries`: the whole change log as read (Undo needs it); [] when unread.
   *  `removal` (2c R2): the story offers "Remove for good…" for this row, as shown. */
  | { kind: 'ok'; story: TxStory; entries: ChangeLogItem[]; removal?: { activityId: string; fingerprint: string } }
```

Edit 3 of 3 in `src/utils/tx-story.ts` — replace:

```ts
  return { kind: 'ok', story: buildTxStory(facts), entries };
}
```

with:

```ts
  return {
    kind: 'ok', story: buildTxStory(facts), entries,
    ...(removalOffered(facts) ? { removal: { activityId: row.id, fingerprint: removalFingerprint(facts.row) } } : {}),
  };
}
```

Edit 1 of 6 in `src/components/TxStory.tsx` — replace:

```tsx
 * a copy). Read-only otherwise: any change goes through that Undo.
```

with:

```tsx
 * a copy). Otherwise a story changes nothing — except "Remove for good…"
 * (2c R2), on a row from the bank feed: the first click explains, Remove
 * acts, one action at a time, and the result is said in a status line.
```

Edit 2 of 6 in `src/components/TxStory.tsx` — replace:

```tsx
import { EntryDetail, syncNowSentence, type RowActions } from './ChangeLogCard';
import { undoFromApp } from '../utils/change-undo';
```

with:

```tsx
import {
  REMOVE_ACTION, REMOVE_BUTTON, REMOVE_CANCEL, REMOVE_CONFIRM, REMOVE_UNREACHABLE, type RemoveOutcome,
} from '../../shared/tx-remove';
import { EntryDetail, syncNowSentence, type RowActions } from './ChangeLogCard';
import { Button } from './ui';
import { removeFromApp } from '../utils/audit-fix';
import { undoFromApp } from '../utils/change-undo';
```

Edit 3 of 6 in `src/components/TxStory.tsx` — replace:

```tsx
  onSyncNow?: () => Promise<string>;
}

/** The add-on's own Undo and Sync now — the same ones Settings → Change log uses. */
export function useTxStoryActions(ctx: AddonContext, store: SecretsStore, companionVersion: string | null): TxStoryActions {
  const undo = useCallback(
    (entry: ChangeLogItem, entries: ChangeLogItem[], op: UndoOp) => undoFromApp(ctx, store, entry, entries, op),
    [ctx, store],
  );
  const onSyncNow = useCallback(async () => syncNowSentence(await runSync(ctx, store, { force: true })), [ctx, store]);
  return useMemo(() => ({ undo, companionVersion, onSyncNow }), [undo, companionVersion, onSyncNow]);
}
```

with:

```tsx
  onSyncNow?: () => Promise<string>;
  /** 2c R2: "Remove for good…" (`removeFromApp`). Absent: never offered. */
  remove?: (activityId: string, fingerprint: string) => Promise<RemoveOutcome>;
}

/** The add-on's own Undo, Sync now and Remove for good — Undo and Sync now are the ones Settings → Change log uses. */
export function useTxStoryActions(ctx: AddonContext, store: SecretsStore, companionVersion: string | null): TxStoryActions {
  const undo = useCallback(
    (entry: ChangeLogItem, entries: ChangeLogItem[], op: UndoOp) => undoFromApp(ctx, store, entry, entries, op),
    [ctx, store],
  );
  const onSyncNow = useCallback(async () => syncNowSentence(await runSync(ctx, store, { force: true })), [ctx, store]);
  const remove = useCallback((activityId: string, fingerprint: string) => removeFromApp(ctx, store, activityId, fingerprint), [ctx, store]);
  return useMemo(() => ({ undo, companionVersion, onSyncNow, remove }), [undo, companionVersion, onSyncNow, remove]);
}

/** "Remove for good…": the first click explains, Remove acts. A refusal reads the story again. */
function RemoveForGood({ activityId, fingerprint, remove, onRefused }: {
  activityId: string;
  fingerprint: string;
  remove: NonNullable<TxStoryActions['remove']>;
  onRefused: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RemoveOutcome | null>(null);
  // One action per click, even before the re-render that disables the buttons.
  const running = useRef(false);
  // No state updates once the story is gone.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const act = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    let out: RemoveOutcome;
    try {
      out = await remove(activityId, fingerprint);
    } catch {
      out = { ok: false, message: REMOVE_UNREACHABLE };
    }
    running.current = false;
    if (!mounted.current) return;
    setResult(out);
    setBusy(false);
    setConfirming(false);
    if (!out.ok) onRefused();
  };
  return (
    <div className="sfin-why-remove">
      {confirming && <div>{REMOVE_CONFIRM}</div>}
      {!result?.ok && (
        <div className="sfin-audit-fix">
          {confirming ? (
            <>
              <Button variant="ghost" disabled={busy} aria-busy={busy} onClick={act}>{REMOVE_BUTTON}</Button>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>{REMOVE_CANCEL}</Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => { setResult(null); setConfirming(true); }}>{REMOVE_ACTION}</Button>
          )}
        </div>
      )}
      {/* Mounted from the first render, so what lands in it is announced. */}
      <div role="status" className="sfin-subtle">{result?.message ?? ''}</div>
    </div>
  );
}
```

Edit 4 of 6 in `src/components/TxStory.tsx` — replace:

```tsx
export function TxStoryView({ story, entries, actions, onChanged }: {
  story: TxStory;
  /** The change log as read: a line's entry, and what Undo is decided against. */
  entries: ChangeLogItem[];
  actions: TxStoryActions;
  /** After an Undo or a Sync now: read the story again. */
  onChanged: () => void;
}) {
```

with:

```tsx
export function TxStoryView({ story, entries, actions, onChanged, removal }: {
  story: TxStory;
  /** The change log as read: a line's entry, and what Undo is decided against. */
  entries: ChangeLogItem[];
  actions: TxStoryActions;
  /** After an Undo or a Sync now: read the story again. */
  onChanged: () => void;
  /** 2c R2: the row as shown, when the story offers "Remove for good…". */
  removal?: { activityId: string; fingerprint: string };
}) {
```

Edit 5 of 6 in `src/components/TxStory.tsx` — replace:

```tsx
          {story.answer.map((line, i) => <li key={`${i}:${line}`}>{line}</li>)}
        </ul>
      )}
```

with:

```tsx
          {story.answer.map((line, i) => <li key={`${i}:${line}`}>{line}</li>)}
        </ul>
      )}
      {removal && actions.remove && (
        <RemoveForGood activityId={removal.activityId} fingerprint={removal.fingerprint} remove={actions.remove} onRefused={onChanged} />
      )}
```

Edit 6 of 6 in `src/components/TxStory.tsx` — replace:

```tsx
        <TxStoryView story={shown.story} entries={shown.entries} actions={actions} onChanged={changed} />
```

with:

```tsx
        <TxStoryView story={shown.story} entries={shown.entries} actions={actions} onChanged={changed} removal={shown.removal} />
```

Edit 1 of 1 in `src/components/ui.tsx` — replace:

```tsx
.sfin-why-history { margin-top: 6px; }
```

with:

```tsx
.sfin-why-history { margin-top: 6px; }
.sfin-why-remove { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/utils/audit-fix-remove.test.ts src/utils/tx-story-remove.test.ts src/components/TxStory-remove.test.tsx src/utils/tx-story.test.ts src/components/TxStory.test.tsx src/components/WhyCard.test.tsx src/utils/audit-fix.test.ts src/pages/copy-policy.test.tsx src/components/theme-styles.test.ts`
Expected: PASS — 78 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/utils/audit-fix-remove.test.ts src/utils/tx-story-remove.test.ts src/components/TxStory-remove.test.tsx src/utils/audit-fix.ts src/utils/tx-story.ts src/components/TxStory.tsx src/components/ui.tsx
git commit -m "Audits R2: Remove for good… on the app's story — explain, then Remove or Cancel, one click at a time

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs, the forced-date run, every gate

The CHANGELOG under `[Unreleased]` (no version bump), the README's fixes, `docs/superpowers/follow-ups.md` §12 — what R2 deliberately leaves open (spec D3; Y11) — and ruling C-H's docs half (Y4): R1's remainder list, in `shared/audit-headline.ts`'s header and follow-ups §11, missed four cases — a categorized row in an account the Spending page doesn't read; an unlinked transfer filed under your own "Transfers" category; a grouped row that isn't a transfer; a next-month 00:00Z row west of UTC. Then every new test file once more with the system date forced to 2027-01-01 through a throwaway config, and all four gates under `nice`.

**Files:**
- Modify: `CHANGELOG.md`, `README.md`, `docs/superpowers/follow-ups.md`, `shared/audit-headline.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write the docs**

Edit 1 of 1 in `CHANGELOG.md` — replace:

```markdown
    taken and when it is out of date or unreadable. Home's Accounts tile
    points at the checks when there is something to look at.

### Fixed
```

with:

```markdown
    taken and when it is out of date or unreadable. Home's Accounts tile
    points at the checks when there is something to look at.
- **Audits without SSH — fix.** Two repairs that used to need the server's
  `fix-transfers.mjs` and `skip-transaction.mjs`, in Telegram and the app,
  each in the change log with Undo:
  - **Link.** On `/audit` → Health and on **Settings → Checks**, a transfer
    leg with exactly one likely other half shows that half and **Link**;
    with two or more, **Link all**. Both rows are read again right before
    anything is written, and nothing is linked if either changed, is linked
    (or may be), is pending, is one of the add-on's own rows, or is one you
    told the sync is not a transfer: "It has changed since — nothing was
    linked." The pair is linked by the sync's own linker; if Wealthfolio
    refuses the new pair, both rows are written back as they were. Money
    leaving a credit card can't be linked on Wealthfolio 3.8 or 3.9, and
    says so. Telegram shows Health again after each tap; the app's card shows
    a snapshot, so it says "Changes show here after the next sync."
  - **Remove for good…** on a transaction's story (`/why` and the app), for a
    row the bank reported twice. The first tap explains; **Remove** puts it
    on the skip list, then deletes it, so the bank feed never imports it
    again. Refused for half of a linked transfer ("Unlink it first."), a held
    transfer, a starting balance or a correction, a row not from the bank
    feed, a pending row, an unreadable skip list, and a row that changed
    since. Undo writes it back exactly and takes it off the skip list; Redo
    removes it again.
  - An older add-on reads a snapshot from a newer companion instead of
    calling it unreadable: a reason or a Health issue it doesn't know is left
    out — its amount counts as not explained, the issue under "and N more".

### Fixed
```

Edit 1 of 2 in `README.md` — replace:

```markdown
  Health page flags — checked live on every tap; `/status` puts a 🔎 under
  each account that is off.
- **Checks** (with the companion) — the same three explanations in the app:
  an account's "off by" chip in **Settings → Accounts** opens why in place,
  the Budget tab's "Why is this different from Wealthfolio?" breaks down the
  month, and **Settings → Checks** lists what Health flags, each with what to
  do. They come from a snapshot the companion publishes after each sync, and
  say when it was taken.
```

with:

```markdown
  Health page flags — checked live on every tap; `/status` puts a 🔎 under
  each account that is off. Health's list offers **Link** on a transfer with
  exactly one likely other half (**Link all** for two or more), and a story
  offers **Remove for good…** for a row the bank reported twice: it goes on
  the skip list and is deleted, so the bank feed never brings it back. Both
  are in the change log, with Undo.
- **Checks** (with the companion) — the same three explanations in the app:
  an account's "off by" chip in **Settings → Accounts** opens why in place,
  the Budget tab's "Why is this different from Wealthfolio?" breaks down the
  month, and **Settings → Checks** lists what Health flags, each with what to
  do, and **Link** for a transfer with one likely other half. They come from a
  snapshot the companion publishes after each sync, and say when it was
  taken; a fix shows there after the next sync. A transaction's story in the
  app offers **Remove for good…** too.
```

Edit 2 of 2 in `README.md` — replace:

```markdown
  links, removed duplicates, starting balances, corrections, filings and rules,
```

with:

```markdown
  links, removed duplicates, rows you removed for good, starting balances,
  corrections, filings and rules,
```

Edit 1 of 2 in `docs/superpowers/follow-ups.md` — replace:

```markdown
  named only west of UTC. What only one side counts for a rule no reason names
  stays in "not explained": a spending account the add-on does not map, a
  linked transfer filed under a spending category, a row Wealthfolio puts in
  another month other than at 00:00 UTC on the 1st (an east-of-UTC local
  midnight at the month's end, 3.10), an activity type override, the
  uncategorized reader's dismissed rows and rows awaiting a transfer's other
  half, and split lines. A card's opening debt is counted by the report (the
```

with:

```markdown
  named only west of UTC. What only one side counts for a rule no reason names
  stays in "not explained": a spending account the add-on does not map; a
  categorized row in a mapped account the Spending page does not read (the
  report counts it); a linked transfer filed under a spending category; an
  unlinked transfer filed under your own transfer-named category (the report
  drops the filing, Wealthfolio counts the transfer); a grouped row that is
  not a transfer (the uncategorized reader skips it, Wealthfolio counts it); a
  row Wealthfolio puts in another month other than at 00:00 UTC on this
  month's 1st (an east-of-UTC local midnight at the month's end, 3.10, and,
  west of UTC, a row stored at 00:00 UTC on the NEXT month's 1st, which
  Wealthfolio counts this month); an activity type override; the
  uncategorized reader's dismissed rows and rows awaiting a transfer's other
  half; and split lines. (R2 added the four this list missed: ruling C-H.)
  A card's opening debt is counted by the report (the
```

Edit 2 of 2 in `docs/superpowers/follow-ups.md` — replace:

```markdown
- **R2 (Fix) is next:** Link on a Health leg with a unique other half (the
  snapshot already carries both rows' ids, accounts, tx keys, amounts and
  dates), and "Remove for good…" on a transaction's story.

## Reference: name mismatches between the database, the REST API, and the SDK
```

with:

```markdown
- **R2 (Fix)** — Link and Remove for good — is §12.

## 12. Audits without SSH — R2 Fix (2026-10-14, plan `2026-10-14-audits-r2-fix.md`)

- **The linker deletes first.** Link goes through the sync's own
  `linkPairByRecreate`, which deletes both rows and then re-creates them as
  one marked group. A re-create Wealthfolio refuses wrote nothing (a bulk
  request is all or nothing), so R2 writes both rows back as they were and
  says so; a connection lost between the two requests can still leave them
  deleted until the next sync re-imports what the bank still sends. SDK
  3.9's `activities.linkTransfer` links in place and would close that window,
  but it needs new add-on permissions — Nick's call, not taken here.
- **Money leaving a card is not linked** unless the card already stores it as
  a TRANSFER_OUT (Wealthfolio 3.10): 3.8 and 3.9 accept no TRANSFER_OUT on a
  card (v1.55), and a WITHDRAWAL is never half of a valid pair.
- **The app links from a snapshot.** It re-reads both rows by id first. A
  transfer leg a link has marked since (Wealthfolio's own link stamps
  `flow.is_external: false`), or one whose metadata the host did not report,
  may be linked and is refused; a pair the card linked hides its button until
  the next snapshot.
- **Remove for good refuses a pending row**: SimpleFin often gives a pending
  transaction a new id when it posts, so skipping the pending id would not
  keep the posted copy out.
- **The app refuses to remove any transfer leg** nothing marks as unpaired
  (the change log's own "may be linked" rule): the SDK cannot be counted on
  to report groups. `/why`, which reads them, can remove an unlinked one.
- **Remove's Undo writes the row back as the bank feed wrote it.** A category
  filed on it is not part of the row and does not come back.
- **The exact-id read is Wealthfolio 3.8's** (`activityIds` / `activityIdFilter`);
  an older host ignores it, and a fix then reads the row as changed and
  writes nothing.
- **The add-on's `linked_groups`** is re-read right before Link adds a pair;
  an add-on sync finishing in the same moment can still write its older copy,
  and the add-on's sync then treats the pair as one it did not link — as it
  does a pair the companion linked.
- **Link all covers what the list shows**: 20 issues in Telegram, what fits
  the snapshot in the app.
- **A link you make is undone like the sync's** (`notTransfer` on both legs,
  carried out by the next sync), so the app's "Update the companion first"
  gate now covers a transfer link whoever made it.
- **Ruling C-H's residuals are done**: an unknown reason or Health issue kind
  is dropped, not read as a corrupt snapshot; `more` must be a number; §11's
  remainder list names the four cases it missed.

## Reference: name mismatches between the database, the REST API, and the SDK
```

Edit 1 of 1 in `shared/audit-headline.ts` — replace:

```ts
 * unexplainedCents = (report − Wealthfolio) − Σ reasons. A row only one side
 * counts for a rule no reason names stays in it: an account the report does
 * not cover, a linked transfer or a transfer-named category the report still
 * files, a row Wealthfolio puts in another month other than at 00:00 UTC on
 * the 1st, and what this does not model — split lines (the add-on never
 * writes them), an activity type override, and the uncategorized reader's
 * dismissed rows and rows awaiting a transfer's other half.
```

with:

```ts
 * unexplainedCents = (report − Wealthfolio) − Σ reasons. A row only one side
 * counts for a rule no reason names stays in it: an account the report does
 * not cover; a categorized row in a mapped account the Spending page does not
 * read (the report counts it); a linked transfer the report still files under
 * a spending category; an unlinked transfer filed under your own
 * transfer-named category (the report drops the filing, Wealthfolio counts
 * the transfer); a grouped row that is not a transfer (the uncategorized
 * reader skips it, Wealthfolio counts it); a row Wealthfolio puts in another
 * month other than at 00:00 UTC on this month's 1st — among them, west of
 * UTC, a row stored at 00:00 UTC on the NEXT month's 1st, which Wealthfolio
 * counts this month; and what this does not model — split lines (the add-on
 * never writes them), an activity type override, and the uncategorized
 * reader's dismissed rows and rows awaiting a transfer's other half.
```

- [ ] **Step 2: Run every new test file with the date forced to 2027-01-01**

Nothing may depend on the real clock. A throwaway setup file fakes `Date` before every test; delete it afterwards — none of it is committed.

```sh
cat > zz-2027.setup.ts <<'EOF'
import { beforeEach, vi } from 'vitest';
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2027-01-01T12:00:00Z')); });
EOF
cp zz-2027.setup.ts companion/zz-2027.setup.ts
cat > zz-2027.config.mts <<'EOF'
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'jsdom', globals: true, setupFiles: ['./src/test-setup.ts', './zz-2027.setup.ts'] } });
EOF
cat > companion/zz-2027.config.mts <<'EOF'
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { globals: true, setupFiles: ['./zz-2027.setup.ts'] } });
EOF
npx vitest run --config zz-2027.config.mts shared/audit-snapshot.test.ts shared/change-undo-remove.test.ts shared/fix-row.test.ts shared/audit-link.test.ts shared/tx-remove.test.ts src/utils/audit-fix.test.ts src/utils/audit-fix-remove.test.ts src/utils/tx-story-remove.test.ts src/components/AuditFix.test.tsx src/components/TxStory-remove.test.tsx src/pages/audit-fix-app.test.tsx
(cd companion && npx vitest run --config zz-2027.config.mts src/audit-fix-host.test.ts src/audit-menu-link.test.ts src/why-menu-remove.test.ts)
(cd companion && npx vitest run --config zz-2027.config.mts src/index.test.ts -t "Link on the Health list|Remove on a story")
rm zz-2027.setup.ts zz-2027.config.mts companion/zz-2027.setup.ts companion/zz-2027.config.mts
git status --short
```

Expected: PASS — 112 tests (root), 17 tests (companion), and 2 passed with 292 skipped (`index.test.ts`'s two R2 tests); `git status --short` prints nothing. (`index.test.ts` as a whole is not run here: seven of its older tests compute a timestamp from the real clock at import and fail under a forced date on the base branch too — 7 of 292 at ece1902.)

- [ ] **Step 3: Run every gate**

Run: `nice npm test`
Expected: PASS — 2617 tests.

Run: `nice npm --prefix companion test`
Expected: PASS — 1138 tests.

Run: `nice npm run type-check`
Expected: Succeeds.

Run: `nice npm --prefix companion run build`
Expected: Succeeds.

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md README.md docs/superpowers/follow-ups.md shared/audit-headline.ts
git commit -m "Audits R2: docs — the CHANGELOG's fixes, the README, follow-ups §12, and R1's remainder list completed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
