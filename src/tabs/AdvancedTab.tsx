import React, { useCallback, useEffect, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { runSync } from '../utils/sync';
import { Button, CollapsibleCard } from '../components/ui';
import { AmazonCard } from '../components/AmazonCard';
import { RuleEditor } from '../components/RuleEditor';
import type { SecretsStore, CategoryCatalogEntry } from '../utils/secrets';
import type { Scheduler } from '../utils/scheduler';
import type { MappingRule } from '../../shared/types';

/** Ids for this tab's collapsible cards. Doubles as the persisted key set (the
 *  page owns the open-card map), so these strings must not change — a rename
 *  silently forgets that card's last-open state, which is fine, but a stored
 *  blob keyed on the old string would never match again. */
const CARD = {
  autoSync: 'auto-sync',
  docker: 'docker',
  amazon: 'amazon',
  amazonGuide: 'amazon-guide',
  rules: 'rules',
} as const;

interface Props {
  ctx: AddonContext;
  store: SecretsStore;
  scheduler: Scheduler;
  onReset: () => void;
  /** Loaded once by the page (the Notifications tab needs it too), so it
   *  arrives as a prop rather than being fetched a second time here. */
  categories: CategoryCatalogEntry[];
  isOpen: (id: string) => boolean;
  toggleCard: (id: string) => void;
}

/**
 * Everything that is set up once and then only checked, plus the destructive
 * reset flow.
 *
 * Owns its own auto-sync / auto-heal / transaction-rule state, loaded here
 * rather than in the page's mega-load: nothing outside this tab reads any of
 * it (the scheduler itself is (re)started elsewhere — see `addon.tsx` — so a
 * tab that has never been opened still keeps syncing on schedule).
 */
export function AdvancedTab({ ctx, store, scheduler, onReset, categories, isOpen, toggleCard }: Props) {
  const [scheduleHours, setScheduleHours] = useState<number | null>(null);
  const [autoHeal, setAutoHeal] = useState(false);
  const [autoAdjust, setAutoAdjust] = useState(false);
  const [rules, setRules] = useState<MappingRule[]>([]);
  // Reset's own two-step inline confirm. window.confirm is silently
  // suppressed in the addon sandbox (the iframe is sandbox="allow-scripts"
  // with no allow-modals), which is why confirmation is rendered inline
  // instead of via a native dialog.
  const [confirmingReset, setConfirmingReset] = useState(false);

  useEffect(() => {
    Promise.all([
      store.getSyncScheduleHours(),
      store.getAutoHeal(),
      store.getAutoAdjust(),
      store.getMappingRules(),
    ]).then(([hours, heal, adjust, r]) => {
      setScheduleHours(hours);
      setAutoHeal(heal);
      setAutoAdjust(adjust);
      setRules(r);
    });
  }, [store]);

  const changeInterval = useCallback(async (hours: number) => {
    setScheduleHours(hours);
    await store.setSyncScheduleHours(hours);
    scheduler.stop();
    if (hours > 0) {
      scheduler.start(hours, () => store.getLastSyncAt(), () => runSync(ctx, store));
    }
  }, [ctx, store, scheduler]);

  const handleReset = useCallback(async () => {
    scheduler.stop();
    await store.clearAll();
    onReset();
  }, [scheduler, store, onReset]);

  // ── Collapsed-header summaries ───────────────────────────────────────────
  // Each collapsible card reports its own configuration as text in its header,
  // so a closed card still answers "is this on, and set to what?". The
  // Auto-sync summary also replaces the Overview's old auto-sync stat tile,
  // deleted on the understanding that this header carries that information now.
  const autoSyncSummary = `${scheduleHours ? `Every ${scheduleHours}h` : 'Off'} · ${
    autoAdjust ? 'aggressive auto-heal' : autoHeal ? 'auto-heal on' : 'auto-heal off'
  }`;

  const rulesSummary =
    rules.length === 0
      ? 'None — using the +/− defaults'
      : `${rules.length} rule${rules.length === 1 ? '' : 's'}`;

  return (
    <>
      <CollapsibleCard
        id={CARD.autoSync}
        title="Auto-sync"
        summary={autoSyncSummary}
        open={isOpen(CARD.autoSync)}
        onToggle={() => toggleCard(CARD.autoSync)}
      >
        <div className="sfin-field-row">
          <label htmlFor="sfin-interval" className="sfin-section-label">
            Auto-Sync interval
          </label>
          <select
            id="sfin-interval"
            className="sfin-select"
            value={scheduleHours ?? 0}
            onChange={(e) => changeInterval(Number(e.target.value))}
          >
            <option value={0}>Off</option>
            <option value={1}>Every 1 hour</option>
            <option value={4}>Every 4 hours</option>
            <option value={8}>Every 8 hours</option>
            <option value={24}>Every 24 hours</option>
          </select>
        </div>
        <div className="sfin-subtle sfin-autosync-hint">
          Syncs when this page is open and it&apos;s been this long since the last run.
        </div>

        <div className="sfin-checks sfin-autosync-checks">
          <label className="sfin-check">
            <input
              type="checkbox"
              checked={autoHeal}
              onChange={async (e) => {
                setAutoHeal(e.target.checked);
                await store.setAutoHeal(e.target.checked);
              }}
            />
            <span>
              <span className="sfin-check-name">Auto-heal</span>
              <span className="sfin-subtle">
                {' '}— re-scan ~45 days each sync to catch missing transactions and check
                balances. Balance adjustments stay manual.
              </span>
            </span>
          </label>

          <label className="sfin-check">
            <input
              type="checkbox"
              checked={autoAdjust}
              onChange={async (e) => {
                setAutoAdjust(e.target.checked);
                await store.setAutoAdjust(e.target.checked);
              }}
            />
            <span>
              <span className="sfin-check-name">Aggressively auto-heal</span>
              <span className="sfin-subtle">
                {' '}— also auto-insert balance adjustments for any residual, without asking
                (includes the re-scan). Forces balances to match your bank on every sync.
              </span>
            </span>
          </label>
        </div>
      </CollapsibleCard>

      {/* Its own card rather than a nested disclosure inside Auto-sync: with
          both collapsed the two headers cost less than a card containing a
          second collapse control, and each gets a summary of its own. There is
          no state to report here — the addon cannot see whether the container
          is running — so the summary says what it is for. */}
      <CollapsibleCard
        id={CARD.docker}
        title="Background sync (Docker)"
        summary="Keeps syncing even when Wealthfolio is closed"
        open={isOpen(CARD.docker)}
        onToggle={() => toggleCard(CARD.docker)}
      >
        <div>
          <div className="sfin-subtle sfin-docker-intro">
            Add this service to your <code>docker-compose.yml</code>. You can customize the sync rate via <code>SYNC_SCHEDULE</code>:
          </div>
          <pre className="sfin-pre sfin-docker-pre">
            {`services:
  simplefin-sync:
    image: ghcr.io/bubbles840/wealthfolio-simplefin-sync:latest
    container_name: simplefin-sync
    restart: always
    network_mode: host
    environment:
      - WEALTHFOLIO_API_URL=http://127.0.0.1:8088
      - WEALTHFOLIO_PASSWORD=your_wealthfolio_password
      - SYNC_SCHEDULE=0 */6 * * *          # Change cron schedule here (e.g. 0 */3 * * * for every 3h)
      - MIN_SYNC_INTERVAL_HOURS=1          # Minimum interval cooldown between syncs`}
          </pre>
        </div>
      </CollapsibleCard>

      {/* Directly below the Docker card: it is the companion that reads the
          mailbox, so this is only useful to someone who has just set that up. */}
      <AmazonCard
        store={store}
        cardId={CARD.amazon}
        guideId={CARD.amazonGuide}
        open={isOpen(CARD.amazon)}
        guideOpen={isOpen(CARD.amazonGuide)}
        onToggle={() => toggleCard(CARD.amazon)}
        onToggleGuide={() => toggleCard(CARD.amazonGuide)}
        categories={categories}
      />

      {/* The card's own open state replaces the old "Edit"/"Done" toggle: this
          card had a read-only list AND a disclosure to reach the editor, which
          was two controls for one question. The header summary now answers "do
          I have rules?", and opening goes straight to the editor — which lists
          every rule and restates the +/− defaults itself, so nothing is lost. */}
      <CollapsibleCard
        id={CARD.rules}
        title="Transaction rules"
        summary={rulesSummary}
        open={isOpen(CARD.rules)}
        onToggle={() => toggleCard(CARD.rules)}
      >
        <RuleEditor
          rules={rules}
          onChange={async (r) => {
            setRules(r);
            await store.setMappingRules(r);
          }}
        />
      </CollapsibleCard>

      <div className="sfin-callout sfin-advanced-callout">
        💡 Imported bank transactions appear under <strong>Activities</strong>. To see them in the{' '}
        <strong>Spending</strong> tab with categories and budgets, enable the Spending Tracker for
        your mapped accounts: <strong>Settings → Spending Tracker</strong>.
      </div>

      {/* A destructive boundary, not a bare button under unrelated settings:
          the old layout put "Reset Setup" directly below the Spending-Tracker
          callout with nothing to mark it apart from everything else on the
          page. */}
      <div className="sfin-danger-card">
        <b>Reset connection</b>
        <div className="sfin-subtle sfin-danger-note">
          Disconnects SimpleFin and clears the account mapping. Transactions already
          imported into Wealthfolio stay.
        </div>
        <div className="sfin-danger-actions">
          {!confirmingReset ? (
            <Button variant="destructive" onClick={() => setConfirmingReset(true)}>
              Reset Setup
            </Button>
          ) : (
            <>
              <Button variant="destructive" onClick={handleReset}>Yes, reset everything</Button>
              <Button variant="ghost" onClick={() => setConfirmingReset(false)}>Cancel</Button>
            </>
          )}
        </div>
      </div>
    </>
  );
}
