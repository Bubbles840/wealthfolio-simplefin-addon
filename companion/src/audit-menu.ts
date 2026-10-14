/**
 * companion/src/audit-menu.ts
 *
 * `/audit` (2c R1, spec A4): the three checks in Telegram, run LIVE on every
 * tap, plus the 🔎 buttons `/status` puts under an account that is off.
 * STATELESS like why-menu.ts: every tap re-reads, and every button carries
 * where it leads. After `cz:au:`:
 *   m              the menu (Balances · Spent vs Wealthfolio · Health), in place
 *   b              the mapped accounts, one button each, in place
 *   a<handle>      one account's explanation, in place, Back to the accounts
 *   s<handle>      one account's explanation as a NEW message (/status's 🔎)
 *   h              the report's spending against Wealthfolio's, in place
 *   r<handle>      one reason's rows, in place, Back to the month
 *   i              what Health flags, in place
 *   x<handle>      one issue, in place, Back to Health
 *   l<pair>        R2: link one pair, then Health again, in place
 *   L<handle>      R2: link every pair the Health list showed, then Health again
 * `<handle>` is `findingHandle` of the account's Wealthfolio id, of
 * `reason:<kind>`, of the issue's key, or of every pair a list showed — 8
 * hex; `<pair>` is both legs' fingerprints (shared/audit-link.ts), 16 hex, so
 * the longest button is 23 bytes. Nothing else may start with `cz:au`.
 *
 * Link (2c R2) appears only when the deps can link (`link`): on the Health
 * list, under each leg with one likely other half, that half, a "Link N" per
 * pair and "Link all N" for two or more; on the issue's own screen, "Link".
 * The list is the preview: a tap re-reads Health and links only a pair whose
 * legs still read exactly as the button carried them. A tap that finds none
 * (a double tap's second run, say) answers "It has changed since — nothing
 * was linked." as a toast and leaves the message as it is.
 *
 * Bank and user text is escaped AND kept outside every `*…*`; the only
 * entities are fixed headings. Button labels are plain text, not escaped.
 */
import {
  balanceCauseLines, balanceHeaderLine, balanceIncludesLine, balanceShort, explainBalances, type BalanceExplanation,
  type BalanceReport,
} from '../../shared/audit-balance.js';
import {
  explainHeadline, headlineAgrees, headlineReasonLine, headlineRowLine, headlineSummaryLine, headlineUnexplainedLine,
  HEADLINE_AGREE, HEADLINE_REASON_LABELS, type HeadlineExplanation, type HeadlineReason, type HeadlineRow,
} from '../../shared/audit-headline.js';
import {
  healthCount, healthIssueLines, healthIssues, healthIssueTitle, healthLegLine, HEALTH_NONE, type HealthIssue, type HealthLeg,
  type HealthReport,
} from '../../shared/audit-health.js';
import {
  linkablePair, linkablePairs, linkAllButton, pairHandle, pairsHandle, LINK_BUTTON, LINK_CHANGED, type LinkPair, type LinkRun,
} from '../../shared/audit-link.js';
import { findingHandle } from '../../shared/handle.js';
import { escapeMarkdown, type InlineKeyboard } from '../../shared/telegram.js';
import { TX_STORY_UNREACHABLE } from '../../shared/tx-story.js';
import { gatherBalanceFacts, gatherHeadlineFacts, gatherHealthFacts, readAuditLedger, type AuditReaders } from './audit-facts.js';

export const AUDIT_CALLBACK_PREFIX = 'cz:au:';
export const AUDIT_TITLE = 'Audit';
export const AUDIT_INTRO = "Why a balance or this month's spending differs from Wealthfolio, and what its Health page flags. Every tap checks again.";
export const AUDIT_UNREACHABLE = TX_STORY_UNREACHABLE;
export const AUDIT_NO_ACCOUNTS = 'No accounts are mapped yet.';
export const AUDIT_TAP_ACCOUNT = 'Tap an account to see why.';
export const AUDIT_ACCOUNT_GONE = "That account isn't mapped any more — send /audit again.";
export const AUDIT_REASON_GONE = 'That reason has nothing in it now.';
export const AUDIT_ISSUE_GONE = 'Health has changed since — that one is gone.';
export const AUDIT_BALANCES_BUTTON = 'Balances';
export const AUDIT_HEADLINE_BUTTON = 'Spent vs Wealthfolio';
/** Lines one message lists before "…and N more". */
export const AUDIT_LIST_MAX = 20;
const BACK = '⬅️ Back';
const FAILED_ANSWER = 'Could not do that — check the companion logs.';

