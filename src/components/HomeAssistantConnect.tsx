import React, { useEffect, useState } from 'react';
import { Button, CollapsibleCard, statusToneClass } from './ui';
import type { StatusMessage } from './ui';
import type { SecretsStore } from '../utils/secrets';
import type { HaStatus, HomeAssistantConfig } from '../../shared/home-assistant';
import { companionSendsToHomeAssistant, HOME_ASSISTANT_SINCE } from '../../shared/version';

interface Props {
  store: SecretsStore;
  isOpen: (id: string) => boolean;
  toggleCard: (id: string) => void;
}

export const HOME_ASSISTANT_CARD = 'home-assistant';

const EMPTY: HomeAssistantConfig = { enabled: true, url: '', token: '', service: '' };

/** "3 min ago" for the last-delivery line. */
function ago(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/**
 * Alerts to Home Assistant's notify service (shared/home-assistant.ts).
 *
 * Its own card and its own Save, not part of the Telegram draft: it is a
 * separate secret and a separate channel. "Send a test" QUEUES a test alert; the
 * companion sends it within 5 minutes, because an add-on cannot reach a Home
 * Assistant address. The companion's last outcome shows under the fields, so a
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
    ])).then(([c, s, v]) => {
      if (!live) return;
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
  const complete = !!cfg.url.trim() && !!cfg.token.trim() && !!cfg.service.trim();
  const dirty = JSON.stringify(cfg) !== JSON.stringify(saved);
  const savedComplete = !!saved.url && !!saved.token && !!saved.service && saved.enabled;
  const field = (key: 'url' | 'token' | 'service') =>
    (e: React.ChangeEvent<HTMLInputElement>) => setCfg((c) => ({ ...c, [key]: e.target.value }));

  const summary = !savedComplete ? 'Not set up'
    : delivery?.lastError && (!delivery.lastOkAt || delivery.lastErrorAt! > delivery.lastOkAt) ? 'Delivery failing'
      : 'Connected';

  return (
    <CollapsibleCard
      id={HOME_ASSISTANT_CARD}
      title="Home Assistant"
      summary={summary}
      open={isOpen(HOME_ASSISTANT_CARD)}
      onToggle={() => toggleCard(HOME_ASSISTANT_CARD)}
    >
      <div className="sfin-subtle sfin-notif-intro">
        Alerts (sync failing, balance drift, unlinked transfers, large transactions, new imports, new accounts)
        sent to a Home Assistant notify service by the companion container. Reports stay on Telegram.
      </div>

      {!supported ? (
        <div className="sfin-subtle">
          Needs the companion container {HOME_ASSISTANT_SINCE} or newer: only the companion can reach Home Assistant.
        </div>
      ) : (
        <div className="sfin-stack">
          <div className="sfin-fields">
            <div>
              <label htmlFor="sfin-ha-url" className="sfin-subtle">Home Assistant URL</label>
              <input id="sfin-ha-url" type="url" className="sfin-select" placeholder="e.g. http://homeassistant.local:8123"
                value={cfg.url} onChange={field('url')} />
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
          <label className="sfin-subtle">
            <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg((c) => ({ ...c, enabled: e.target.checked }))} />
            {' '}Send alerts to Home Assistant
          </label>

          {savedComplete && (
            <div className="sfin-subtle">
              {delivery?.lastError && (!delivery.lastOkAt || delivery.lastErrorAt! > delivery.lastOkAt)
                ? `Last delivery failed ${ago(delivery.lastErrorAt!)}: ${delivery.lastError}`
                : delivery?.lastOkAt ? `Last alert delivered ${ago(delivery.lastOkAt)}.`
                  : 'Nothing delivered yet.'}
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
                  await store.queueHomeAssistantTest();
                  setStatus({ text: 'Test queued. The companion sends it within 5 minutes; the line above shows the result.', tone: 'ok' });
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
