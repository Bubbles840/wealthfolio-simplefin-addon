import React, { useEffect, useState } from 'react';
import { Button, SectionLabel } from './ui';
import type { SecretsStore } from '../utils/secrets';
import type { SemesterPoolConfig } from '../../shared/pool';

/**
 * Where the semester pool gets set: "this amount has to last until this date".
 *
 * Built for lump-sum funding (a loan disbursement at semester start), where
 * monthly income figures mean nothing — see shared/pool.ts. Setting it here or
 * via the Telegram `/pool` command writes the SAME secret; the start date is
 * always today, because the pool is set when the money lands and spending
 * before today belonged to the previous pool.
 *
 * Deliberately dumb about status: the burn-down itself (the tile above, the
 * report lines) is computed by the companion from the database this card
 * cannot see. What the card owns is the CONFIG, so it renders the config —
 * and after a save it says the tile catches up on the next sync rather than
 * pretending to know the current burn.
 */
export function PoolCard({ store }: { store: SecretsStore }) {
  const [cfg, setCfg] = useState<SemesterPoolConfig | null>(null);
  const [amount, setAmount] = useState('');
  const [endDate, setEndDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    store.getSemesterPool?.().then((c) => setCfg(c ?? null)).catch(() => {});
  }, [store]);

  const amountCents = (() => {
    const cleaned = amount.replace(/[$,\s]/g, '');
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
    const cents = Math.round(parseFloat(cleaned) * 100);
    return cents > 0 ? cents : null;
  })();
  const today = new Date().toISOString().slice(0, 10);
  const valid = amountCents !== null && /^\d{4}-\d{2}-\d{2}$/.test(endDate) && endDate >= today;

  const setPool = async () => {
    if (!valid || amountCents === null) return;
    setBusy(true);
    try {
      const next: SemesterPoolConfig = { amountCents, startDate: today, endDate };
      await store.setSemesterPool?.(next);
      setCfg(next);
      setAmount('');
      setEndDate('');
      setJustSaved(true);
    } finally {
      setBusy(false);
    }
  };

  const clearPool = async () => {
    setBusy(true);
    try {
      await store.setSemesterPool?.(null);
      setCfg(null);
      setJustSaved(false);
    } finally {
      setBusy(false);
    }
  };

  const money = (cents: number) =>
    new Intl.NumberFormat('en-US', {
      style: 'currency', currency: 'USD', maximumFractionDigits: 0,
    }).format(cents / 100);

  return (
    <div className="sfin-card">
      <div className="sfin-card-head">
        <SectionLabel>Semester pool</SectionLabel>
      </div>
      <div className="sfin-subtle">
        Money that arrives in one lump — a loan disbursement, a stipend — and
        has to last until a date. Reports show what a week can afford and when
        the pool runs out at your pace. Also settable from Telegram:{' '}
        <code>/pool 16000 Dec 12</code>.
      </div>
      {cfg && (
        <div className="sfin-banner-note">
          Current pool: <b>{money(cfg.amountCents)}</b> from {cfg.startDate} until{' '}
          <b>{cfg.endDate}</b>
          {justSaved ? ' — the tile and reports pick it up on the next sync.' : ''}
        </div>
      )}
      <div className="sfin-field-row">
        <label htmlFor="sfin-pool-amount">Pool amount</label>
        <input
          id="sfin-pool-amount"
          type="text"
          inputMode="decimal"
          placeholder="16000"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      <div className="sfin-field-row">
        <label htmlFor="sfin-pool-end">Must last until</label>
        <input
          id="sfin-pool-end"
          type="date"
          value={endDate}
          onChange={(e) => setEndDate(e.target.value)}
        />
      </div>
      <div className="sfin-banner-actions">
        <Button onClick={setPool} disabled={!valid || busy}>
          Set pool
        </Button>
        {cfg && (
          <Button variant="ghost" onClick={clearPool} disabled={busy}>
            Clear pool
          </Button>
        )}
      </div>
    </div>
  );
}