type Button = { text: string; callback_data: string };
export interface MenuScreen { text: string; keyboard: InlineKeyboard }

export type AuditView =
  | { kind: 'menu' }
  | { kind: 'balances' }
  /** `fresh`: from /status — a new message with no Back. */
  | { kind: 'account'; handle: string; fresh: boolean }
  | { kind: 'headline' }
  | { kind: 'reason'; handle: string }
  | { kind: 'health' }
  | { kind: 'issue'; handle: string }
  /** `handle`: `pairHandle`, 16 hex. */
  | { kind: 'link'; handle: string }
  /** `handle`: `pairsHandle` of every pair the list showed. */
  | { kind: 'link-all'; handle: string };

export function auditData(view: AuditView): string {
  switch (view.kind) {
    case 'menu': return `${AUDIT_CALLBACK_PREFIX}m`;
    case 'balances': return `${AUDIT_CALLBACK_PREFIX}b`;
    case 'account': return `${AUDIT_CALLBACK_PREFIX}${view.fresh ? 's' : 'a'}${view.handle}`;
    case 'headline': return `${AUDIT_CALLBACK_PREFIX}h`;
    case 'reason': return `${AUDIT_CALLBACK_PREFIX}r${view.handle}`;
    case 'health': return `${AUDIT_CALLBACK_PREFIX}i`;
    case 'issue': return `${AUDIT_CALLBACK_PREFIX}x${view.handle}`;
    case 'link': return `${AUDIT_CALLBACK_PREFIX}l${view.handle}`;
    case 'link-all': return `${AUDIT_CALLBACK_PREFIX}L${view.handle}`;
  }
}

/** The view a button carries, or null for anything this menu never emitted. */
export function parseAuditData(data: string): AuditView | null {
  if (!data.startsWith(AUDIT_CALLBACK_PREFIX)) return null;
  const s = data.slice(AUDIT_CALLBACK_PREFIX.length);
  if (s === 'm') return { kind: 'menu' };
  if (s === 'b') return { kind: 'balances' };
  if (s === 'h') return { kind: 'headline' };
  if (s === 'i') return { kind: 'health' };
  const link = /^l([0-9a-f]{16})$/.exec(s);
  if (link) return { kind: 'link', handle: link[1] };
  const all = /^L([0-9a-f]{8})$/.exec(s);
  if (all) return { kind: 'link-all', handle: all[1] };
  const m = /^([asrx])([0-9a-f]{8})$/.exec(s);
  if (!m) return null;
  if (m[1] === 'a' || m[1] === 's') return { kind: 'account', handle: m[2], fresh: m[1] === 's' };
  return m[1] === 'r' ? { kind: 'reason', handle: m[2] } : { kind: 'issue', handle: m[2] };
}

export const accountHandle = (wfAccountId: string) => findingHandle(wfAccountId);
export const reasonHandle = (r: Pick<HeadlineReason, 'kind'>) => findingHandle(`reason:${r.kind}`);
export const issueHandle = (i: Pick<HealthIssue, 'key'>) => findingHandle(i.key);

const clip = (s: string, n: number) => {
  const chars = Array.from(s);
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : s;
};
/** Bank descriptions are unbounded; a message holds 4,096 characters. */
export const AUDIT_DESCRIPTION_MAX = 60;
const clipRow = (r: HeadlineRow): HeadlineRow => ({ ...r, description: clip(r.description, AUDIT_DESCRIPTION_MAX) });
const clipLeg = (l: HealthLeg): HealthLeg => ({ ...l, description: clip(l.description, AUDIT_DESCRIPTION_MAX) });
const clipIssue = (i: HealthIssue): HealthIssue =>
  i.kind === 'incomplete-leg' ? { ...i, leg: clipLeg(i.leg), counterpart: i.counterpart ? clipLeg(i.counterpart) : null } : i;
