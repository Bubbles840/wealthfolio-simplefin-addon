import React, { useEffect, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import type { SimplefinAccount, AccountMapping } from '../../shared/types';
import type { LoanLinks } from '../../shared/loan-balances';
import { companionUnderstandsLoanBalances, LOAN_BALANCES_SINCE } from '../../shared/version';
import { Button, ErrorBox, Select } from './ui';

interface Props {
  ctx: AddonContext;
  simplefinAccounts: SimplefinAccount[];
  initialMapping: AccountMapping;
  /** Loan accounts already linked to a Wealthfolio loan (shared/loan-balances.ts). */
  initialLoanLinks?: LoanLinks;
  /** The connected companion's version, or null for none: loans are offered
   *  only when it reads loan links (`LOAN_BALANCES_SINCE`). */
  companionVersion?: string | null;
  onSave: (mapping: AccountMapping, loanLinks: LoanLinks) => void;
  /** After a Wealthfolio account is created here — for the change log. */
  onAccountCreated?: (created: { sfinId: string; wfId: string; name: string; accountType: string }) => void;
}

const CREATE_NEW_VALUE = '__create_new__';
/** A loan option's value: the prefix, then the liability's asset id. */
const LOAN_PREFIX = 'loan:';

const ACCOUNT_TYPE_OPTIONS = [
  { type: 'CASH', label: 'Bank / Cash' },
  { type: 'CREDIT_CARD', label: 'Credit Card' },
  { type: 'SECURITIES', label: 'Investment' },
] as const;

type CreatableAccountType = (typeof ACCOUNT_TYPE_OPTIONS)[number]['type'];

export function AccountMapper({ ctx, simplefinAccounts, initialMapping, initialLoanLinks = {}, companionVersion = null, onSave, onAccountCreated }: Props) {
  const [wfAccounts, setWfAccounts] = useState<Array<{ id: string; name: string }>>([]);
  /** null until read, and when they could not be: a link is then never called
   *  gone, and never dropped. */
  const [loans, setLoans] = useState<Array<{ id: string; name: string }> | null>(null);
  /** An account mapped to a Wealthfolio account, about to become a loan: its
   *  imports stop, so that is confirmed first. */
  const [pendingLoan, setPendingLoan] = useState<{ sfinId: string; value: string } | null>(null);
  const loansOffered = companionUnderstandsLoanBalances(companionVersion);
  const [mapping, setMapping] = useState<AccountMapping>(initialMapping);
  const [loanLinks, setLoanLinks] = useState<LoanLinks>(initialLoanLinks);
  const [loadError, setLoadError] = useState('');
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [createErrors, setCreateErrors] = useState<Record<string, string>>({});
  const [pendingTypeChoice, setPendingTypeChoice] = useState<string | null>(null);

  useEffect(() => {
    ctx.api.accounts.getAll()
      .then(setWfAccounts)
      .catch((e: any) => setLoadError(e.message ?? 'Failed to load accounts'));
    // Loans are optional: a host without alternative assets offers none.
    Promise.resolve()
      .then(() => ctx.api.alternativeAssets.getAll())
      .then((all) => setLoans(all.filter((a) => a.kind === 'liability').map((a) => ({ id: a.id, name: a.name }))))
      .catch(() => setLoans(null));
  }, [ctx]);

  const handleSelect = (sfin: SimplefinAccount, value: string, confirmed = false) => {
    if (value === CREATE_NEW_VALUE) {
      // Don't create yet — ask what kind of account this is first
      setPendingTypeChoice(sfin.id);
      return;
    }
    setPendingTypeChoice(null);
    // An account either syncs into a Wealthfolio account or records a loan's
    // balance, never both.
    const isLoan = value.startsWith(LOAN_PREFIX);
    if (isLoan && mapping[sfin.id] && !confirmed) {
      // Also a different pick while asking: it replaces the pending one, still unconfirmed.
      setPendingLoan({ sfinId: sfin.id, value });
      return;
    }
    setPendingLoan(null);
    setMapping((prev) => ({ ...prev, [sfin.id]: isLoan ? '' : value }));
    setLoanLinks((prev) => ({ ...prev, [sfin.id]: isLoan ? value.slice(LOAN_PREFIX.length) : '' }));
  };

  const handleCreateAccount = async (sfin: SimplefinAccount, accountType: CreatableAccountType) => {
    setPendingTypeChoice(null);
    setCreateErrors((prev) => ({ ...prev, [sfin.id]: '' }));
    setCreatingId(sfin.id);
    try {
      const created = await ctx.api.accounts.create({
        name: sfin.name,
        accountType,
        currency: sfin.currency,
        isDefault: false,
        isActive: true,
        trackingMode: 'TRANSACTIONS',
      });
      setWfAccounts((prev) => [...prev, { id: created.id, name: created.name }]);
      setMapping((prev) => ({ ...prev, [sfin.id]: created.id }));
      setLoanLinks((prev) => ({ ...prev, [sfin.id]: '' }));
      onAccountCreated?.({ sfinId: sfin.id, wfId: created.id, name: created.name, accountType });
    } catch (e: any) {
      setCreateErrors((prev) => ({
        ...prev,
        [sfin.id]: e.message ?? 'Failed to create account',
      }));
    } finally {
      setCreatingId(null);
    }
  };

  const handleAutoMatch = () => {
    const auto: AccountMapping = { ...mapping };
    for (const sfin of simplefinAccounts) {
      const match = wfAccounts.find(
        (wf) => wf.name.toLowerCase() === sfin.name.toLowerCase(),
      );
      if (match && !loanLinks[sfin.id]) auto[sfin.id] = match.id;
    }
    setMapping(auto);
  };

  /** A link to a loan that no longer exists. Only known once the loans were read. */
  const gone = (sfinId: string) => !!loanLinks[sfinId] && loans !== null && !loans.some((l) => l.id === loanLinks[sfinId]);
  const loanName = (assetId: string) => loans?.find((l) => l.id === assetId)?.name ?? 'the loan';
  /** The loans a row may pick: one feed per loan, so not another row's. */
  const loansFor = (sfinId: string) =>
    (loans ?? []).filter((l) => !Object.entries(loanLinks).some(([id, assetId]) => id !== sfinId && assetId === l.id));

  return (
    <div>
      {loadError && <ErrorBox>{loadError}</ErrorBox>}
      <div style={{ display: 'flex', gap: 16, marginBottom: 4 }}>
        <div className="sfin-section-label" style={{ flex: 1, marginBottom: 0 }}>SimpleFin Account</div>
        <div className="sfin-section-label" style={{ flex: 1, marginBottom: 0 }}>Wealthfolio Account</div>
      </div>
      {simplefinAccounts.map((sfin) => (
        <div key={sfin.id} className="sfin-row">
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500 }}>{sfin.name}</div>
            <div className="sfin-subtle" style={{ fontSize: 12 }}>{sfin.currency} • balance: {sfin.balance}</div>
          </div>
          <div style={{ flex: 1 }}>
            <Select
              value={mapping[sfin.id] || (loanLinks[sfin.id] && !gone(sfin.id) ? LOAN_PREFIX + loanLinks[sfin.id] : '')}
              onChange={(e) => handleSelect(sfin, e.target.value)}
              disabled={creatingId === sfin.id}
              style={{ width: '100%' }}
            >
              <option value="">— Select account —</option>
              {wfAccounts.map((wf) => (
                <option key={wf.id} value={wf.id}>{wf.name}</option>
              ))}
              {loansOffered && loansFor(sfin.id).length > 0 && (
                <optgroup label="Loans (record the balance only)">
                  {loansFor(sfin.id).map((l) => (
                    <option key={l.id} value={LOAN_PREFIX + l.id}>{l.name}</option>
                  ))}
                </optgroup>
              )}
              {/* The row's own link is always an option, so the select shows it
                  when the list above is hidden (older companion), unread, or
                  leaves it out (two rows linked it before one link per loan). */}
              {loanLinks[sfin.id] && !gone(sfin.id) && !(loansOffered && loansFor(sfin.id).some((l) => l.id === loanLinks[sfin.id])) && (
                <option value={LOAN_PREFIX + loanLinks[sfin.id]}>
                  {loans?.find((l) => l.id === loanLinks[sfin.id])?.name ?? 'Linked loan'}
                </option>
              )}
              <option value={CREATE_NEW_VALUE}>+ Create new account</option>
            </Select>
            {loanLinks[sfin.id] && !gone(sfin.id) && (
              <div className="sfin-subtle" style={{ fontSize: 12, marginTop: 4 }}>
                Each sync records this account's balance on the loan as that day's confirmed
                balance. Its transactions are not imported: the payments already show up in the
                account that paid them.
                {!loansOffered && ` Update the companion to ${LOAN_BALANCES_SINCE} or newer: an older one doesn't record it, and reports this account as not mapped.`}
              </div>
            )}
            {gone(sfin.id) && (
              <div style={{ fontSize: 12, marginTop: 4, color: 'var(--destructive)' }}>
                The loan this account was linked to no longer exists. Pick another, or save to
                leave it unlinked.
              </div>
            )}
            {pendingLoan?.sfinId === sfin.id && (
              <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="sfin-subtle" style={{ fontSize: 12 }}>
                  This stops importing its transactions into{' '}
                  {wfAccounts.find((wf) => wf.id === mapping[sfin.id])?.name ?? 'its Wealthfolio account'} and
                  records its balance on {loanName(pendingLoan.value.slice(LOAN_PREFIX.length))} instead.
                </span>
                <Button variant="outline" style={{ padding: '3px 8px', fontSize: 12 }}
                  onClick={() => handleSelect(sfin, pendingLoan.value, true)}>
                  Link to the loan
                </Button>
                <Button variant="ghost" style={{ padding: '3px 8px', fontSize: 12 }}
                  onClick={() => setPendingLoan(null)}>
                  Cancel
                </Button>
              </div>
            )}
            {pendingTypeChoice === sfin.id && (
              <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <span className="sfin-subtle" style={{ fontSize: 12 }}>What kind of account?</span>
                {ACCOUNT_TYPE_OPTIONS.map((opt) => (
                  <Button key={opt.type} variant="outline" style={{ padding: '3px 8px', fontSize: 12 }}
                    onClick={() => handleCreateAccount(sfin, opt.type)}>
                    {opt.label}
                  </Button>
                ))}
                <Button variant="ghost" style={{ padding: '3px 8px', fontSize: 12 }}
                  onClick={() => setPendingTypeChoice(null)}>
                  Cancel
                </Button>
              </div>
            )}
            {creatingId === sfin.id && (
              <div className="sfin-subtle" style={{ fontSize: 12, marginTop: 4 }}>Creating account…</div>
            )}
            {createErrors[sfin.id] && (
              <div style={{ fontSize: 12, marginTop: 4, color: 'var(--destructive)' }}>{createErrors[sfin.id]}</div>
            )}
          </div>
        </div>
      ))}
      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
        <Button variant="outline" onClick={handleAutoMatch}>Auto-match by name</Button>
        <Button
          onClick={() => {
            const cleanMapping = Object.fromEntries(
              Object.entries(mapping).filter(([, v]) => !!v)
            );
            const cleanLoanLinks = Object.fromEntries(
              Object.entries(loanLinks).filter(([id, v]) => !!v && !gone(id))
            );
            onSave(cleanMapping, cleanLoanLinks);
          }}
          disabled={[...Object.values(mapping), ...Object.values(loanLinks)].filter(Boolean).length === 0}
        >
          Save Mapping
        </Button>
      </div>
    </div>
  );
}
