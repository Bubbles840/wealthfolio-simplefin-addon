import React, { useEffect, useState } from 'react';
import { Button, CollapsibleCard, statusToneClass } from './ui';
import type { StatusMessage } from './ui';
import type { SecretsStore } from '../utils/secrets';
import { DEFAULT_RECEIPT_MODEL, type ReceiptHostStatus, type ReceiptReaderConfig } from '../../shared/receipt-flow';
import { companionReadsReceipts, RECEIPTS_SINCE } from '../../shared/version';

interface Props {
  store: SecretsStore;
  isOpen: (id: string) => boolean;
  toggleCard: (id: string) => void;
}

export const RECEIPT_READER_CARD = 'receipt-reader';

const EMPTY: ReceiptReaderConfig = { enabled: true, url: '', model: DEFAULT_RECEIPT_MODEL };

/** "3 min ago" for the checked line. */
function ago(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/**
 * The receipt reader (docs/superpowers/specs/2026-10-29-receipt-reader-design.md):
 * where the vision model runs. Photos sent to the Telegram bot are read there
 * by the companion, because an add-on cannot reach a computer on the home
 * network. The companion looks at the host every 5 minutes and the result
 * shows under the fields, so a wrong address or a missing model is visible
 * here rather than only in container logs.
 */
export function ReceiptReaderConnect({ store, isOpen, toggleCard }: Props) {
  const [cfg, setCfg] = useState<ReceiptReaderConfig>(EMPTY);
  const [saved, setSaved] = useState<ReceiptReaderConfig>(EMPTY);
  const [host, setHost] = useState<ReceiptHostStatus | null>(null);
  const [companion, setCompanion] = useState<string | null | undefined>(undefined);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    // Deferred, so a store without these methods (an older mock) leaves the card empty instead of throwing.
    Promise.resolve().then(() => Promise.all([
      store.getReceiptReaderConfig(),
      store.getReceiptHostStatus(),
      store.getCompanionVersion().catch(() => null),
    ])).then(([c, h, v]) => {
      if (!live) return;
      setCfg((cur) => (JSON.stringify(cur) === JSON.stringify(EMPTY) ? c : cur));
      setSaved(c);
      setHost(h);
      setCompanion(v);
    }).catch(() => {});
    // The companion updates the host line every 5 minutes; follow it.
    const timer = setInterval(() => {
      Promise.resolve().then(() => store.getReceiptHostStatus()).then((h) => { if (live) setHost(h); }).catch(() => {});
    }, 30_000);
    return () => { live = false; clearInterval(timer); };
  }, [store]);

  const supported = companion === undefined || companionReadsReceipts(companion);
  const complete = !!cfg.url.trim() && !!cfg.model.trim();
  const dirty = JSON.stringify(cfg) !== JSON.stringify(saved);
  const savedOn = !!saved.url && saved.enabled;
  const summary = !savedOn ? 'Off' : host?.error ? 'Problem' : host ? 'Ready' : 'Not checked yet';

  return (
    <CollapsibleCard
      id={RECEIPT_READER_CARD}
      title="Receipt reader"
      summary={summary}
      open={isOpen(RECEIPT_READER_CARD)}
      onToggle={() => toggleCard(RECEIPT_READER_CARD)}
    >
      <div className="sfin-subtle sfin-notif-intro">
        Send a receipt photo or an order screenshot to the Telegram bot. A vision model on your own computer reads it,
        and the bot proposes the rows by category for you to confirm: a card charge is split, a gift card gets rows in
        the account that tracks it.
      </div>

      {!supported ? (
        <div className="sfin-subtle">
          Needs the companion container {RECEIPTS_SINCE} or newer: only the companion can reach the computer running the model.
        </div>
      ) : (
        <div className="sfin-stack">
          <div className="sfin-fields">
            <div>
              <label htmlFor="sfin-rr-url" className="sfin-subtle">Model host (Ollama)</label>
              <input id="sfin-rr-url" type="url" className="sfin-select" placeholder="e.g. http://192.168.1.20:11434"
                value={cfg.url} onChange={(e) => setCfg((c) => ({ ...c, url: e.target.value }))} />
            </div>
            <div>
              <label htmlFor="sfin-rr-model" className="sfin-subtle">Vision model</label>
              <input id="sfin-rr-model" type="text" className="sfin-select" placeholder={DEFAULT_RECEIPT_MODEL}
                value={cfg.model} onChange={(e) => setCfg((c) => ({ ...c, model: e.target.value }))} />
            </div>
          </div>
          <label className="sfin-subtle">
            <input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg((c) => ({ ...c, enabled: e.target.checked }))} />
            {' '}Read receipts sent to the bot
          </label>
          <div className="sfin-subtle">
            Ollama only answers its own computer unless it is started with OLLAMA_HOST=0.0.0.0, and it has no password:
            keep it on your home network.
          </div>

          {savedOn && (
            <div className="sfin-subtle">
              {host?.error ? `Problem (checked ${ago(host.checkedAt)}): ${host.error}.`
                : host ? `Ready — checked ${ago(host.checkedAt)}.`
                  : 'Not checked yet: the companion looks every 5 minutes.'}
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
                  await store.setReceiptReaderConfig(cfg);
                  setSaved(cfg);
                  setStatus({ text: 'Saved. The companion checks the model host within 5 minutes.', tone: 'ok' });
                } catch (err) {
                  setStatus({ text: `Couldn't save: ${(err as Error).message}`, tone: 'error' });
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </CollapsibleCard>
  );
}
