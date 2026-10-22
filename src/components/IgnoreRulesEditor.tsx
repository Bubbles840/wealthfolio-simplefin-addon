import React, { useMemo, useState } from 'react';
import type { SimplefinAccount, SimplefinTransaction } from '../../shared/types';
import {
  findIgnored, ignoreRuleProblem, IGNORE_PROBLEM_TEXT, IGNORE_UPDATE_COMPANION, sameIgnoreRule, withIgnoreRule, withoutIgnoreRule,
  type IgnoreRule,
} from '../../shared/ignore-rules';
import { companionUnderstandsIgnoreRules } from '../../shared/version';
import { Button, ErrorBox, Input, Select } from './ui';

/** The account select's value for a rule with no account. Never the default:
 *  a rule that reads every account can drop the other side of a real transfer
 *  (SimpleFin gives both sides one id), so it is a choice made on purpose. */
export const ALL_ACCOUNTS = '*';

/** How far back the preview reads. One SimpleFin request, made only when asked. */
export const PREVIEW_DAYS = 30;

/** Rows shown under the preview count; the rest are counted, not listed. */
const PREVIEW_ROWS = 12;

interface Props {
  rules: IgnoreRule[];
  /** The mapped accounts (`ruleAccountOptions`): the only ones a rule reaches.
   *  `aliases` are ids a confirmed re-link retired in favour of this one; a rule
   *  saved on one belongs here. */
  accounts: Array<{ id: string; name: string; aliases?: string[] }>;
  /** Saves the whole list. Rejects with the reason when nothing was saved. */
  onChange: (next: IgnoreRule[]) => Promise<void>;
  /** The last `days` of the feed, for the preview, with whatever errors
   *  SimpleFin reported alongside it. Absent: no preview. */
  loadFeed?: (days: number) => Promise<{ accounts: SimplefinAccount[]; errors: string[] }>;
  /** The connected companion's version, null when none is connected. An older
   *  companion's syncs keep importing the rows these rules ignore, so rules
   *  can't be added until it is updated. */
  companionVersion?: string | null;
  /** The stored list could not be read: shown read-only, since saving over it
   *  would drop the rules that were not understood. */
  unreadable?: boolean;
}

const describeRule = (r: IgnoreRule) => `${r.matchType} “${r.pattern}”`;

