import React, { useEffect, useState } from 'react';
import { Button, CollapsibleCard, statusToneClass } from './ui';
import type { StatusMessage } from './ui';
import type { SecretsStore } from '../utils/secrets';
import {
  haChangedSinceFailure, haConfigComplete, haLinkBaseProblem, haUrlProblem, HA_PENDING_MAX_AGE_MS,
  type HaMode, type HaStatus, type HomeAssistantConfig,
} from '../../shared/home-assistant';
import { companionSendsToHomeAssistant, HOME_ASSISTANT_SINCE } from '../../shared/version';

interface Props {
  store: SecretsStore;
  isOpen: (id: string) => boolean;
  toggleCard: (id: string) => void;
}

export const HOME_ASSISTANT_CARD = 'home-assistant';

const EMPTY: HomeAssistantConfig = {
  enabled: true, mode: 'notify', url: '', token: '', service: '', titlePrefix: '', linkBase: '',
  notifyOnImport: false, notifyOnImportTrades: true,
};

/** "3 min ago" for the last-delivery line. */
function ago(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/**
 * Alerts to Home Assistant (shared/home-assistant.ts), through its notify
 * service or a webhook trigger.
 *
 * Its own card and its own Save, not part of the Telegram draft: it is a
 * separate secret and a separate channel, with its own import-notice switches.
 * "Send a test" QUEUES a test alert; the companion sends it within minutes,
 * because an add-on cannot reach a Home Assistant address. The companion's last outcome shows under the fields, so a
 * wrong token or service is visible here rather than only in container logs.
 */
export function HomeAssistantConnect({ store, isOpen, toggleCard }: Props) {
  const [cfg, setCfg] = useState<HomeAssistantConfig>(EMPTY);
  const [saved, setSaved] = useState<HomeAssistantConfig>(EMPTY);
  const [delivery, setDelivery] = useState<HaStatus | null>(null);
  const [companion, setCompanion] = useState<string | null | undefined>(undefined);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    // Deferred, so a store without these methods (an older mock) leaves the card empty instead of throwing.
    const load = () => Promise.resolve().then(() => Promise.all([
      store.getHomeAssistantConfig(),
      store.getHomeAssistantStatus(),
      store.getCompanionVersion().catch(() => null),
    ])).then(([stored, s, v]) => {
      if (!live) return;
      // Every field present, whatever the store returned (an older mock, a partial secret).
      const c = { ...EMPTY, ...stored };
      setCfg((cur) => (JSON.stringify(cur) === JSON.stringify(EMPTY) ? c : cur));
      setSaved(c);
      setDelivery(s);
      setCompanion(v);
    }).catch(() => {});
    load();
    // The companion updates the delivery line as it sends; follow it.
    const timer = setInterval(() => {
      Promise.resolve().then(() => store.getHomeAssistantStatus()).then((s) => { if (live) setDelivery(s); }).catch(() => {});
    }, 30_000);
    return () => { live = false; clearInterval(timer); };
  }, [store]);

  const supported = companion === undefined || companionSendsToHomeAssistant(companion);
  const linkProblem = haLinkBaseProblem(cfg.linkBase);
  // Only once something is typed: an empty field just keeps Save disabled.
  const urlProblem = cfg.url.trim() ? haUrlProblem(cfg.url) : null;
  const complete = haConfigComplete(cfg) && !linkProblem;
  const dirty = JSON.stringify(cfg) !== JSON.stringify(saved);
  const savedComplete = saved.enabled && haConfigComplete(saved);
  const webhook = cfg.mode === 'webhook';
  const field = (key: 'url' | 'token' | 'service' | 'titlePrefix' | 'linkBase') =>
    (e: React.ChangeEvent<HTMLInputElement>) => setCfg((c) => ({ ...c, [key]: e.target.value }));

  const failing = !!delivery?.lastError && (!delivery.lastOkAt || delivery.lastErrorAt! > delivery.lastOkAt);
  // The saved config is not the one that failed: the old error no longer says
  // anything about it, and the next alert (or a test) is sent with it at once.
  const changed = failing && haChangedSinceFailure(delivery, saved);
  const paused = failing && !changed && !!delivery?.parked;
  const droppedRecently = !!delivery?.dropped && !!delivery.droppedAt
    && Date.now() - Date.parse(delivery.droppedAt) < HA_PENDING_MAX_AGE_MS;
  const summary = !savedComplete ? 'Not set up'
    : changed ? 'Changed, not checked yet'
      : paused ? 'Delivery paused'
        : failing ? 'Delivery failing'
          : 'Connected';
  const resumesWith = saved.mode === 'webhook' ? 'the webhook URL' : 'the address, access token or notify service';
  const urlField = (id: string) => urlProblem
    ? { 'aria-invalid': true as const, 'aria-describedby': id }
    : {};

  return (
    <CollapsibleCard
      id={HOME_ASSISTANT_CARD}
      title="Home Assistant"
      summary={summary}
      open={isOpen(HOME_ASSISTANT_CARD)}
      onToggle={() => toggleCard(HOME_ASSISTANT_CARD)}
    >
      <div className="sfin-subtle sfin-notif-intro">
        Alerts (sync failing, balance drift, unlinked transfers, large transactions, new accounts, and new imports
        if you want them) sent to Home Assistant by the companion container. Reports stay on Telegram.
      </div>

      {!supported ? (
        <div className="sfin-subtle">
          Needs the companion container {HOME_ASSISTANT_SINCE} or newer: only the companion can reach Home Assistant.
        </div>
      ) : (
        <div className="sfin-stack">
          <div>
            <label htmlFor="sfin-ha-mode" className="sfin-subtle">Send through</label>
            <select id="sfin-ha-mode" className="sfin-select" value={cfg.mode}
              onChange={(e) => setCfg((c) => ({ ...c, mode: e.target.value as HaMode }))}>
              <option value="notify">Notify service (access token)</option>
              <option value="webhook">Webhook (an automation routes it)</option>
            </select>
          </div>
          {webhook ? (
            <div>
              <label htmlFor="sfin-ha-url" className="sfin-subtle">Webhook URL</label>
              <input id="sfin-ha-url" type="url" className="sfin-select"
                placeholder="e.g. http://homeassistant.local:8123/api/webhook/your-id"
                {...urlField('sfin-ha-url-problem')} value={cfg.url} onChange={field('url')} />
              {urlProblem && <div id="sfin-ha-url-problem" className="sfin-subtle">{urlProblem}</div>}
              <div className="sfin-subtle">
                Posts JSON with title, message, source (&quot;simplefin-sync&quot;), kind and id. Home Assistant answers
                every webhook the same way, so use Send a test to check your automation receives it.
              </div>
            </div>
          ) : (
            <>
              <div className="sfin-fields">
                <div>
                  <label htmlFor="sfin-ha-url" className="sfin-subtle">Home Assistant URL</label>
                  <input id="sfin-ha-url" type="url" className="sfin-select" placeholder="e.g. http://homeassistant.local:8123"
                    {...urlField('sfin-ha-url-problem')} value={cfg.url} onChange={field('url')} />
                  {urlProblem && <div id="sfin-ha-url-problem" className="sfin-subtle">{urlProblem}</div>}
                </div>
                <div>
                  <label htmlFor="sfin-ha-service" className="sfin-subtle">Notify service</label>
                  <input id="sfin-ha-service" type="text" className="sfin-select" placeholder="e.g. notify.mobile_app_my_phone"
                    value={cfg.service} onChange={field('service')} />
                </div>
              </div>
              <div>
                <label htmlFor="sfin-ha-token" className="sfin-subtle">Long-lived access token</label>
                <input id="sfin-ha-token" type="password" className="sfin-select"
                  placeholder="Profile → Security → Long-lived access tokens"
                  value={cfg.token} onChange={field('token')} />
              </div>
            </>
          )}
          <div className="sfin-fields">
            <div>
              <label htmlFor="sfin-ha-prefix" className="sfin-subtle">Title prefix</label>
              <input id="sfin-ha-prefix" type="text" className="sfin-select" placeholder="e.g. [Wealth]"
                value={cfg.titlePrefix} onChange={field('titlePrefix')} />
            </div>
            <div>
              <label htmlFor="sfin-ha-link" className="sfin-subtle">Wealthfolio address for tap links</label>
              <input id="sfin-ha-link" type="url" className="sfin-select" placeholder="e.g. https://wealthfolio.example.com"
                aria-invalid={linkProblem ? true : undefined} aria-describedby={linkProblem ? 'sfin-ha-link-problem' : undefined}
                value={cfg.linkBase} onChange={field('linkBase')} />
              {linkProblem && <div id="sfin-ha-link-problem" className="sfin-subtle">{linkProblem}</div>}
            </div>
          </div>
          <div className="sfin-subtle">
            Both can stay empty. With an address, tapping an alert opens it in the add-on: a large transaction opens its story. The address is
            the one your phone uses to reach Wealthfolio. Webhooks receive it as <code>url</code>; the notify service passes
            it to the companion app.
          </div>
          <label className="sfin-subtle">
            <input type="checkbox" checked={cfg.notifyOnImport}
              onChange={(e) => setCfg((c) => ({ ...c, notifyOnImport: e.target.checked }))} />
            {' '}Also send a notice for each sync that imports new transactions
          </label>
          {cfg.notifyOnImport && (
            <label className="sfin-subtle">
              <input type="checkbox" checked={cfg.notifyOnImportTrades}
                onChange={(e) => setCfg((c) => ({ ...c, notifyOnImportTrades: e.target.checked }))} />
              {' '}Include investment buys and sells
            </label>
          )}
          <label className="sfin-subtle">
            <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg((c) => ({ ...c, enabled: e.target.checked }))} />
            {' '}Send alerts to Home Assistant
          </label>

          {savedComplete && (
            <div className="sfin-subtle">
              {changed
                ? 'Changed since the last failure. Send a test to check it.'
                : paused
                ? `Delivery paused ${ago(delivery!.lastErrorAt!)}: ${delivery!.lastError}. Nothing is sent until you change ${resumesWith}, or send a test.`
                : failing
                  ? `Last delivery failed ${ago(delivery!.lastErrorAt!)}: ${delivery!.lastError}${delivery!.retryAt ? '. Retrying later.' : ''}`
                  : delivery?.lastOkAt ? `Last alert delivered ${ago(delivery.lastOkAt)}.`
                    : 'Nothing delivered yet.'}
            </div>
          )}
          {savedComplete && droppedRecently && (
            <div className="sfin-subtle">
              {delivery!.dropped === 1 ? '1 alert' : `${delivery!.dropped} alerts`} waited over a week without
              reaching Home Assistant and {delivery!.dropped === 1 ? 'was' : 'were'} dropped ({ago(delivery!.droppedAt!)}).
            </div>
          )}

          {status && (
            <div role="status" className={`sfin-status ${statusToneClass(status.tone)}`}>{status.text}</div>
          )}

          <div className="sfin-stack-actions">
            <Button
              disabled={busy || !dirty || (cfg.enabled && !complete)}
              onClick={async () => {
                setBusy(true);
                try {
                  await store.setHomeAssistantConfig(cfg);
                  setSaved(cfg);
                  setStatus({ text: 'Saved.', tone: 'ok' });
                } catch (err) {
                  setStatus({ text: `Couldn't save: ${(err as Error).message}`, tone: 'error' });
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save
            </Button>
            <Button
              variant="outline"
              disabled={busy || dirty || !savedComplete}
              onClick={async () => {
                setBusy(true);
                try {
                  const outcome = await store.queueHomeAssistantTest();
                  setStatus(outcome === 'off'
                    ? { text: 'Home Assistant is off in the saved settings, so no test was queued.', tone: 'error' }
                    : { text: 'Test queued. The companion sends it within 5 minutes (up to 15 right after you first set this up); the line above shows the result.', tone: 'ok' });
                } catch (err) {
                  setStatus({ text: `Couldn't queue the test: ${(err as Error).message}`, tone: 'error' });
                } finally {
                  setBusy(false);
                }
              }}
            >
              Send a test
            </Button>
          </div>
        </div>
      )}
    </CollapsibleCard>
  );
}
