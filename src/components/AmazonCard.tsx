import React, { useEffect, useState } from 'react';
import { Button, CollapsibleCard, Disclosure } from './ui';
import { CategoryIcon } from './CategoryIcon';
import {
  DEFAULT_AMAZON_CATEGORY,
  resolveAmazonCategory,
  type AmazonLabelCatalog,
  type AmazonMailConfig,
} from '../../shared/amazon-config';
import type { CategoryCatalogEntry, SecretsStore } from '../utils/secrets';

/**
 * Setup for automatic categorization of Amazon charges.
 *
 * Its own component rather than another block in `SyncPage`, which is already
 * ~1400 lines: this owns four fields, a label table and a save, none of which any
 * other part of the page reads.
 *
 * WHAT THE USER IS ACTUALLY AGREEING TO, said plainly in the card rather than
 * buried in a README — they are typing a password into a box, and they deserve to
 * know it reaches a mailbox that holds only receipts. The guide is the feature's
 * real surface area; the three fields are the easy part.
 */
interface Props {
  store: SecretsStore;
  cardId: string;
  guideId: string;
  open: boolean;
  guideOpen: boolean;
  onToggle: () => void;
  onToggleGuide: () => void;
  /** Parent categories the user actually has, for the override dropdowns. */
  categories: CategoryCatalogEntry[];
}

