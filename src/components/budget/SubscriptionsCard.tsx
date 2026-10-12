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
import { Button, Input } from '../ui';
import type { ReportCube } from '../../../shared/report-cube';
import {
  acceptLink, confirmKey, declineLink, deleteManual, emptySubscriptionPrefs, hideKey, renameKey, restoreDeleted, setRemind, unhideKey,
  type LoadedSubscriptionPrefs, type RemindDays, type SubscriptionEdit,
} from '../../../shared/subscription-prefs';
import {
  aboutDollars, buildRoster, formatRosterTotal, localIsoDay, monthDay, rosterMoney, rosterPrice, rosterWhen,
  type RosterEntry,
} from '../../../shared/subscription-roster';
import { parseSubscriptionName, SUB_NAME_HINT } from '../../../shared/telegram-commands';

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

export function SubscriptionsCard({
  cube, full = false, subscriptionPrefs, onSubscriptionEdit, companionStale = false, onSetUpCompanion,
}: SubscriptionsCardProps) {
  // A corrupt document refuses every write, so the card offers none: it is
  // read-only under the notice instead of celebrating a hide that never saved.
  const edit = subscriptionPrefs?.unreadable ? undefined : onSubscriptionEdit;
  // Hooks first: every early return below comes after them.
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const [deleted, setDeleted] = React.useState<{ id: string; name: string } | null>(null);
  const [celebrate, setCelebrate] = React.useState<{ name: string; price: string } | null>(null);
  const prefs = subscriptionPrefs?.prefs ?? null;
  const roster = React.useMemo(() => buildRoster({
    detected: cube.subscriptions ?? null,
    merchants: cube.merchants,
    links: cube.subscriptionLinks ?? [],
    prefs: prefs ?? emptySubscriptionPrefs(),
    today: localIsoDay(new Date()),
  }), [cube, prefs]);

  const unreadableNotice = subscriptionPrefs?.unreadable
    ? <div className="sfin-subs-note">{SUBSCRIPTIONS_UNREADABLE_NOTICE}</div>
    : null;
  // A link question with no buttons is dead, so a read-only card does not ask it.
  const linkSuggestions = edit ? roster.linkSuggestions : [];
  const listed = roster.subscriptions.length + roster.bills.length + roster.maybes.length;
  if (!full && listed === 0 && linkSuggestions.length === 0) {
    // The notice survives the empty states: it is why nothing can be changed.
    if (!roster.detectionAvailable) return <>{unreadableNotice}<div className="sfin-subtle">{NOT_LOOKED_YET}</div></>;
    // The OPEN view keeps going: an empty roster is when "watch a merchant" is the point.
    if (roster.hidden.length === 0) return <>{unreadableNotice}<div className="sfin-subtle">{NOTHING_DETECTED}</div></>;
  }

  const hide = (e: RosterEntry) => {
    setCelebrate({ name: e.displayName, price: rosterPrice(e) });
    setOpenKey(null);
    edit?.((p) => hideKey(p, e.key));
  };

  const remove = (e: RosterEntry) => {
    const id = e.key.slice(2); // 'm:<id>'
    setDeleted({ id, name: e.displayName });
    setOpenKey(null);
    edit?.((p) => deleteManual(p, id, new Date()));
  };

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
      {unreadableNotice}
      {linkSuggestions.map((s) => (
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
      {deleted && edit && (
        <div className="sfin-subs-actions" role="status">
          Deleted {deleted.name}.
          <Button variant="ghost" onClick={() => { edit((p) => restoreDeleted(p, deleted.id)); setDeleted(null); }}>Undo</Button>
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