const back = (view: AuditView): Button[] => [{ text: BACK, callback_data: auditData(view) }];
const noteLines = (notes: readonly string[]) => (notes.length ? ['', ...notes.map((n) => `⚠️ ${escapeMarkdown(n)}`)] : []);
const listed = <T>(items: readonly T[], more = 0) => ({
  shown: items.slice(0, AUDIT_LIST_MAX),
  hidden: Math.max(0, items.length - AUDIT_LIST_MAX) + more,
});

export function renderAuditMenu(health: HealthReport): MenuScreen {
  const n = healthCount(health);
  return {
    text: `🔎 *${AUDIT_TITLE}*\n${escapeMarkdown(AUDIT_INTRO)}`,
    keyboard: {
      inline_keyboard: [
        [{ text: AUDIT_BALANCES_BUTTON, callback_data: auditData({ kind: 'balances' }) }],
        [{ text: AUDIT_HEADLINE_BUTTON, callback_data: auditData({ kind: 'headline' }) }],
        [{ text: n === null ? 'Health' : `Health (${n})`, callback_data: auditData({ kind: 'health' }) }],
      ],
    },
  };
}

export function renderAuditBalances(report: BalanceReport): MenuScreen {
  const lines = ['🔎 *Balances*', report.accounts.length ? AUDIT_TAP_ACCOUNT : AUDIT_NO_ACCOUNTS, ...noteLines(report.notes)];
  const rows: Button[][] = report.accounts.map((e) => [{
    text: `${clip(e.name, 32)} · ${balanceShort(e)}`,
    callback_data: auditData({ kind: 'account', handle: accountHandle(e.wfAccountId), fresh: false }),
  }]);
  rows.push(back({ kind: 'menu' }));
  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}

export function renderAuditAccount(e: BalanceExplanation, notes: readonly string[], fresh: boolean): MenuScreen {
  const lines = ['🔎 *Balance*', escapeMarkdown(e.name), escapeMarkdown(balanceHeaderLine(e))];
  lines.push(...balanceCauseLines(e).map((l) => `• ${escapeMarkdown(l)}`));
  const includes = balanceIncludesLine(e);
  if (includes) lines.push(escapeMarkdown(includes));
  lines.push(...noteLines(notes));
  return { text: lines.join('\n'), keyboard: { inline_keyboard: fresh ? [] : [back({ kind: 'balances' })] } };
}

export function renderAuditHeadline(h: HeadlineExplanation): MenuScreen {
  const lines = [`🔎 *${AUDIT_HEADLINE_BUTTON}*`];
  const summary = headlineSummaryLine(h);
  if (summary) lines.push(escapeMarkdown(summary));
  const rows: Button[][] = [];
  if (headlineAgrees(h)) lines.push(escapeMarkdown(HEADLINE_AGREE));
  else if (h.reasons) {
    lines.push(...h.reasons.map((r) => `• ${escapeMarkdown(headlineReasonLine(h, r))}`));
    const rest = headlineUnexplainedLine(h);
    if (rest) lines.push(`• ${escapeMarkdown(rest)}`);
    for (const r of h.reasons) {
      rows.push([{ text: `${HEADLINE_REASON_LABELS[r.kind]} (${r.rows.length + (r.more ?? 0)})`, callback_data: auditData({ kind: 'reason', handle: reasonHandle(r) }) }]);
    }
  }
  lines.push(...noteLines(h.notes));
  rows.push(back({ kind: 'menu' }));
  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}

