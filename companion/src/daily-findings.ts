/**
 * companion/src/daily-findings.ts
 *
 * Everything the morning report's "Needs attention" block is made of, gathered
 * in one place so the report and the Telegram "Show what to fix" button judge
 * the SAME findings. Before 1.57.0 this lived inline in index.ts's digest
 * composer; the button needs it too, and a second copy is how the two would
 * come to disagree about what is wrong.
 *
 * Every dependency is injected (secrets, database, versions, log). index.ts is
 * the daemon entry point and imports this module, so this one cannot import it
 * back — and injected dependencies are also what lets the button's path be
 * tested without a running Wealthfolio.
 */
import { evaluateSelfCheck, type SelfCheckFinding } from '../../shared/self-check.js';
import { evaluateLedgerChecks, nextLedgerCheckSeen, type LedgerCheckSeen, type LedgerFacts } from '../../shared/ledger-checks.js';
import { FINDING_SNOOZES_SECRET_KEY, parseSnoozes, partitionSnoozed, activeSnoozes } from '../../shared/findings.js';
import { ADDON_VERSION_SECRET_KEY } from '../../shared/version.js';
import type { SyncHealth } from '../../shared/telegram.js';

export const LEDGER_CHECK_SEEN_SECRET_KEY = 'ledger_check_seen';

export interface FindingsDeps {
  /** One addon secret, or null when absent. MAY throw: an unreadable secret is
   *  information (see `readSyncHealth`), so the caller decides what it means. */
  getSecret(key: string): Promise<string | null>;
  setSecret(key: string, value: string): Promise<void>;
  /** The version in the installed addon's manifest on disk, or null. */
  installedAddonVersion(): string | null;
  companionVersion: string;
  /** The row-level audit's facts, given each mapped Wealthfolio account's bank
   *  balance and the transfer legs the sync gave up linking; null when the
   *  database cannot be read. */
  ledgerFacts(bankByWfId: Map<string, number | null>, now: Date, stuckTxIds: string[]): LedgerFacts | null;
  log(msg: string): void;
}

/** Account balances as the sync stores them: `date` is Unix seconds; `drift`
 *  is bank − Wealthfolio, set only past the alert threshold. */