const txDay = (tx: SimplefinTransaction): string => {
  const at = tx.posted || tx.transacted_at;
  if (!at) return '—';
  const d = new Date(at * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Ignore rules (shared/ignore-rules.ts): bank transactions never to import, by
 * description. For rows that only move money inside one account — a brokerage
 * cash account's core-fund sweeps — which never cancel in a Transactions-mode
 * ledger and push its value far above the bank's balance.
 *
 * Deliberately unlike RuleEditor: nothing is saved until a rule is complete,
 * valid and confirmed. RuleEditor's "+ Add rule" stores an empty Deposit rule
 * at once, and an empty pattern matches everything; here that would hide every
 * transaction, so a blank rule is never written.
 */
export function IgnoreRulesEditor({ rules, accounts, onChange, loadFeed, companionVersion = null, unreadable = false }: Props) {
  const [matchType, setMatchType] = useState<'contains' | 'regex'>('contains');
  const [pattern, setPattern] = useState('');
  const [account, setAccount] = useState('');
  const [note, setNote] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feed, setFeed] = useState<SimplefinAccount[] | null>(null);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedError, setFeedError] = useState('');
  const [feedWarnings, setFeedWarnings] = useState<string[]>([]);

  /** The option an id belongs to: its own, or the one that replaced it (a confirmed re-link). */
  const canonical = useMemo(() => {
    const of = new Map<string, string>();
    for (const a of accounts) {
      of.set(a.id, a.id);
      for (const alias of a.aliases ?? []) of.set(alias, a.id);
    }
    return (id: string | undefined) => (id ? of.get(id) ?? id : undefined);
  }, [accounts]);
  const accountName = (id: string | undefined) =>
    !id ? 'All synced accounts' : accounts.find((a) => a.id === canonical(id))?.name ?? id;

  const draftBlank = pattern.trim() === '';
  const problem = draftBlank ? null : ignoreRuleProblem({ pattern, matchType });
  const draft: IgnoreRule | null = draftBlank || problem ? null : {
    pattern: pattern.trim(),
    matchType,
    ...(account && account !== ALL_ACCOUNTS ? { account } : {}),
    ...(note.trim() ? { note: note.trim() } : {}),
  };
  const duplicate = !!draft && account !== '' && rules.some((r) =>
    sameIgnoreRule({ ...r, account: canonical(r.account) }, { ...draft, account: canonical(draft.account) }));
  const companionBehind = !companionUnderstandsIgnoreRules(companionVersion);
  const canAdd = !!draft && account !== '' && !duplicate && !unreadable && !companionBehind && !busy;

  const resetDraft = () => {
    setPattern('');
    setNote('');
    setAccount('');
    setMatchType('contains');
    setConfirming(false);
  };

  const save = async (next: IgnoreRule[], after: () => void) => {
    setBusy(true);
    setError('');
    try {
      await onChange(next);
      after();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const confirmAdd = () => {
    if (!draft || !canAdd) return;
    let next: IgnoreRule[];
    try {
      next = withIgnoreRule(rules, draft);
    } catch (e: any) {
      setError(String(e?.message ?? e));
      return;
    }
    void save(next, resetDraft);
  };

  const confirmRemove = (i: number) => {
    void save(withoutIgnoreRule(rules, i), () => setRemoving(null));
  };

  const loadPreview = async () => {
    if (!loadFeed) return;
    setFeedLoading(true);
    setFeedError('');
    try {
      const read = await loadFeed(PREVIEW_DAYS);
      setFeed(read.accounts);
      setFeedWarnings(read.errors);
    } catch (e: any) {
      setFeedError(String(e?.message ?? e) || 'Could not reach SimpleFin');
    } finally {
      setFeedLoading(false);
    }
  };

  // The preview follows the draft as it is typed (the feed is read once); with
  // no draft it shows what the saved rules leave out.
  // A retired id is left out, as the sync leaves it out even if it reports.
  const isMapped = useMemo(() => {
    const ids = new Set(accounts.map((a) => a.id));
    return (id: string) => ids.has(id);
  }, [accounts]);
  const sameAccount = (ruleAccount: string, sfAccountId: string) => canonical(ruleAccount) === canonical(sfAccountId);
  const previewRules = draft ? [draft] : draftBlank ? rules : [];
  const scopeId = draft ? draft.account : undefined;
  const inScope = feed
    ? feed.filter((a) => isMapped(a.id) && (!scopeId || sameAccount(scopeId, a.id)))
        .reduce((n, a) => n + (a.transactions?.length ?? 0), 0)
    : 0;
  const hits = feed ? findIgnored(previewRules, feed, isMapped, sameAccount) : [];

  return (
    <div>
      <p className="sfin-subtle" style={{ fontSize: 12, marginTop: 0 }}>
        For rows that only move money inside one account, like a brokerage cash account&rsquo;s
        sweeps into and out of its core fund. A Transactions-mode account counts every row as
        cash moving, so those rows add up and the balance drifts far from the bank&rsquo;s.
        Ignoring a real payment makes the balance differ from the bank&rsquo;s by that amount, and
        the balance-drift alert will say so. Rows already imported stay until you delete them
        in Wealthfolio.
      </p>

      {unreadable && (
        <ErrorBox>
          Your saved ignore rules can&rsquo;t be read, so they can&rsquo;t be changed here: saving
          would drop the rules that weren&rsquo;t understood. The sync ignores nothing until this
          is fixed.
        </ErrorBox>
      )}

      {companionBehind && (
        <div className="sfin-log-note" role="status" style={{ marginBottom: 8 }}>{IGNORE_UPDATE_COMPANION}</div>
      )}

      {rules.length === 0 && !unreadable && (
        <div className="sfin-subtle" style={{ marginBottom: 8 }}>No ignore rules. Every transaction is imported.</div>
      )}
      {rules.map((rule, i) => (
        <div key={`${rule.matchType}:${rule.pattern}:${rule.account ?? ''}`} data-testid="ignore-rule"
          style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <strong>{describeRule(rule)}</strong>
            <span className="sfin-subtle"> · {accountName(rule.account)}{rule.note ? ` · ${rule.note}` : ''}</span>
          </span>
          {removing === i ? (
            <>
              <Button variant="destructive" onClick={() => confirmRemove(i)} disabled={busy}>
                Yes, import these again
              </Button>
              <Button variant="ghost" onClick={() => setRemoving(null)} disabled={busy}>Cancel</Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => { setRemoving(i); setConfirming(false); }}
              aria-label={`Remove ignore rule ${describeRule(rule)}`} disabled={unreadable || busy}>✕</Button>
          )}
        </div>
      ))}

      {!unreadable && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <Select aria-label="Match type" value={matchType}
              onChange={(e) => { setMatchType(e.target.value as 'contains' | 'regex'); setConfirming(false); }}>
              <option value="contains">contains</option>
              <option value="regex">regex</option>
            </Select>
            <Input aria-label="Description pattern" value={pattern} placeholder="e.g. SWEEP FROM CORE FUND"
              onChange={(e) => { setPattern(e.target.value); setConfirming(false); }} style={{ flex: 1, minWidth: 200 }} />
            <Select aria-label="Account" value={account}
              onChange={(e) => { setAccount(e.target.value); setConfirming(false); }}>
              <option value="" disabled>Choose an account…</option>
              <option value={ALL_ACCOUNTS}>All synced accounts</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6, flexWrap: 'wrap' }}>
            <Input aria-label="Note" value={note} placeholder="Note (optional), e.g. core fund sweeps"
              onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
            {!confirming && (
              <Button variant="outline" disabled={!canAdd} onClick={() => { setConfirming(true); setRemoving(null); }}>
                Add rule…
              </Button>
            )}
          </div>
          {problem && <div className="sfin-log-note" role="alert" style={{ marginTop: 6 }}>{IGNORE_PROBLEM_TEXT[problem]}</div>}
          {duplicate && <div className="sfin-subtle" style={{ marginTop: 6 }}>You already have this rule.</div>}

          {confirming && draft && (
            <div className="sfin-callout" style={{ marginTop: 8 }} data-testid="ignore-confirm">
              <div>
                Never import a transaction in <b>{accountName(draft.account)}</b> whose description{' '}
                {draft.matchType === 'regex' ? 'matches' : 'contains'} <b>&ldquo;{draft.pattern}&rdquo;</b>?
                Rows already imported stay; delete them in Wealthfolio.
              </div>
              <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
                <Button onClick={confirmAdd} disabled={busy || companionBehind}>Yes, ignore these</Button>
                <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
      )}

      {error && <div style={{ marginTop: 8 }}><ErrorBox>{error}</ErrorBox></div>}

      {loadFeed && (
        <div style={{ marginTop: 16 }}>
          <Button variant="ghost" onClick={() => void loadPreview()} disabled={feedLoading}>
            {feedLoading ? 'Reading SimpleFin…' : feed ? 'Read SimpleFin again' : `Preview last ${PREVIEW_DAYS} days`}
          </Button>
          {feedError && <ErrorBox>{feedError}</ErrorBox>}
          {feed && feedWarnings.length > 0 && (
            <div className="sfin-log-note" role="status" style={{ marginTop: 8 }}>
              SimpleFin reported: {feedWarnings.join('; ')}. The counts below may be missing an institution.
            </div>
          )}
          {feed && (
            <div data-testid="ignore-preview" style={{ marginTop: 8 }}>
              {previewRules.length === 0 ? (
                !problem && <div className="sfin-subtle">Type a pattern to see what it would leave out.</div>
              ) : (
                <>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>
                    {draft ? 'This rule matches' : 'Your rules match'} {hits.length} of {inScope} transaction{inScope === 1 ? '' : 's'} in the last {PREVIEW_DAYS} days.
                  </div>
                  {hits.length > 0 && (
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ fontSize: 12, borderCollapse: 'collapse', marginTop: 4 }}>
                        <tbody>
                          {hits.slice(0, PREVIEW_ROWS).map(({ account: acc, tx }) => (
                            <tr key={`${acc.id}:${tx.id}`}>
                              <td style={{ paddingRight: 12, whiteSpace: 'nowrap' }}>{txDay(tx)}</td>
                              <td style={{ paddingRight: 12, textAlign: 'right', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{tx.amount}</td>
                              <td style={{ paddingRight: 12 }}>{tx.description}</td>
                              {!scopeId && <td className="sfin-subtle" style={{ whiteSpace: 'nowrap' }}>{accountName(acc.id)}</td>}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {hits.length > PREVIEW_ROWS && (
                    <div className="sfin-subtle" style={{ fontSize: 12 }}>+{hits.length - PREVIEW_ROWS} more</div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
