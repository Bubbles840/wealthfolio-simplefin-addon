import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, CollapsibleCard, Disclosure, ErrorBox, statusToneClass, Why } from './ui';
import type { StatusMessage } from './ui';
import { CategoryIcon } from './CategoryIcon';
import {
  DEFAULT_AMAZON_CATEGORY,
  normalizeAppPassword,
  resolveAmazonCategory,
  type AmazonLabelCatalog,
  type AmazonMailConfig,
} from '../../shared/amazon-config';
import type { CategoryCatalogEntry, SecretsStore } from '../utils/secrets';
import type { AmazonMailSample, AmazonMailSamples, AmazonMailStatus } from '../../shared/status-keys';
import { amazonSamplesAsFixtureText } from '../../shared/amazon-sample';

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
  /**
   * Companion-published count of order emails the parser could not read on
   * the last mail scan — a possible Amazon format change. `null` means either
   * nothing to report or an older companion that never publishes this key;
   * the two must be visually identical (see `getAmazonMailStatus`).
   */
  mailStatus: AmazonMailStatus | null;
  /** The unreadable emails, when the companion published any. Optional so a
   *  hand-built state (tests, an older page) needs no change. */
  samples?: AmazonMailSamples | null;
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
  const [mailStatus, setMailStatus] = useState<AmazonMailStatus | null>(null);
  const [samples, setSamples] = useState<AmazonMailSamples | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    // Loaded alongside config + labels, on the same one-shot mount effect —
    // not its own poll, for the same reason the draft itself is one-shot: a
    // re-hydrate on a timer would fight a half-typed password.
    Promise.all([
      store.getAmazonConfig(),
      store.getAmazonLabels(),
      store.getAmazonMailStatus(),
      // Optional-called: a store (or test double) from before the samples
      // existed has no such method, and must read as "nothing to show".
      store.getAmazonMailSamples?.() ?? null,
    ])
      .then(([cfg, seen, status, unreadable]) => {
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
        setMailStatus(status);
        setSamples(unreadable ?? null);
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
      // Google's app passwords are shown with spaces that IMAP rejects.
      password: normalizeAppPassword(draft.password),
      defaultCategory: draft.defaultCategory,
      labelOverrides: draft.overrides,
    } satisfies AmazonMailConfig);
    setSaved(draft);
  }, [draft, store]);

  return {
    draft,
    patch,
    labels,
    mailStatus,
    samples,
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
  const { draft, patch, labels, mailStatus, samples, loaded, dirty, configured } = amazon;
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

  // Only meaningful once the mailbox is actually configured: an `unparsed`
  // count with no configured mailbox is a stale value left over from before a
  // reset, not a live problem to surface.
  const unparsed = configured ? (mailStatus?.unparsed ?? 0) : 0;
  // Same rule: a sign-in error is only live while a mailbox is configured.
  const signInError = configured ? mailStatus?.error ?? null : null;
  // The companion has read this mailbox, successfully, and never found a
  // single message in it — the signature of a Gmail filter that forwards
  // nothing. Not shown before the first check (no `asOf`), when it would be
  // a guess.
  const neverReceived = configured && !!mailStatus?.asOf && !signInError && !mailStatus?.lastMailAt;

  const summaryBase = !loaded
    ? 'Loading…'
    : !configured
      ? 'Not set up — Amazon charges stay uncategorized'
      : unmatched > 0
        ? `On · ${labelNames.length} categories seen, ${unmatched} need a rule`
        : `On · ${labelNames.length} Amazon categories mapped`;
  // Appended, not replacing: a collapsed card is the one place this warning
  // could otherwise hide entirely, so the summary line has to carry it too.
  const summary = signInError
    ? `${summaryBase} · cannot sign in to the mailbox`
    : unparsed > 0
      ? `${summaryBase} · ${unparsed} email${unparsed === 1 ? '' : 's'} unread`
      : summaryBase;

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
      {signInError && (
        <ErrorBox detail={signInError}>
          The companion could not sign in to {user || 'the mailbox'} on its last check, so
          Amazon charges are not being categorized. Check the address and the app
          password (paste it exactly as Google shows it — the spaces are fine).
        </ErrorBox>
      )}

      {neverReceived && (
        <div className="sfin-callout">
          No Amazon emails have reached this mailbox yet. Check that the Gmail filter&apos;s{' '}
          <strong>To</strong> field is empty.
          <Why>
            A filter with anything in its To field matches no Amazon mail, so nothing is
            forwarded and nothing fails. Gmail also only forwards mail that arrives after
            the filter is made, so an order placed before then never shows up here.
          </Why>
        </div>
      )}

      {unparsed > 0 && (
        <ErrorBox>
          {unparsed} recent email{unparsed === 1 ? '' : 's'} could not be read — Amazon
          may have changed their email format. They stay unread in the mailbox, and
          their charges won&apos;t get an Amazon category until this addon gets an update.
        </ErrorBox>
      )}

      {unparsed > 0 && samples && samples.samples.length > 0 && (
        <UnreadableSamples samples={samples.samples} />
      )}

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

/**
 * The emails the parser could not read, ready to paste into a bug report — and
 * from there straight into `shared/__fixtures__/amazon-emails/` as a test.
 *
 * A textarea as well as a Copy button: the addon runs in a sandboxed iframe,
 * where the clipboard API may be refused, and a selectable box always works.
 */
function UnreadableSamples({ samples }: { samples: AmazonMailSample[] }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  const text = useMemo(() => amazonSamplesAsFixtureText(samples), [samples]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  };
  return (
    <div className="sfin-disc-inset" style={{ marginBottom: 12 }}>
      <Disclosure
        id="amazon-unreadable"
        variant="inline"
        title="Show what couldn't be read"
        open={open}
        onToggle={() => setOpen((o) => !o)}
      >
        <p className="sfin-subtle">
          Email addresses, your name and delivery line, card digits and link codes are
          removed — but check the text before posting it anywhere public. Paste it into
          a bug report so the addon can learn the new format.
        </p>
        <textarea
          readOnly
          aria-label="Emails that could not be read"
          value={text}
          rows={10}
          style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }}
          onFocus={(e) => e.currentTarget.select()}
        />
        <div style={{ marginTop: 8 }}>
          <Button variant="outline" onClick={copy}>Copy</Button>
          {copied === 'ok' && <span className="sfin-subtle"> Copied.</span>}
          {copied === 'failed' && (
            <span className="sfin-subtle"> Couldn&apos;t copy here — select the text above and copy it.</span>
          )}
        </div>
      </Disclosure>
    </div>
  );
}
