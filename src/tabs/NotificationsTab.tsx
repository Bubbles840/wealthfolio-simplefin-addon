import React, { useCallback, useEffect, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { Button } from '../components/ui';
import type { StatusMessage } from '../components/ui';
import { TelegramConnect } from '../components/TelegramConnect';
import { ReportSettings } from '../components/ReportSettings';
import { ReportContent } from '../components/ReportContent';
// The real default the sync engine applies when driftAlertThreshold is absent,
// imported rather than re-typed so the field can never disagree with it.
import { DEFAULT_DRIFT_ALERT_THRESHOLD_DOLLARS } from '../../shared/sync-core';
import type { SecretsStore, CategoryCatalogEntry } from '../utils/secrets';

/** Amount the "Large transaction alerts" field is seeded with. Purely a UI
 *  suggestion: the stored default is OFF (see `largeTransactionThreshold`), so
 *  this number only ever reaches storage once the user ticks the box. */
export const SUGGESTED_LARGE_TX_THRESHOLD = 500;

/** Mirrors the companion's `DEFAULT_WEEKLY_TOP_SPEND_COUNT`, which is module-
 *  private in companion/src/index.ts and so cannot be imported across the
 *  package boundary. Keep the two in step. */
export const DEFAULT_WEEKLY_TOP_SPEND_COUNT = 5;

/**
 * Every setting the old "Telegram Notifications" mega-card held, as ONE object.
 *
 * Held as a draft rather than as eighteen `useState` hooks because the tab now
 * commits on a dirty-state save bar: "does what is on screen differ from what is
 * stored?" is a question about the whole set, and answering it needs the set to
 * be one comparable value.
 *
 * The two amounts and the count are strings, deliberately: they are what the
 * user typed, so a half-typed field isn't coerced to 0 mid-keystroke. They are
 * turned into numbers exactly once, by `buildConfig`.
 *
 * The last three fields are the exception to "one secret, one object" — glyph
 * style and subcategory display live in their own secrets and have always been
 * written the instant they change, so they travel in the draft (they are this
 * tab's state) but are excluded from the dirty comparison. See `changeNow`.
 */
export interface TelegramCfgDraft {
  botToken: string;
  chatId: string;
  notifyOnImport: boolean;
  dailyReportEnabled: boolean;
  weeklyReportEnabled: boolean;
  monthlyReportEnabled: boolean;
  dailyReportCategories: string[] | 'all';
  weeklyReportCategories: string[] | 'all';
  monthlyReportCategories: string[] | 'all';
  /** Each threshold is a checkbox PLUS an amount, never an amount alone — see
   *  `thresholdToSave` for why an empty field cannot express "off". */
  largeTxAlerts: boolean;
  largeTxAmount: string;
  driftAlertsOn: boolean;
  driftAmount: string;
  topSpendsOn: boolean;
  topSpendCount: string;
  glyphMode: 'clean' | 'glyphs';
  glyphOverrides: Record<string, string>;
  subcategoryDisplay: 'rollup' | 'breakdown';
  countOffBudget: boolean;
  capWeeklyToPool: boolean;
}

/**
 * A patch, or a function of the previous draft producing one.
 *
 * The functional form is what keeps the category matrix correct: two checkbox
 * toggles batched into one React tick must each see the previous value, not the
 * same stale snapshot (which dropped the first). It is the `setState` updater
 * contract, preserved through the controlled-component boundary.
 */
export type CfgPatch =
  | Partial<TelegramCfgDraft>
  | ((prev: TelegramCfgDraft) => Partial<TelegramCfgDraft>);

/** Ids for this tab's collapsible sections. Doubles as the persisted key set
 *  (the page owns the map), so `connection` keeps the old card's `telegram` key
 *  and `categories` keeps `report-categories`: a user who left either open
 *  finds it open. */
export const NOTIF_CARD = {
  connection: 'telegram',
  reports: 'telegram-reports',
  content: 'telegram-content',
  guide: 'telegram-guide',
  categories: 'report-categories',
} as const;

/**
 * The two dollar thresholds mean opposite things when absent — `largeTransaction`
 * is OFF, `driftAlert` is ON at $100 — so neither can be expressed by an empty
 * number field. Each gets an explicit checkbox instead, and saving always writes
 * a number: the amount when on, `0` (which both readers treat as off) when off.
 * That is what lets a user actually turn drift alerts off instead of clearing
 * the field and silently getting the $100 default back.
 */
export function thresholdToSave(on: boolean, raw: string, fallback: number): number {
  if (!on) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * `weeklyTopSpendCount` sits between the two: absent means ON at the default of
 * 5 (like the drift threshold), but `0` is also a value the user can legitimately
 * type, and it already means "hide the section" to every reader — so unticking
 * and "ticked, with 0 in the box" deliberately collapse onto the same stored `0`.
 *
 * That collapse is safe because the round trip is stable in one step: a stored 0
 * reloads UNTICKED with the number field back at its default (never showing the
 * 0, exactly as the drift row doesn't), and saving again from there stores 0. So
 * unticking, saving and reloading can never come back ticked.
 *
 * A BLANK field still falls back to the default rather than to 0 — blank is "I
 * have no opinion", which is a different statement from "none".
 */
export function countToSave(on: boolean, raw: string, fallback: number): number {
  if (!on) return 0;
  if (raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * The stored Telegram secret, built from the draft.
 *
 * A pure function, lifted verbatim out of the old Save button's object literal:
 * the payload has to stay byte-identical, because the companion reads it and a
 * refactor is not a migration. Every threshold goes through the two helpers
 * above, so an explicit `0` (= off) is stored rather than omitted.
 */
export function buildConfig(cfg: TelegramCfgDraft) {
  return {
    botToken: cfg.botToken,
    chatId: cfg.chatId,
    enabled: true,
    notifyOnImport: cfg.notifyOnImport,
    dailyReportEnabled: cfg.dailyReportEnabled,
    weeklyReportEnabled: cfg.weeklyReportEnabled,
    monthlyReportEnabled: cfg.monthlyReportEnabled,
    dailyReportCategories: cfg.dailyReportCategories,
    weeklyReportCategories: cfg.weeklyReportCategories,
    monthlyReportCategories: cfg.monthlyReportCategories,
    weeklyTopSpendCount: countToSave(
      cfg.topSpendsOn, cfg.topSpendCount, DEFAULT_WEEKLY_TOP_SPEND_COUNT,
    ),
    // Always an explicit number, never omitted: `0` is how both readers spell
    // "off", and omitting driftAlertThreshold would hand the user back the $100
    // default they just switched off.
    largeTransactionThreshold: thresholdToSave(
      cfg.largeTxAlerts, cfg.largeTxAmount, SUGGESTED_LARGE_TX_THRESHOLD,
    ),
    driftAlertThreshold: thresholdToSave(
      cfg.driftAlertsOn, cfg.driftAmount, DEFAULT_DRIFT_ALERT_THRESHOLD_DOLLARS,
    ),
  };
}

/** What an install with no stored config shows. Each default is the value the
 *  READER applies when the field is absent, so an untouched tab that gets saved
 *  stores what was already happening. */
const EMPTY_DRAFT: TelegramCfgDraft = {
  botToken: '',
  chatId: '',
  notifyOnImport: true,
  // Absent means ON for all three, so a config written before the monthly
  // report existed opts into it.
  dailyReportEnabled: true,
  weeklyReportEnabled: true,
  monthlyReportEnabled: true,
  dailyReportCategories: 'all',
  weeklyReportCategories: 'all',
  monthlyReportCategories: 'all',
  largeTxAlerts: false,
  largeTxAmount: String(SUGGESTED_LARGE_TX_THRESHOLD),
  driftAlertsOn: true,
  driftAmount: String(DEFAULT_DRIFT_ALERT_THRESHOLD_DOLLARS),
  // Absent means ON at the default of 5 — what the companion has always done —
  // so this starts true and only an explicit stored 0 unticks it.
  topSpendsOn: true,
  topSpendCount: String(DEFAULT_WEEKLY_TOP_SPEND_COUNT),
  glyphMode: 'clean',
  glyphOverrides: {},
  subcategoryDisplay: 'rollup',
  // Default ON, matching the stored opt-OUT and the weekly report.
  countOffBudget: true,
  // Also default ON, also stored as an opt-OUT.
  capWeeklyToPool: true,
};

/** Fills a draft from the stored secret. A stored number is authoritative;
 *  anything else (absent, null, a string) reads as "never configured" and takes
 *  the field's default. */
function draftFromStored(
  tg: any,
  glyph: { mode: 'clean' | 'glyphs'; overrides: Record<string, string> },
  subcategoryDisplay: 'rollup' | 'breakdown',
  countOffBudget: boolean,
  capWeeklyToPool: boolean,
): TelegramCfgDraft {
  const base: TelegramCfgDraft = {
    ...EMPTY_DRAFT,
    glyphMode: glyph.mode,
    glyphOverrides: glyph.overrides,
    subcategoryDisplay,
    countOffBudget,
    capWeeklyToPool,
  };
  if (!tg) return base;

  const num = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  // Absent → off. Only a positive amount turns it on.
  const largeTx = num(tg.largeTransactionThreshold);
  // Absent → ON at the engine's default. Only an explicit 0-or-negative is the
  // user having turned it off, which is why the amount field keeps its default
  // rather than showing the stored 0.
  const drift = num(tg.driftAlertThreshold);
  // Same shape as the drift threshold: absent → ON at the default, an explicit
  // 0 (or negative) is the user having switched it off.
  const top = num(tg.weeklyTopSpendCount);

  return {
    ...base,
    botToken: tg.botToken ?? '',
    chatId: tg.chatId ?? '',
    notifyOnImport: tg.notifyOnImport ?? true,
    dailyReportEnabled: tg.dailyReportEnabled ?? true,
    weeklyReportEnabled: tg.weeklyReportEnabled ?? true,
    monthlyReportEnabled: tg.monthlyReportEnabled ?? true,
    dailyReportCategories: tg.dailyReportCategories ?? 'all',
    weeklyReportCategories: tg.weeklyReportCategories ?? 'all',
    monthlyReportCategories: tg.monthlyReportCategories ?? 'all',
    largeTxAlerts: largeTx !== null && largeTx > 0,
    largeTxAmount: largeTx !== null && largeTx > 0 ? String(largeTx) : base.largeTxAmount,
    driftAlertsOn: drift === null || drift > 0,
    driftAmount: drift !== null && drift > 0 ? String(drift) : base.driftAmount,
    topSpendsOn: top === null || top > 0,
    topSpendCount: top !== null && top > 0 ? String(Math.floor(top)) : base.topSpendCount,
  };
}

/**
 * The draft, and everything derived from it, as ONE value owned by the shell.
 *
 * It used to be `useState` inside the tab — which was silent data loss, because
 * `TabPanel` genuinely unmounts an inactive tab. Type a bot token, click Overview
 * to glance at a balance, come back: the token was gone, the draft had been
 * re-read from storage, and the save bar now reported that nothing was pending.
 * No warning, no way to get it back.
 *
 * So the state lives in `SyncPage` (see `useTelegramDraft`) and arrives here as a
 * prop. Same reasoning the shell already documents for the derived signals: the
 * tab is unmounted at exactly the moments that matter, so anything that has to
 * outlive a tab switch cannot be the tab's.
 */
export interface TelegramDraftState {
  cfg: TelegramCfgDraft;
  /** Patch the draft. Nothing reaches storage until `save`. */
  change: (patch: CfgPatch) => void;
  /** The three fields that are their own stored values and write immediately. */
  changeNow: (patch: Partial<TelegramCfgDraft>) => void;
  /** Does what is on screen differ from what is stored? */
  dirty: boolean;
  /** Bot token AND chat ID present — what makes the config sendable at all. */
  configured: boolean;
  save: () => Promise<void>;
}

/**
 * Holds the draft for `NotificationsTab`, called by the shell so it survives the
 * tab unmounting. Lives in this file because everything it needs — `EMPTY_DRAFT`,
 * `draftFromStored`, `buildConfig` — is this tab's knowledge; only the `useState`
 * calls moved out of the component.
 *
 * The load is one-shot on `[store]`, deliberately: the shell re-reads the stored
 * Telegram config every 60 seconds for Overview's derived signals, and a draft
 * that re-hydrated on that timer would wipe whatever the user was typing.
 */
export function useTelegramDraft(store: SecretsStore): TelegramDraftState {
  const [cfg, setCfg] = useState<TelegramCfgDraft>(EMPTY_DRAFT);
  /** What is actually in storage. Same value as `cfg` on load and after a save,
   *  so `dirty` is false at both. */
  const [savedCfg, setSavedCfg] = useState<TelegramCfgDraft>(EMPTY_DRAFT);

  useEffect(() => {
    Promise.all([
      store.getTelegramConfig(),
      store.getReportGlyphStyle(),
      store.getSubcategoryDisplay(),
      // Optional-called: a store without it throws SYNCHRONOUSLY here, which
      // `.catch` never sees — it would take the whole Notifications tab's load
      // down over one setting. `true` is the default either way.
      store.getCountOffBudget?.() ?? true,
      store.getCapWeeklyToPool?.() ?? true,
    ]).then(([tg, glyph, subcat, offBudget, capWeekly]) => {
      const loaded = draftFromStored(tg, glyph, subcat, offBudget, capWeekly);
      setCfg(loaded);
      setSavedCfg(loaded);
    }).catch(() => {});
  }, [store]);

  const change = useCallback((patch: CfgPatch) => {
    setCfg((prev) => ({ ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }));
  }, []);

  /**
   * The three fields that are NOT part of the Telegram secret: glyph style and
   * subcategory display are their own stored values, and changing one has always
   * written it immediately. So they are saved here and mirrored into `savedCfg`
   * in the same breath — a setting that is already stored must not raise a bar
   * offering to store it.
   */
  const changeNow = useCallback((patch: Partial<TelegramCfgDraft>) => {
    // Computed outside the state updater: writing a secret from inside one fires
    // twice under StrictMode.
    const next = { ...cfg, ...patch };
    setCfg(next);
    setSavedCfg((prev) => ({ ...prev, ...patch }));
    if ('glyphMode' in patch || 'glyphOverrides' in patch) {
      store.setReportGlyphStyle({ mode: next.glyphMode, overrides: next.glyphOverrides })
        .catch(() => {});
    }
    if ('subcategoryDisplay' in patch) {
      store.setSubcategoryDisplay(next.subcategoryDisplay).catch(() => {});
    }
    if ('countOffBudget' in patch) {
      store.setCountOffBudget?.(next.countOffBudget)?.catch(() => {});
    }
    if ('capWeeklyToPool' in patch) {
      store.setCapWeeklyToPool?.(next.capWeeklyToPool)?.catch(() => {});
    }
  }, [cfg, store]);

  const save = useCallback(async () => {
    await store.setTelegramConfig(buildConfig(cfg));
    setSavedCfg(cfg);
  }, [cfg, store]);

  // A comparison, not a flag: every path that changes a setting goes through
  // `change`, so there is nothing to remember to mark dirty. The immediate
  // fields cannot show up here — `changeNow` moves both copies at once.
  const dirty = JSON.stringify(cfg) !== JSON.stringify(savedCfg);
  // Local to the draft now: it only gates the Save button and the line that says
  // why Save is unavailable. It used to ALSO be reported up to the page's setup
  // checklist — which broke the moment inactive tabs started unmounting, since
  // the effect that reported it stops firing and the checklist keeps a value
  // that may be months out of date. The page reads the stored config instead.
  const configured = !!cfg.botToken && !!cfg.chatId;

  return { cfg, change, changeNow, dirty, configured, save };
}

interface Props {
  ctx: AddonContext;
  /** The draft, owned by the shell so it outlives this panel unmounting. */
  draft: TelegramDraftState;
  /** Loaded by the page (the Amazon card needs it too), so it arrives as a prop
   *  rather than being read a second time. */
  categories: CategoryCatalogEntry[];
  isOpen: (id: string) => boolean;
  toggleCard: (id: string) => void;
}

/**
 * Everything Telegram, in three cards and one save bar.
 *
 * It was one card holding six unrelated things — credentials, which reports to
 * send, alert amounts, a 50-row category matrix, emoji styling, subcategory
 * display — with a single Save button at the very bottom. Splitting it means
 * each card answers one question and can be collapsed once answered; hoisting
 * the commit into a sticky save bar means the control that saves is never
 * hundreds of pixels below the control you changed.
 *
 * The three cards are CONTROLLED: they hold no settings state of their own, so
 * the draft and the "what is stored" snapshot exist in exactly one place and
 * `dirty` is a comparison rather than a flag anyone has to remember to set.
 *
 * That one place is the SHELL, not this component — see `useTelegramDraft`. The
 * only state left here is the transient status line, which describes the last
 * action taken on this tab and is worth nothing once you have left it.
 */
export function NotificationsTab({
  ctx, draft, categories, isOpen, toggleCard,
}: Props) {
  const { cfg, change, changeNow, dirty, configured, save } = draft;
  /** The connection card's status line. `{ text, tone }` so the colour is data
   *  rather than something re-derived from the wording — see `statusToneClass`. */
  const [status, setStatus] = useState<StatusMessage | null>(null);

  return (
    <>
      <TelegramConnect
        cfg={cfg}
        onChange={change}
        ctx={ctx}
        status={status}
        onStatus={setStatus}
        isOpen={isOpen}
        toggleCard={toggleCard}
      />

      <ReportSettings
        cfg={cfg}
        onChange={change}
        isOpen={isOpen}
        toggleCard={toggleCard}
      />

      <ReportContent
        cfg={cfg}
        onChange={change}
        onChangeNow={changeNow}
        categories={categories}
        isOpen={isOpen}
        toggleCard={toggleCard}
      />

      {/* The PILL is only there while something is pending — a permanent bar
          would be a permanent claim that something needs saving; this one
          appearing IS the notification, and its disappearing is the
          confirmation. The wrapper, however, is mounted always and collapses to
          nothing when idle, because the live region inside it has to pre-exist
          its own content: a role="status" element inserted into the DOM already
          populated is announced unreliably or not at all. */}
      <div className={dirty ? 'sfin-savebar' : undefined}>
        {/* Scoped to the message, deliberately excluding the button: with the
            region around both, the announcement picked up the word "Save" as if
            it were part of the sentence. */}
        <div className="sfin-savebar-msg" role="status">
          {dirty && <span className="sfin-subtle">You have unsaved changes</span>}
          {/* Why the button is dead, said out loud. It used to be a `title` on
              the disabled button, which keyboard and touch users never see. */}
          {dirty && !configured && (
            <span className="sfin-subtle">Add a bot token and chat ID first</span>
          )}
        </div>
        {dirty && (
          <Button
            variant="primary"
            // The credentials are what make the config sendable at all, so an
            // incomplete pair cannot be committed — as the old Save button also
            // refused to be.
            disabled={!configured}
            onClick={async () => {
              await save();
              setStatus({ text: 'Telegram settings saved.', tone: 'ok' });
            }}
          >
            Save
          </Button>
        )}
      </div>
    </>
  );
}