export function renderAuditReason(r: HeadlineReason): MenuScreen {
  const { shown, hidden } = listed(r.rows, r.more);
  const lines = [`🔎 *${HEADLINE_REASON_LABELS[r.kind]}*`, ...shown.map((row) => escapeMarkdown(headlineRowLine(clipRow(row))))];
  if (hidden > 0) lines.push(`…and ${hidden} more`);
  return { text: lines.join('\n'), keyboard: { inline_keyboard: [back({ kind: 'headline' })] } };
}

/** R2: what the Health screens add when the deps can link. `result`: what the last tap did. */
export interface HealthScreenOptions {
  link?: boolean;
  result?: string;
}

/** Telegram refuses a message over 4096 characters, and the edit's 400 would be swallowed. */
export const HEALTH_LIST_BUDGET = 2400;
export const HEALTH_RESULT_MAX = 1500;
const TOAST_MAX = 200;

/** `raw` escaped, cut so the ESCAPED text is at most `max` characters, then "…". */
function clipEscaped(raw: string, max: number): string {
  let out = '';
  for (const ch of raw) {
    const e = escapeMarkdown(ch);
    if (out.length + e.length > max) return `${out}…`;
    out += e;
  }
  return out;
}

interface HealthLayout { lines: string[]; numbers: Button[]; links: Button[]; pairs: LinkPair[] }

/**
 * The list a Health screen shows, cut to a fixed budget that does not depend on
 * the result line (so the tap, which has no result yet, reaches the same
 * cut). A Link button is offered only for a pair whose "Likely the other half"
 * line is on screen, and `pairs` is exactly those.
 */
function healthLayout(report: HealthReport, link: boolean): HealthLayout {
  const out: HealthLayout = { lines: [], numbers: [], links: [], pairs: [] };
  if (report.issues && report.issues.length === 0 && !report.more) out.lines.push(escapeMarkdown(HEALTH_NONE));
  let used = out.lines.join('\n').length;
  const notes = noteLines(report.notes);
  used += notes.join('\n').length + 40;
  let count = 0;
  if (report.issues) {
    for (const issue of report.issues.slice(0, AUDIT_LIST_MAX)) {
      const pair = link ? linkablePair(issue) : null;
      const entry = [`${count + 1}. ${escapeMarkdown(healthIssueTitle(clipIssue(issue)))}`];
      // The list is the preview: the pair the button links.
      if (pair) entry.push(`   ${escapeMarkdown(`Likely the other half: ${healthLegLine(clipLeg(pair.counterpart))}`)}`);
      const size = entry.join('\n').length + 1;
      if (count > 0 && used + size > HEALTH_LIST_BUDGET) break;
      used += size;
      count += 1;
      out.lines.push(...entry);
      out.numbers.push({ text: String(count), callback_data: auditData({ kind: 'issue', handle: issueHandle(issue) }) });
      if (pair) {
        out.pairs.push(pair);
        out.links.push({ text: `${LINK_BUTTON} ${count}`, callback_data: auditData({ kind: 'link', handle: pairHandle(pair) }) });
      }
    }
    const hidden = report.issues.length - count + (report.more ?? 0);
    if (hidden > 0) out.lines.push(`…and ${hidden} more`);
  }
  out.lines.push(...notes);
  return out;
}

/** The pairs a Health list shows: the ones its Link buttons carry. */
const shownPairs = (report: HealthReport): LinkPair[] => healthLayout(report, true).pairs;

export function renderAuditHealth(report: HealthReport, opts: HealthScreenOptions = {}): MenuScreen {
  const lay = healthLayout(report, !!opts.link);
  const lines = ['🔎 *Health*'];
  if (opts.result) lines.push(clipEscaped(opts.result, HEALTH_RESULT_MAX));
  lines.push(...lay.lines);
  const rows: Button[][] = [];
  for (let i = 0; i < lay.numbers.length; i += 4) rows.push(lay.numbers.slice(i, i + 4));
  for (let i = 0; i < lay.links.length; i += 4) rows.push(lay.links.slice(i, i + 4));
  if (lay.links.length >= 2) {
    rows.push([{ text: linkAllButton(lay.links.length), callback_data: auditData({ kind: 'link-all', handle: pairsHandle(lay.pairs) }) }]);
  }
  rows.push(back({ kind: 'menu' }));
  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}