export function AmazonCard({
  store, cardId, guideId, open, guideOpen, onToggle, onToggleGuide, categories,
}: Props) {
  const [host, setHost] = useState('imap.gmail.com');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [defaultCategory, setDefaultCategory] = useState(DEFAULT_AMAZON_CATEGORY);
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [labels, setLabels] = useState<AmazonLabelCatalog>({});
  const [status, setStatus] = useState('');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([store.getAmazonConfig(), store.getAmazonLabels()])
      .then(([cfg, seen]) => {
        if (cfg) {
          setHost(cfg.host || 'imap.gmail.com');
          setUser(cfg.user ?? '');
          setPassword(cfg.password ?? '');
          setDefaultCategory(cfg.defaultCategory || DEFAULT_AMAZON_CATEGORY);
          setOverrides(cfg.labelOverrides ?? {});
        }
        setLabels(seen);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [store]);

  const configured = !!(host && user && password);
  const labelNames = Object.keys(labels).sort((a, b) => a.localeCompare(b));
  // Parents only. Wealthfolio's budgets live at parent level, so offering a
  // subcategory here would let a user pick something no budget can ever show.
  const options = categories.filter((c) => !c.parent).map((c) => c.name);
  const unmatched = labelNames.filter(
    (l) => !resolveAmazonCategory(l, { defaultCategory, labelOverrides: overrides }).matched,
  ).length;

  const summary = !loaded
    ? 'Loading…'
    : !configured
      ? 'Not set up — Amazon charges stay uncategorized'
      : unmatched > 0
        ? `On · ${labelNames.length} categories seen, ${unmatched} need a rule`
        : `On · ${labelNames.length} Amazon categories mapped`;

  const save = async () => {
    await store.setAmazonConfig({
      enabled: true,
      host,
      user,
      password,
      defaultCategory,
      labelOverrides: overrides,
    } satisfies AmazonMailConfig);
    setStatus('✅ Saved. The companion will read the mailbox on its next sync.');
  };

  return (
    <CollapsibleCard
      id={cardId}
      title="Amazon auto-categorization (optional)"
      summary={summary}
      open={open}
      onToggle={onToggle}
    >
      <div className="sfin-subtle" style={{ marginBottom: 12 }}>
        A bank charge reads <code>AMAZON.COM*MB3T81</code> and says nothing about what
        you bought. Amazon's order emails name the category, so forwarding those to a
        throwaway mailbox lets the companion label each Amazon charge automatically.
      </div>

      <div className="sfin-disc-inset" style={{ marginBottom: 12 }}>
        <Disclosure
          id={guideId}
          variant="inline"
          title="📦 How to set this up (one time)"
          open={guideOpen}
          onToggle={onToggleGuide}
        >
          <ol>
            <li>
              Make a <strong>new, empty email account</strong> just for this — a second
              Gmail is fine. Do <strong>not</strong> use your main one.
            </li>
            <li>
              In your <strong>main</strong> inbox, add a filter that forwards mail from{' '}
              <code>auto-confirm@amazon.com</code> and{' '}
              <code>shipment-tracking@amazon.com</code> to that new address. In Gmail:
              Settings → Filters → Create a new filter.
            </li>
            <li>
              On the new account, create an <strong>app password</strong>:{' '}
              <code>myaccount.google.com/apppasswords</code>. You need 2-Step
              Verification switched on first, or that page won't offer the option.
              <br />
              <span className="sfin-subtle">
                There is nothing to enable for IMAP — Google removed that toggle, so
                it is always on.
              </span>
            </li>
            <li>Paste that address and app password below, and save.</li>
          </ol>
          <div className="sfin-callout" style={{ marginTop: 8 }}>
            🔒 <strong>Why a separate account.</strong> No email provider lets an app read
            mail from one sender only — an app password grants the entire mailbox. So the
            companion gets a mailbox that contains <em>nothing but Amazon receipts</em>. If
            the password ever leaked, that is all it could reach, and you switch it off by
            deleting one filter. Your real inbox is never touched.
          </div>
          <div className="sfin-subtle" style={{ marginTop: 8 }}>
            Nothing here creates transactions. Order emails only add the category to a
            charge SimpleFin already imported, so there is no way for this to double-count
            a purchase.
          </div>
        </Disclosure>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="sfin-fields">
          <div>
            <label htmlFor="sfin-amz-host" className="sfin-subtle">IMAP server</label>
            <input
              id="sfin-amz-host"
              type="text"
              className="sfin-select"
              placeholder="imap.gmail.com"
              value={host}
              onChange={(e) => setHost(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="sfin-amz-user" className="sfin-subtle">Mailbox address</label>
            <input
              id="sfin-amz-user"
              type="text"
              className="sfin-select"
              placeholder="my-amazon-receipts@gmail.com"
              value={user}
              onChange={(e) => setUser(e.target.value)}
            />
          </div>
        </div>

        <div className="sfin-fields">
          <div>
            <label htmlFor="sfin-amz-pass" className="sfin-subtle">App password</label>
            <input
              id="sfin-amz-pass"
              type="password"
              className="sfin-select"
              placeholder="16-character app password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="sfin-amz-default" className="sfin-subtle">
              Category for anything unrecognized
            </label>
            <select
              id="sfin-amz-default"
              className="sfin-select"
              value={defaultCategory}
              onChange={(e) => setDefaultCategory(e.target.value)}
            >
              {(options.includes(defaultCategory) ? options : [defaultCategory, ...options])
                .map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </div>
        </div>

        {/* The user's OWN label set, not a global list. Amazon's vocabulary is
            unpublished and probably hundreds long, but a household sees a dozen —
            and these are the dozen that actually matter. Empty until the first
            poll, which is honest: there is nothing to show yet. */}
        {labelNames.length > 0 && (
          <div>
            <div className="sfin-subtle" style={{ marginBottom: 6 }}>
              Amazon categories seen on your orders. Change any that were filed wrong:
            </div>
            <div className="sfin-disc-inset">
              {labelNames.map((label) => {
                const resolved = resolveAmazonCategory(label, {
                  defaultCategory, labelOverrides: overrides,
                });
                const entry = categories.find((c) => c.name === resolved.category);
                return (
                  <div
                    key={label}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '4px 0', flexWrap: 'wrap',
                    }}
                  >
                    <span style={{ flex: '1 1 140px', minWidth: 0 }}>
                      {label}
                      {/* Called out, not hidden: this one landed in the default
                          rather than matching a rule, which is exactly the case
                          worth a glance. */}
                      {!resolved.matched && (
                        <span className="sfin-subtle"> · no rule yet</span>
                      )}
                    </span>
                    <span aria-hidden="true">→</span>
                    {entry && <CategoryIcon name={entry.icon} />}
                    <select
                      className="sfin-select"
                      aria-label={`Wealthfolio category for Amazon's ${label}`}
                      style={{ flex: '1 1 140px' }}
                      value={resolved.category}
                      onChange={(e) => setOverrides((o) => ({ ...o, [label]: e.target.value }))}
                    >
                      {(options.includes(resolved.category)
                        ? options
                        : [resolved.category, ...options]
                      ).map((name) => <option key={name} value={name}>{name}</option>)}
                    </select>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {status && <div role="status" className="sfin-status">{status}</div>}

        <div>
          <Button variant="primary" disabled={!configured} onClick={save}>
            Save Amazon Settings
          </Button>
        </div>
      </div>
    </CollapsibleCard>
  );
}
