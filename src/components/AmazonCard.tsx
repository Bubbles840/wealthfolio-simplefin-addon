import React, { useCallback, useEffect, useState } from 'react';
import { Button, CollapsibleCard, Disclosure, statusToneClass } from './ui';
import type { StatusMessage } from './ui';
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
/** The four fields plus the per-label overrides: everything the card edits and
 *  commits as one `amazon_config` secret. */
export interface AmazonDraft {
  host: string;
  user: string;
  password: string;
  defaultCategory: string;
  overrides: Record<string, string>;
}

const EMPTY_AMAZON_DRAFT: AmazonDraft = {
  host: 'imap.gmail.com',
  user: '',
  password: '',
  defaultCategory: DEFAULT_AMAZON_CATEGORY,
  overrides: {},
};

/**
 * The card's draft and everything derived from it, owned by the shell.
 *
 * Same hazard as the Telegram draft, with a worse payload: this card holds a real
 * IMAP **app password**, and it lived in `useState` inside a tab that `TabPanel`
 * genuinely unmounts. Paste the password, click Overview, come back — gone, and
 * unlike the Telegram tab there was not even a save bar to hint that something
 * had been pending. So the state lives in `SyncPage` and arrives as a prop.
 */
export interface AmazonDraftState {
  draft: AmazonDraft;
  /** A patch, or a function of the previous draft producing one — the label
   *  dropdowns need the functional form, since several can be changed before
   *  React re-renders. */
  patch: (p: Partial<AmazonDraft> | ((prev: AmazonDraft) => Partial<AmazonDraft>)) => void;
  /** Amazon's own label vocabulary as seen on this user's orders. */
  labels: AmazonLabelCatalog;
  /** Has the stored config been read yet? Distinguishes "loading" from "not set
   *  up", which the collapsed summary says out loud. */
  loaded: boolean;
  dirty: boolean;
  configured: boolean;
  save: () => Promise<void>;
}

/**
 * Holds the Amazon draft, called by the shell. One-shot load on `[store]`: the
 * shell polls `getAmazonConfig` every 60 seconds for Overview's checklist, and a
 * draft that re-hydrated on that timer would overwrite a half-typed password.
 */
export function useAmazonDraft(store: SecretsStore): AmazonDraftState {
  const [draft, setDraft] = useState<AmazonDraft>(EMPTY_AMAZON_DRAFT);
  /** What is actually stored — the other half of `dirty`, exactly as the
   *  Telegram tab's `savedCfg` is. */
  const [saved, setSaved] = useState<AmazonDraft>(EMPTY_AMAZON_DRAFT);
  const [labels, setLabels] = useState<AmazonLabelCatalog>({});
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([store.getAmazonConfig(), store.getAmazonLabels()])
      .then(([cfg, seen]) => {
        if (cfg) {
          const stored: AmazonDraft = {
            host: cfg.host || 'imap.gmail.com',
            user: cfg.user ?? '',
            password: cfg.password ?? '',
            defaultCategory: cfg.defaultCategory || DEFAULT_AMAZON_CATEGORY,
            overrides: cfg.labelOverrides ?? {},
          };
          setDraft(stored);
          setSaved(stored);
        }
        setLabels(seen);
      })
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [store]);

  const patch = useCallback(
    (p: Partial<AmazonDraft> | ((prev: AmazonDraft) => Partial<AmazonDraft>)) => {
      setDraft((prev) => ({ ...prev, ...(typeof p === 'function' ? p(prev) : p) }));
    },
    [],
  );

  const save = useCallback(async () => {
    await store.setAmazonConfig({
      enabled: true,
      host: draft.host,
      user: draft.user,
      password: draft.password,
      defaultCategory: draft.defaultCategory,
      labelOverrides: draft.overrides,
    } satisfies AmazonMailConfig);
    setSaved(draft);
  }, [draft, store]);

  return {
    draft,
    patch,
    labels,
    loaded,
    dirty: JSON.stringify(draft) !== JSON.stringify(saved),
    configured: !!(draft.host && draft.user && draft.password),
    save,
  };
}

interface Props {
  /** The draft, owned by the shell so it outlives the Advanced panel
   *  unmounting. */
  amazon: AmazonDraftState;
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
  amazon, cardId, guideId, open, guideOpen, onToggle, onToggleGuide, categories,
}: Props) {
  const { draft, patch, labels, loaded, dirty, configured } = amazon;
  const { host, user, password, defaultCategory, overrides } = draft;
  /** `{ text, tone }` like every other status line in the addon: the ✅ this
   *  message used to open with was its only success signal, so dropping the
   *  emoji without a tone would have left it the one status that says nothing
   *  about whether it went well. */
  const [status, setStatus] = useState<StatusMessage | null>(null);

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
    await amazon.save();
    setStatus({
      text: 'Saved. The companion will read the mailbox on its next sync.',
      tone: 'ok',
    });
  };

  return (
    <CollapsibleCard
      id={cardId}
      title="Amazon categorization"
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
          title="How to set this up (one time)"
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
              Settings → Filters → Create a new filter, and put those addresses in{' '}
              <strong>From</strong> only.
              <br />
              <span className="sfin-subtle">
                Leave the <strong>To</strong> field empty — it means "addressed to",
                and Amazon addresses its mail to you, so anything there makes the
                filter match nothing at all.
              </span>
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
            <li>
              Still on the new account, add a filter so Google stops treating the
              forwards as spam: search <code>from:amazon.com</code> → Create filter →
              tick <strong>Never send it to Spam</strong>. Forwarded mail gets
              spam-flagged routinely, and Google deletes spam after 30 days.
              <br />
              <span className="sfin-subtle">
                Spam is read anyway, so a missed filter costs you nothing immediately
                — this is about Google not deleting the receipts.
              </span>
            </li>
            <li>Paste that address and app password below, and save.</li>
          </ol>
          <div className="sfin-callout" style={{ marginTop: 8 }}>
            <strong>Why a separate account.</strong> No email provider lets an app read
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
              onChange={(e) => patch({ host: e.target.value })}
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
              onChange={(e) => patch({ user: e.target.value })}
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
              onChange={(e) => patch({ password: e.target.value })}
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
              onChange={(e) => patch({ defaultCategory: e.target.value })}
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
                      onChange={(e) =>
                        patch((prev) => ({
                          overrides: { ...prev.overrides, [label]: e.target.value },
                        }))
                      }
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

        {status && (
          <div role="status" className={`sfin-status ${statusToneClass(status.tone)}`}>
            {status.text}
          </div>
        )}

        {/* The same pill the Notifications tab uses, for the same reason: an app
            password typed and not saved is the one thing in this card worth
            losing sleep over, and the card used to give no sign at all that
            anything was pending. Only shown while something IS pending — its
            appearing is the notification, its going away the confirmation.

            `aria-live` rather than a second `role="status"`: this card already
            owns one status region (the save confirmation just above), and two
            live regions in one card announce over each other. */}
        <div className={dirty ? 'sfin-savebar' : undefined}>
          <div className="sfin-savebar-msg" aria-live="polite">
            {dirty && <span className="sfin-subtle">You have unsaved changes</span>}
          </div>
          <Button variant="primary" disabled={!configured} onClick={save}>
            Save Amazon settings
          </Button>
        </div>
      </div>
    </CollapsibleCard>
  );
}