export function renderAuditIssue(raw: HealthIssue, opts: HealthScreenOptions = {}): MenuScreen {
  const issue = clipIssue(raw);
  const lines = ['🔎 *Health*', escapeMarkdown(healthIssueTitle(issue)), ...healthIssueLines(issue).map(escapeMarkdown)];
  const pair = opts.link ? linkablePair(raw) : null;
  const rows: Button[][] = pair ? [[{ text: LINK_BUTTON, callback_data: auditData({ kind: 'link', handle: pairHandle(pair) }) }]] : [];
  rows.push(back({ kind: 'health' }));
  return { text: lines.join('\n'), keyboard: { inline_keyboard: rows } };
}

/**
 * `/status`'s buttons: a 🔎 for every account it shows "off by $X", opening
 * that account's explanation as a new message. Null when there are none (the
 * reply then goes without a keyboard, as it always did).
 */
export function auditStatusKeyboard(
  accounts: ReadonlyArray<{ name: string; drift: number | null; wfAccountId?: string }>,
): InlineKeyboard | null {
  const rows = accounts
    .filter((a) => a.drift !== null && !!a.wfAccountId)
    .map((a) => [{ text: `🔎 ${clip(a.name, 40)}`, callback_data: auditData({ kind: 'account', handle: accountHandle(a.wfAccountId!), fresh: true }) }]);
  return rows.length ? { inline_keyboard: rows } : null;
}

type Send = (text: string, keyboard?: InlineKeyboard) => Promise<void>;

export interface AuditMenuUi {
  edit(text: string, keyboard?: InlineKeyboard): Promise<void>;
  answer(text?: string): Promise<void>;
  /** A NEW message. */
  send: Send;
}

/** What one tap reads, live. `reached`: the account mapping could be read. */
export interface AuditMenuDeps {
  balances(): Promise<BalanceReport & { reached: boolean }>;
  headline(now: Date): Promise<HeadlineExplanation>;
  health(): Promise<HealthReport & { reached: boolean }>;
  /** R2: link these pairs (shared/audit-link.ts `linkPairs`). Absent: no Link buttons. */
  link?(pairs: LinkPair[]): Promise<LinkRun>;
  now(): Date;
  log(msg: string): void;
}

/** The deps over the companion's real readers (audit-facts.ts). */
export function auditMenuDeps(readers: AuditReaders, log: (msg: string) => void): AuditMenuDeps {
  return {
    balances: async () => {
      const facts = await gatherBalanceFacts(readers, readAuditLedger(readers));
      return { ...explainBalances(facts), reached: !facts.failed?.includes('mapping') };
    },
    headline: async (now) => explainHeadline(await gatherHeadlineFacts(readers, now)),
    health: async () => {
      const facts = await gatherHealthFacts(readers, readAuditLedger(readers));
      return { ...healthIssues(facts), reached: !facts.failed?.includes('mapping') };
    },
    now: () => new Date(),
    log,
  };
}