interface StoredAccountBalance {
  balance?: number;
  date?: number;
  drift?: number | null;
  driftSince?: string | null;
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * The sync-health record, keeping an unreadable secret DISTINGUISHABLE from a
 * missing one: the self-check reports those differently, because "could not
 * check" must never render as a clean bill of health.
 */
export async function readSyncHealth(
  deps: Pick<FindingsDeps, 'getSecret'>,
): Promise<{ health: SyncHealth | null; healthUnreadable: boolean }> {
  try {
    return { health: parseJson<SyncHealth>(await deps.getSecret('sync_health')), healthUnreadable: false };
  } catch {
    return { health: null, healthUnreadable: true };
  }
}

export interface GatheredFindings {
  /** Shown today, most severe first. */
  visible: SelfCheckFinding[];
  /** True right now, but snoozed by the user. */
  snoozed: SelfCheckFinding[];
}

/**
 * Judges everything: the sync-health checks and the row-level ledger audit,
 * minus whatever the user snoozed.
 *
 * `recordLedgerChecks` is true only for the scheduled report. The ledger audit
 * remembers when each condition was first seen so a "say once" finding is said
 * once; a preview (the Reports tab's live edition) or a button tap must not
 * stamp that memory, or it would age a finding out before the report that is
 * supposed to carry it ever went out.
 *
 * Never throws for a ledger problem: a checker that cannot check must not cost
 * the user the report it exists to improve.
 */
export async function gatherFindings(
  deps: FindingsDeps,
  now: Date,
  opts: { recordLedgerChecks: boolean; health: SyncHealth | null; healthUnreadable: boolean },
): Promise<GatheredFindings> {
  const read = <T>(key: string) => deps.getSecret(key).then((raw) => parseJson<T>(raw)).catch(() => null);

  const unmapped = await read<Array<{ accountName?: string; sfinAccountId?: string }>>('unmapped_accounts') ?? [];
  const balances = await read<Record<string, StoredAccountBalance>>('account_balances') ?? {};
  const accountNames = await read<Record<string, string>>('account_names') ?? {};
  const mapping = await read<Record<string, string>>('account_mapping') ?? {};

  // The row-level audit. Balances agreeing with the bank was never enough:
  // every shape a row can take moves the same cash, so a reconciled ledger can
  // still count the user's own money as income. Judged FIRST because it also
  // says which accounts are cards, whose balance it checks itself.
  let ledgerFindings: SelfCheckFinding[] = [];
  const cardWfIds = new Set<string>();
  try {
    const bankByWfId = new Map<string, number | null>();
    for (const [sfinId, wfId] of Object.entries(mapping)) {
      const balance = balances[sfinId]?.balance;
      bankByWfId.set(wfId, typeof balance === 'number' ? balance : null);
    }
    // Legs the sync failed to link three times — what its separate "Transfer
    // stuck" alert announced before the daily report carried it (1.57.1).
    const failures = await read<Record<string, { alerted?: boolean }>>('transfer_link_failures') ?? {};
    const stuckTxIds = Object.entries(failures).filter(([, e]) => e?.alerted === true).map(([txId]) => txId);
    const facts = deps.ledgerFacts(bankByWfId, now, stuckTxIds);
    if (facts) {
      // Only the cards `card-balance` can actually judge: one with a
      // transfer in flight (or no bank figure) is skipped there, so the
      // sync's own drift measure stays its voice.
      for (const c of facts.cardBalances) if (c.wfId && !c.inFlight && c.bank !== null) cardWfIds.add(c.wfId);
      const seen = await read<LedgerCheckSeen>(LEDGER_CHECK_SEEN_SECRET_KEY) ?? {};
      const judged = evaluateLedgerChecks(facts, seen, now);
      ledgerFindings = judged.findings;
      const next = nextLedgerCheckSeen(seen, judged.keys, now);
      // Written only when it changed: most mornings nothing did, and a secret
      // write a day for no reason is a write that can fail for no reason.
      if (opts.recordLedgerChecks && JSON.stringify(next) !== JSON.stringify(seen)) {
        await deps.setSecret(LEDGER_CHECK_SEEN_SECRET_KEY, JSON.stringify(next)).catch(() => {});
      }
    }
  } catch (err) {
    deps.log(`Ledger checks skipped: ${err instanceof Error ? err.message : String(err)}`);
  }

  const selfCheckFindings = evaluateSelfCheck({
    lastSuccessAt: opts.health?.lastSuccessAt ?? null,
    firstFailedAt: opts.health?.firstFailedAt ?? null,
    lastError: opts.health?.lastError ?? null,
    healthUnreadable: opts.healthUnreadable,
    // Raw string secret, not JSON — written by the addon on load, absent on
    // zips older than 1.34.0 (the self-check stays quiet on absence).
    addonVersion: await deps.getSecret(ADDON_VERSION_SECRET_KEY).catch(() => null),
    // Off disk, because the secret above only says what last RAN in a browser.
    installedAddonVersion: deps.installedAddonVersion(),
    companionVersion: deps.companionVersion,
    unmappedAccountNames: (Array.isArray(unmapped) ? unmapped : [])
      .map((a) => a?.accountName || a?.sfinAccountId || '')
      .filter((n) => n !== ''),
    accounts: Object.entries(balances).map(([id, info]) => ({
      id,
      name: accountNames[id] ?? id,
      balanceDate: typeof info?.date === 'number' ? info.date : null,
      // Since 1.57 the daily report carries what the separate drift alert
      // said. Not for the cards `card-balance` above already judges.
      drift: cardWfIds.has(mapping[id]) ? null : info?.drift ?? null,
      driftSince: info?.driftSince ?? null,
    })),
  }, now);

  const all = [...selfCheckFindings, ...ledgerFindings];
  const snoozes = parseSnoozes(await deps.getSecret(FINDING_SNOOZES_SECRET_KEY).catch(() => null));
  return partitionSnoozed(all, snoozes, now);
}

/** Reads, edits and writes the snooze secret, pruning expired entries on the
 *  way through. A read failure is NOT treated as empty here: writing `{}` plus
 *  one new key over an unreadable store would silently un-snooze everything. */
export async function updateSnoozes(
  deps: Pick<FindingsDeps, 'getSecret' | 'setSecret'>,
  now: Date,
  edit: (current: Record<string, string>) => Record<string, string>,
): Promise<void> {
  const current = activeSnoozes(parseSnoozes(await deps.getSecret(FINDING_SNOOZES_SECRET_KEY)), now);
  await deps.setSecret(FINDING_SNOOZES_SECRET_KEY, JSON.stringify(edit(current)));
}