export interface AuditMenu {
  handles(data: string): boolean;
  onCallback(cb: { data: string }, ui: AuditMenuUi): Promise<void>;
  /** `/audit`: the menu, as a reply. */
  reply(send: Send): Promise<void>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
/** An empty keyboard is sent as none. */
const sendScreen = (send: Send, s: MenuScreen) => (s.keyboard.inline_keyboard.length ? send(s.text, s.keyboard) : send(s.text));

export function createAuditMenu(deps: AuditMenuDeps): AuditMenu {
  return {
    handles(data) {
      return data.startsWith(AUDIT_CALLBACK_PREFIX);
    },

    async reply(send) {
      const health = await deps.health();
      if (!health.reached) return void await send(AUDIT_UNREACHABLE);
      await sendScreen(send, renderAuditMenu(health));
    },

    async onCallback(cb, ui) {
      // Telegram takes one answer per tap: once one went through, a later
      // failure (a failed edit, say) is only logged.
      let answered = false;
      const answer = async (...text: [string?]) => {
        await ui.answer(...text);
        answered = true;
      };
      try {
        const view = parseAuditData(cb.data);
        if (!view) return void await answer();
        const show = async (screen: MenuScreen, fresh = false) => {
          if (fresh) await sendScreen(ui.send, screen);
          else await ui.edit(screen.text, screen.keyboard);
          await answer();
        };
        switch (view.kind) {
          case 'menu': {
            const health = await deps.health();
            if (!health.reached) return void await answer(AUDIT_UNREACHABLE);
            return void await show(renderAuditMenu(health));
          }
          case 'balances': {
            const report = await deps.balances();
            if (!report.reached) return void await answer(AUDIT_UNREACHABLE);
            return void await show(renderAuditBalances(report));
          }
          case 'account': {
            const report = await deps.balances();
            if (!report.reached) return void await answer(AUDIT_UNREACHABLE);
            const e = report.accounts.find((a) => accountHandle(a.wfAccountId) === view.handle);
            if (!e) return void await answer(AUDIT_ACCOUNT_GONE);
            return void await show(renderAuditAccount(e, report.notes, view.fresh), view.fresh);
          }
          case 'headline':
            return void await show(renderAuditHeadline(await deps.headline(deps.now())));
          case 'reason': {
            const h = await deps.headline(deps.now());
            // Rows that could not be read are not rows that are gone.
            if (!h.reasons) return void await show(renderAuditHeadline(h));
            const r = h.reasons.find((x) => reasonHandle(x) === view.handle);
            if (!r) return void await answer(AUDIT_REASON_GONE);
            return void await show(renderAuditReason(r));
          }
          case 'health': {
            const report = await deps.health();
            return void await show(renderAuditHealth(report, { link: !!deps.link }));
          }
          case 'issue': {
            const report = await deps.health();
            if (!report.issues) return void await show(renderAuditHealth(report, { link: !!deps.link }));
            const issue = report.issues.find((i) => issueHandle(i) === view.handle);
            if (!issue) return void await answer(AUDIT_ISSUE_GONE);
            return void await show(renderAuditIssue(issue, { link: !!deps.link }));
          }
          case 'link':
          case 'link-all': {
            if (!deps.link) return void await answer();
            // The toast carries the outcome, so it is seen even if the edit fails.
            const finish = async (screen: MenuScreen, outcome: string) => {
              await answer(clip(outcome, TOAST_MAX)).catch(() => {});
              await ui.edit(screen.text, screen.keyboard);
            };
            const report = await deps.health();
            if (!report.issues) return void await show(renderAuditHealth(report, { link: true }));
            // Only pairs whose legs still read as the button carried them.
            const shown = shownPairs(report);
            const pairs = view.kind === 'link'
              ? shown.filter((p) => pairHandle(p) === view.handle)
              : pairsHandle(shown) === view.handle ? shown : [];
            // Nothing to link: the toast alone. The message keeps what it says —
            // a double tap's second run must not cover the first's "Linked.".
            if (pairs.length === 0) return void await answer(LINK_CHANGED);
            const run = await deps.link(pairs);
            // The screen re-reads: the list shows what is left.
            let screen: MenuScreen;
            try {
              screen = renderAuditHealth(await deps.health(), { link: true, result: run.message });
            } catch (err) {
              deps.log(`Audit menu: re-reading Health after a link failed: ${message(err)}`);
              screen = {
                text: ['🔎 *Health*', clipEscaped(run.message, HEALTH_RESULT_MAX), clipEscaped(`Couldn't re-read Health (${message(err)}).`, 300)].join('\n'),
                keyboard: { inline_keyboard: [back({ kind: 'health' })] },
              };
            }
            return void await finish(screen, run.message);
          }
        }
      } catch (err) {
        deps.log(`Audit menu: ${cb.data} failed: ${message(err)}`);
        if (!answered) await ui.answer(FAILED_ANSWER).catch(() => {});
      }
    },
  };
}
