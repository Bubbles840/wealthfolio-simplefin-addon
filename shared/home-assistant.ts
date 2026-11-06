/**
 * shared/home-assistant.ts
 *
 * Alerts to Home Assistant's notify service, beside Telegram.
 *
 * WHY AN OUTBOX. An add-on can only reach the hosts in its manifest, and a Home
 * Assistant address is different for every install, so only the companion talks
 * to Home Assistant. Each writer queues into a secret only it writes: the
 * companion into `ha_outbox` (which also holds what was delivered and the
 * delivery status), the add-on into `ha_outbox_addon`. The companion drains
 * both on a short schedule and never writes the add-on's key.
 *
 * A drain saves what it sent and the status in ONE write, so the two never
 * disagree. Each alert's id is saved just before it is sent, and nothing is
 * sent if that save fails. If the save after sending fails, the next pass finds
 * those ids and treats the alerts as sent, and the status counts them as
 * "may not have arrived": never a repeat, at the cost of an alert that did not
 * arrive (Home Assistant refused it, or the companion stopped right before
 * sending it) when a save failed at that moment.
 *
 * WHY A SEEN MEMORY. Some alerts are re-reported on every sync until resolved
 * (a refused create is never stored, so it is refused again; an unmapped account
 * stays unmapped). Telegram keeps its own announced-ledgers for these, tied to
 * Telegram delivery. Home Assistant must not depend on Telegram being set up, so
 * the outbox remembers each alert's keys for 30 days and ignores a re-report.
 *
 * Independent of Telegram on purpose: nothing here reads or writes a Telegram
 * ledger, so a person with both gets each alert on both.
 *
 * Pure apart from `sendHomeAssistantNotification`: the hosts read and write the
 * secrets.
 */
import type { SyncResult } from './sync-core.js';
import {
  formatBalanceDriftAlert, formatDuplicatePruneAlert, formatFeedLagNotice, formatImportNotice,
  formatLargeTransactionAlert, formatRefusedCreatesAlert, formatStuckTransferAlert, importNoticeRows,
} from './telegram.js';
import { alertLink } from './reports-archive.js';

export const HA_CONFIG_SECRET_KEY = 'homeassistant_config';
export const HA_OUTBOX_SECRET_KEY = 'ha_outbox';
/** The add-on's queue: written by the add-on only, read by the companion. */
export const HA_ADDON_QUEUE_SECRET_KEY = 'ha_outbox_addon';

/** Entries waiting longer than this are dropped: Home Assistant has been
 *  unreachable for a week, and a week-old alert is no longer news. */
export const HA_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many entries wait, newest kept, so a broken setup cannot grow
 *  the secret without bound. */
export const HA_PENDING_LIMIT = 50;
/** A queue never holds more than this, even before a drain trims it to the 50
 *  newest: only the drain drops alerts, so it can count them, but a companion
 *  that never runs must not let the secret grow without bound. */
export const HA_QUEUE_HARD_LIMIT = 200;
/** How long a delivered (or queued) alert's keys suppress a re-report. */
export const HA_SEEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Back-off after a failure Home Assistant may recover from (5xx, unreachable):
 *  5 minutes, doubling, at most 4 hours. */
export const HA_RETRY_BASE_MS = 5 * 60 * 1000;
export const HA_RETRY_MAX_MS = 4 * 60 * 60 * 1000;

/**
 * How alerts reach Home Assistant:
 *  - `notify`: its notify service, with a long-lived access token. Works with no
 *    setup in Home Assistant beyond the token.
 *  - `webhook`: a webhook trigger (`/api/webhook/<id>`). No token; an automation
 *    on the Home Assistant side decides where each alert goes, which suits a
 *    setup that already routes every service's alerts through one automation.
 */
export type HaMode = 'notify' | 'webhook';

export interface HomeAssistantConfig {
  enabled: boolean;
  /** Absent in a stored config means `notify`, the only mode there was at first. */
  mode: HaMode;
  /** `notify`: the base URL, e.g. `http://homeassistant.local:8123`.
   *  `webhook`: the whole webhook URL, e.g. `http://homeassistant.local:8123/api/webhook/<id>`. */
  url: string;
  /** `notify` only: a long-lived access token. */
  token: string;
  /** `notify` only: the notify service, `notify.mobile_app_x` or just `mobile_app_x`. */
  service: string;
  /** Put in front of every title, e.g. `[Wealth]`. Empty: titles as they are. */
  titlePrefix: string;
  /** Wealthfolio's address as the phone reaches it, e.g. `https://wealthfolio.example.com`.
   *  Set, each alert carries a link into the add-on that a tap can open. */
  linkBase: string;
  /** Send a notice for each sync that imports transactions. Absent: off, so only
   *  problems reach the phone until it is switched on. */
  notifyOnImport: boolean;
  /** With `notifyOnImport`: include buys and sells (`importNoticeRows`). Absent: on. */
  notifyOnImportTrades: boolean;
}

const WEB_URL = /^https?:\/\/[^\s]+$/;

/** Why a tap-link address cannot be used, or null when it is empty or fine. */
export function haLinkBaseProblem(linkBase: string): string | null {
  const v = linkBase.trim();
  if (!v || WEB_URL.test(v)) return null;
  return 'Use the full address, starting with http:// or https://';
}

/** Why a Home Assistant URL cannot be used, or null when it is fine. Only
 *  http(s) with a host and no user name or password: anything else fails later
 *  with a confusing error, or (a `data:` URL) "succeeds" without sending. */
export function haUrlProblem(url: string): string | null {
  const v = url.trim();
  if (!v) return 'Enter the address';
  let u: URL;
  try { u = new URL(v); } catch { return 'Use the full address, starting with http:// or https://'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Use the full address, starting with http:// or https://';
  if (!u.hostname) return 'The address needs a host name';
  if (u.username || u.password) return 'Leave the user name and password out of the address';
  return null;
}

/** Whether a config has every field its mode needs, with a usable URL. Both
 *  halves check this: the add-on before it saves, the companion before it sends. */
export function haConfigComplete(c: Pick<HomeAssistantConfig, 'mode' | 'url' | 'token' | 'service'>): boolean {
  if (haUrlProblem(c.url)) return false;
  return c.mode === 'webhook' || (!!c.token.trim() && !!c.service.trim());
}

/** What delivery depends on, as a short digest: a parked failure waits until this
 *  changes. Stored in the status, so not the token itself. */
export function haConfigKey(c: Pick<HomeAssistantConfig, 'mode' | 'url' | 'token' | 'service'>): string {
  return digest([c.mode, c.url.trim(), c.token.trim(), c.service.trim()]);
}

/** An entry's absolute tap link, when the config has an address and the entry a page. */
export function haEntryUrl(config: Pick<HomeAssistantConfig, 'linkBase'>, entry: Pick<HaEntry, 'link'>): string | undefined {
  const base = config.linkBase.trim().replace(/\/+$/, '');
  if (!base || !entry.link || haLinkBaseProblem(base)) return undefined;
  return `${base}${entry.link}`;
}

/** The title as sent: the prefix, a space, the title. */
export function haTitle(config: Pick<HomeAssistantConfig, 'titlePrefix'>, entry: Pick<HaEntry, 'title'>): string {
  const prefix = config.titlePrefix.trim();
  return prefix ? `${prefix} ${entry.title}` : entry.title;
}

/** What an entry is about, for a webhook automation to branch on: the id's
 *  prefix, spelled out. */
const HA_KINDS: Record<string, string> = {
  test: 'test',
  stuck: 'stuck_transfer',
  largetx: 'large_transaction',
  drift: 'balance_drift',
  pruned: 'duplicates_removed',
  refused: 'not_imported',
  unmapped: 'new_account',
  import: 'new_transactions',
  synchealth: 'sync_failing',
};

export function haKind(entry: Pick<HaEntry, 'id'>): string {
  const prefix = entry.id.split(':')[0];
  return HA_KINDS[prefix] ?? prefix;
}

export interface HaEntry {
  /** What the alert is about; two writers queueing the same alert share it. */
  id: string;
  title: string;
  message: string;
  /** ISO. */
  createdAt: string;
  /** Extra keys that suppress a later re-report, e.g. one per refused
   *  transaction in a combined message. */
  keys?: string[];
  /** The add-on page a tap opens, relative (`alertLink`). Made absolute at send
   *  time from the config's `linkBase`, so changing the address needs no requeue. */
  link?: string;
}

export interface HaOutbox {
  pending: HaEntry[];
  /** Key → ISO time first queued. */
  seen: Record<string, string>;
  /** The companion's outbox only: the last delivery outcome, for the drain's
   *  park and back-off and for the settings card. */
  status?: HaStatus;
  /** The companion's outbox only: ids a drain is sending, each saved just before
   *  it goes out and cleared by the save after. Still here at the next pass, that
   *  save failed: those alerts may have arrived, so they are treated as sent and
   *  never sent again. */
  sending?: string[];
}

export interface HaStatus {
  /** ISO time of the last delivered notification. */
  lastOkAt?: string;
  /** The last delivery error, cleared by the next success. */
  lastError?: string;
  lastErrorAt?: string;
  /** The `haConfigKey` of the config the last failure happened with. Once the
   *  saved config differs, neither a park nor a back-off holds delivery back,
   *  and the card says the change is not checked yet. */
  failedFor?: string;
  /** The last failure is one retrying cannot fix (a rejected token, a wrong
   *  service, a redirect): nothing is sent until the config changes or a test
   *  is queued. */
  parked?: true;
  /** After a failure Home Assistant may recover from: consecutive failures, and
   *  when the next try is due. */
  failures?: number;
  retryAt?: string;
  /** Test entries already tried since the last delivery. A test not in it goes
   *  through a park or a back-off once. Ids, not times: the test's time is the
   *  browser's clock and the failure's the companion's. */
  triedTests?: string[];
  /** Alerts dropped unsent after a week in the queue: how many, and when. */
  dropped?: number;
  droppedAt?: string;
  /** Alerts treated as sent without knowing they arrived (a save failed while
   *  they were being sent): how many, and when. */
  unsure?: number;
  unsureAt?: string;
}

/** A config with nothing filled in: what editing starts from. */
export const EMPTY_HA_CONFIG: HomeAssistantConfig = {
  enabled: true, mode: 'notify', url: '', token: '', service: '', titlePrefix: '', linkBase: '',
  notifyOnImport: false, notifyOnImportTrades: true,
};

/** The stored config for editing: every field, switched off or not, as typed,
 *  with `EMPTY_HA_CONFIG`'s defaults for what is missing or unreadable. */
export function homeAssistantConfigForEditing(raw: string | null | undefined): HomeAssistantConfig {
  if (!raw) return { ...EMPTY_HA_CONFIG };
  let c: Record<string, unknown>;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object') return { ...EMPTY_HA_CONFIG };
    c = v as Record<string, unknown>;
  } catch {
    return { ...EMPTY_HA_CONFIG };
  }
  const str = (x: unknown) => (typeof x === 'string' ? x : '');
  return {
    enabled: c.enabled !== false,
    mode: c.mode === 'webhook' ? 'webhook' : 'notify',
    url: str(c.url),
    token: str(c.token),
    service: str(c.service),
    titlePrefix: str(c.titlePrefix),
    linkBase: str(c.linkBase),
    notifyOnImport: c.notifyOnImport === true,
    notifyOnImportTrades: c.notifyOnImportTrades !== false,
  };
}

/** The stored config as sent with (fields trimmed), or null when Home Assistant
 *  is not set up or switched off. */
export function parseHomeAssistantConfig(raw: string | null | undefined): HomeAssistantConfig | null {
  const c = homeAssistantConfigForEditing(raw);
  const config: HomeAssistantConfig = {
    ...c,
    url: c.url.trim(),
    token: c.token.trim(),
    service: c.service.trim(),
    titlePrefix: c.titlePrefix.trim(),
    linkBase: c.linkBase.trim(),
  };
  return config.enabled && haConfigComplete(config) ? config : null;
}

/** The "Send a test" entry. Its id is the moment, so each press sends one. */
export function haTestEntry(now: Date): HaEntry {
  return {
    id: `test:${now.toISOString()}`,
    title: 'Test alert',
    message: 'SimpleFin Sync alerts reach Home Assistant.',
    createdAt: now.toISOString(),
    link: alertLink('settings'),
  };
}

export function parseHaOutbox(raw: string | null | undefined): HaOutbox {
  const empty: HaOutbox = { pending: [], seen: {} };
  if (!raw) return empty;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return empty; }
  if (!v || typeof v !== 'object') return empty;
  const o = v as { pending?: unknown; seen?: unknown; status?: unknown; sending?: unknown };
  const pending = Array.isArray(o.pending)
    ? o.pending.filter((e): e is HaEntry =>
      !!e && typeof e === 'object'
      && typeof (e as HaEntry).id === 'string' && typeof (e as HaEntry).title === 'string'
      && typeof (e as HaEntry).message === 'string' && typeof (e as HaEntry).createdAt === 'string')
    : [];
  const seen: Record<string, string> = {};
  if (o.seen && typeof o.seen === 'object' && !Array.isArray(o.seen)) {
    for (const [k, t] of Object.entries(o.seen as Record<string, unknown>)) {
      if (typeof t === 'string') seen[k] = t;
    }
  }
  const status = o.status && typeof o.status === 'object' && !Array.isArray(o.status) ? o.status as HaStatus : undefined;
  const sending = Array.isArray(o.sending) ? o.sending.filter((x): x is string => typeof x === 'string') : [];
  return { pending, seen, ...(status ? { status } : {}), ...(sending.length ? { sending } : {}) };
}

/** Telegram's Markdown as plain text: emphasis markers and backslash escapes
 *  dropped, everything else (emoji, bullets, line breaks) kept. */
export function plainText(markdown: string): string {
  let out = '';
  for (let i = 0; i < markdown.length; i++) {
    const ch = markdown[i];
    if (ch === '\\' && '_*`['.includes(markdown[i + 1] ?? '')) {
      out += markdown[++i];
    } else if (!'*_`'.includes(ch)) {
      out += ch;
    }
  }
  return out.trim();
}

/** A formatted Telegram alert as a title and a message: its first line is the
 *  title when it has more than one line, else `fallbackTitle` heads it. */
function entryFromTelegram(id: string, markdown: string, fallbackTitle: string, now: Date, keys?: string[]): HaEntry {
  const lines = plainText(markdown).split('\n');
  const multi = lines.length > 1;
  return {
    id,
    title: multi ? lines[0].trim() : fallbackTitle,
    message: (multi ? lines.slice(1) : lines).join('\n').trim(),
    createdAt: now.toISOString(),
    ...(keys ? { keys } : {}),
  };
}

/** A short stable id for a set of keys. */
function digest(parts: string[]): string {
  let h = 5381;
  for (const ch of parts.join('|')) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return h.toString(36);
}

/**
 * Entries for one sync's alerts. `known` says whether a key was already queued
 * or delivered, so alerts that are re-reported every sync are queued once.
 * The core emits stuck-transfer, drift and large-transaction alerts once per
 * episode across both writers, so those need no such check beyond their id.
 * The import notice follows the config's own switches (`notifyOnImport`,
 * `notifyOnImportTrades`), not Telegram's.
 */
export function syncAlertEntries(
  result: SyncResult,
  now: Date,
  known: (key: string) => boolean,
  imports: Pick<HomeAssistantConfig, 'notifyOnImport' | 'notifyOnImportTrades'>,
): HaEntry[] {
  const out: HaEntry[] = [];
  const day = now.toISOString().slice(0, 10);

  for (const a of result.stuckTransferAlerts) {
    out.push(entryFromTelegram(`stuck:${a.outTxId}`, formatStuckTransferAlert(a), 'Transfer not linked', now));
  }
  for (const a of result.largeTransactionAlerts) {
    out.push({
      ...entryFromTelegram(`largetx:${a.txId}`, formatLargeTransactionAlert(a), 'Large transaction', now),
      link: alertLink('home', a.activityId),
    });
  }
  for (const a of result.balanceDriftAlerts) {
    const text = a.phase === 'aged' ? formatBalanceDriftAlert(a) : formatFeedLagNotice(a);
    out.push(entryFromTelegram(`drift:${a.sfinAccountId}:${a.phase}:${day}`, text, 'Balance drift', now));
  }
  if (result.prunedDuplicates.length > 0) {
    const ids = result.prunedDuplicates.map((r) => r.wfId).sort();
    out.push(entryFromTelegram(
      `pruned:${digest(ids)}`, formatDuplicatePruneAlert(result.prunedDuplicates), 'Duplicates removed', now,
    ));
  }
  const freshRefused = result.refusedCreates.filter((r) => !known(`refused:${r.txId}`));
  if (freshRefused.length > 0) {
    const keys = freshRefused.map((r) => `refused:${r.txId}`);
    out.push(entryFromTelegram(
      `refused:${digest(keys)}`, formatRefusedCreatesAlert(freshRefused), 'Transactions not imported', now, keys,
    ));
  }
  const freshUnmapped = (result.unmappedAccounts ?? []).filter((a) => !known(`unmapped:${a.sfinAccountId}`));
  if (freshUnmapped.length > 0) {
    const keys = freshUnmapped.map((a) => `unmapped:${a.sfinAccountId}`);
    const one = freshUnmapped.length === 1;
    out.push({
      id: `unmapped:${digest(keys)}`,
      title: `New SimpleFin account${one ? '' : 's'}, not syncing yet`,
      message: [
        ...freshUnmapped.map((a) => `• ${a.accountName}${a.orgName ? ` (${a.orgName})` : ''}`),
        '',
        `Nothing from ${one ? 'it' : 'them'} is imported until ${one ? 'it is' : 'they are'} mapped under `
          + 'Settings → Accounts in the SimpleFin Sync add-on.',
      ].join('\n'),
      createdAt: now.toISOString(),
      keys,
      link: alertLink('settings'),
    });
  }
  const announced = imports.notifyOnImport ? importNoticeRows(result.importedTransactions, imports) : [];
  if (announced.length > 0) {
    const ids = announced.map((t) => `${t.sfAccountId}:${t.txId}`).sort();
    out.push(entryFromTelegram(
      `import:${digest(ids)}`, formatImportNotice(announced, []), 'New transactions', now,
    ));
  }
  // Everything without a more specific page opens Home, where these show.
  return out.map((e) => (e.link ? e : { ...e, link: alertLink('home') }));
}

/** The sync-failing alert, once per failure streak. */
export function syncHealthEntry(firstFailedAt: string, lastError: string | undefined, now: Date): HaEntry {
  return {
    id: `synchealth:${firstFailedAt}`,
    title: 'SimpleFin sync failing',
    message: `Failing since ${firstFailedAt.slice(0, 16).replace('T', ' ')} UTC.\nLast error: ${lastError ?? 'unknown error'}`,
    createdAt: now.toISOString(),
    link: alertLink('home'),
  };
}

/** Whether a key is already queued or was delivered recently. */
export function haKnown(outbox: HaOutbox): (key: string) => boolean {
  const queued = new Set(outbox.pending.flatMap((e) => [e.id, ...(e.keys ?? [])]));
  return (key) => queued.has(key) || key in outbox.seen;
}

/** How old `at` is. A time in the future (a fast clock on the other writer) counts
 *  as now, so it still ages out. */
function ageMs(at: string, t: number): number {
  return t - Math.min(Date.parse(at), t);
}

/** Splits off what aged out: pending past 7 days (and beyond the 50 newest), seen
 *  keys past 30 days. `dropped` is the pending entries that never went out. */
function prune(outbox: HaOutbox, now: Date): { outbox: HaOutbox; dropped: HaEntry[] } {
  const t = now.getTime();
  const fresh = outbox.pending.filter((e) => ageMs(e.createdAt, t) <= HA_PENDING_MAX_AGE_MS);
  const pending = fresh.slice(-HA_PENDING_LIMIT);
  const kept = new Set(pending);
  const seen: Record<string, string> = {};
  for (const [k, at] of Object.entries(outbox.seen)) {
    if (ageMs(at, t) <= HA_SEEN_MAX_AGE_MS) seen[k] = at;
  }
  return { outbox: { pending, seen }, dropped: outbox.pending.filter((e) => !kept.has(e)) };
}

function pruned(outbox: HaOutbox, now: Date): HaOutbox {
  return prune(outbox, now).outbox;
}

/** Seen keys past 30 days dropped; pending kept (the drain ages those out and
 *  counts them) up to the hard limit. */
function trimmedQueue(outbox: HaOutbox, now: Date): HaOutbox {
  return {
    pending: outbox.pending.slice(-HA_QUEUE_HARD_LIMIT), seen: prune(outbox, now).outbox.seen,
    ...(outbox.status ? { status: outbox.status } : {}),
    ...(outbox.sending?.length ? { sending: outbox.sending } : {}),
  };
}

/** The outbox with `entries` queued, skipping any whose id is already known.
 *  The status and the ids being sent ride along untouched. */
export function enqueueHa(outbox: HaOutbox, entries: HaEntry[], now: Date): HaOutbox {
  const known = haKnown(outbox);
  const fresh = entries.filter((e) => !known(e.id));
  return trimmedQueue({ ...outbox, pending: [...outbox.pending, ...fresh] }, now);
}

/** Reads and writes one add-on secret by key: the SDK store on the add-on, the
 *  REST client in the companion. */
export interface HaSecretIo {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** Which writer is queueing: each has its own key (see the header). */
export type HaWriter = 'addon' | 'companion';

/**
 * Queues `entries` when Home Assistant is set up. Resolves 'off' when it is not
 * (nothing queued), 'queued' otherwise, also when every entry was already known.
 * Rejects when a secret cannot be read or written: for "Send a test", which must
 * say so. The sync uses `queueHaEntries`, which never rejects.
 *
 * The add-on writes only its own key. Its known keys include the companion's
 * outbox, so an alert the companion already queued or sent is not queued twice,
 * and its queue drops what the companion has delivered.
 */
export async function queueHaEntriesStrict(
  io: HaSecretIo,
  writer: HaWriter,
  build: (known: (key: string) => boolean, config: HomeAssistantConfig) => HaEntry[],
  now: Date,
): Promise<'off' | 'queued'> {
  const config = parseHomeAssistantConfig(await io.get(HA_CONFIG_SECRET_KEY));
  if (!config) return 'off';
  const [mainRaw, raw] = await Promise.all([io.get(HA_OUTBOX_SECRET_KEY), io.get(HA_ADDON_QUEUE_SECRET_KEY)]);
  const main = parseHaOutbox(mainRaw);
  if (writer === 'companion') {
    const addon = parseHaOutbox(raw);
    const known = haKnown({ pending: [...main.pending, ...addon.pending], seen: main.seen });
    const entries = build(known, config).filter((e) => !known(e.id));
    if (entries.length === 0) return 'queued';
    const next = JSON.stringify(enqueueHa(main, entries, now));
    if (next !== mainRaw) await io.set(HA_OUTBOX_SECRET_KEY, next);
    return 'queued';
  }
  const own = parseHaOutbox(raw);
  // Delivered (or dropped) by the companion: no longer the add-on's to keep.
  // Kept unsent for as long as the companion remembers what it handled, not
  // only the week it sends for: a companion that was down for a week still
  // finds them, and counts them as dropped. Past that, the drain ignores them.
  const t = now.getTime();
  const undelivered = own.pending.filter((e) => !(e.id in main.seen) && ageMs(e.createdAt, t) <= HA_SEEN_MAX_AGE_MS);
  const known = haKnown({ pending: [...main.pending, ...undelivered], seen: main.seen });
  const entries = build(known, config).filter((e) => !known(e.id));
  const next = JSON.stringify(trimmedQueue({ pending: [...undelivered, ...entries], seen: {} }, now));
  if (next !== raw) await io.set(HA_ADDON_QUEUE_SECRET_KEY, next);
  return 'queued';
}

/** `queueHaEntriesStrict` for the sync: never rejects, since a notification
 *  problem is not a sync problem. The next sync queues what it finds then. */
export async function queueHaEntries(
  io: HaSecretIo,
  writer: HaWriter,
  build: (known: (key: string) => boolean, config: HomeAssistantConfig) => HaEntry[],
  now: Date,
): Promise<void> {
  await queueHaEntriesStrict(io, writer, build, now).catch(() => {});
}

/**
 * Everything waiting to go out: the companion's outbox plus the add-on's queue,
 * minus what was already delivered or queued twice, oldest first. An add-on
 * entry older than the companion's memory of what it sent is left out: its key
 * may already be forgotten, and counting it again would report it dropped on
 * every pass until the add-on next writes its queue.
 */
export function haPendingView(main: HaOutbox, addon: HaOutbox, now: Date): HaOutbox {
  const t = now.getTime();
  const ids = new Set(main.pending.map((e) => e.id));
  const pending = [...main.pending];
  for (const e of addon.pending) {
    if (e.id in main.seen || ids.has(e.id) || ageMs(e.createdAt, t) > HA_SEEN_MAX_AGE_MS) continue;
    ids.add(e.id);
    pending.push(e);
  }
  pending.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return { pending, seen: main.seen };
}

export interface HaSendResult {
  ok: boolean;
  description?: string;
  /** A failure retrying cannot fix: the config (or Home Assistant's side of it)
   *  has to change first. */
  permanent?: boolean;
}

export type HaSend = (entry: HaEntry) => Promise<HaSendResult>;

/**
 * Sends every pending entry, oldest first. A delivered entry moves to `seen`;
 * a failed one stays for the next pass. Stops at the first failure: Home
 * Assistant is down or the config is wrong, and the rest would fail the same way.
 * `dropped` counts entries that aged out unsent; their keys move to `seen` too,
 * so the add-on's copy is not counted again. With `send` null (delivery is
 * waiting), it only ages out.
 */
export async function drainHaOutbox(
  outbox: HaOutbox,
  send: HaSend | null,
  now: Date,
  options: {
    /** Only these are sent; the rest stay pending, untried. */
    only?: (entry: HaEntry) => boolean;
    /** May already have arrived (an earlier pass could not record them): marked
     *  as sent, never sent again, counted as neither delivered nor dropped. */
    unconfirmed?: (id: string) => boolean;
  } = {},
): Promise<HaDrainResult> {
  const doubtful: HaEntry[] = [];
  const rest: HaEntry[] = [];
  for (const e of outbox.pending) (options.unconfirmed?.(e.id) ? doubtful : rest).push(e);
  const { outbox: current, dropped } = prune({ pending: rest, seen: outbox.seen }, now);
  const seen = { ...current.seen };
  const remember = (e: HaEntry) => { for (const k of [e.id, ...(e.keys ?? [])]) seen[k] ??= e.createdAt; };
  doubtful.forEach(remember);
  dropped.forEach(remember);
  const remaining: HaEntry[] = [];
  const tried: string[] = [];
  let delivered = 0;
  const queue = current.pending;
  for (let i = 0; i < queue.length; i++) {
    const entry = queue[i];
    if (!send || (options.only && !options.only(entry))) {
      remaining.push(entry);
      continue;
    }
    tried.push(entry.id);
    let res: HaSendResult;
    try {
      res = await send(entry);
    } catch (err) {
      // `send` rejects only when the entry was NOT sent (the save before it
      // failed): stop here, but return what this pass did, so the caller still
      // records the deliveries before it and then reports the error.
      tried.pop();
      remaining.push(...queue.slice(i));
      return {
        outbox: { pending: remaining, seen }, delivered, dropped: dropped.length, unsure: doubtful.length,
        attempted: delivered > 0, tried, aborted: err,
      };
    }
    if (!res.ok) {
      // A test is a one-off check: tried and failed, it is handled (the status
      // shows the result), never kept to go out later with the real alerts.
      if (entry.id.startsWith('test:')) {
        remember(entry);
        remaining.push(...queue.slice(i + 1));
      } else {
        remaining.push(...queue.slice(i));
      }
      return {
        outbox: { pending: remaining, seen }, delivered, dropped: dropped.length, unsure: doubtful.length, attempted: true, tried,
        error: res.description ?? 'delivery failed', ...(res.permanent ? { permanent: true } : {}),
      };
    }
    delivered++;
    remember(entry);
  }
  return {
    outbox: { pending: remaining, seen }, delivered, dropped: dropped.length, unsure: doubtful.length,
    attempted: delivered > 0, tried,
  };
}

export interface HaDrainResult {
  outbox: HaOutbox;
  delivered: number;
  dropped: number;
  /** Treated as sent because an earlier pass could not record them. */
  unsure: number;
  attempted: boolean;
  /** Set when the pass stopped because `send` rejected before sending: the
   *  caller records what was done, then reports this. */
  aborted?: unknown;
  /** Ids of the entries a send was attempted for, in order. */
  tried: string[];
  error?: string;
  permanent?: boolean;
}

/**
 * Folds a drain's outcome into the companion's outbox as it is NOW, not as it was
 * when the drain read it: the companion's own sync may have queued alerts while
 * the sends ran, and writing the drained copy back would drop them. Entries that
 * came from the add-on's queue and are still unsent stay there; only the
 * companion's own pending are kept here.
 */
export function mergeDrained(current: HaOutbox, drained: HaOutbox, now: Date, status?: HaStatus | null): HaOutbox {
  const seen = { ...current.seen, ...drained.seen };
  const next = status ?? current.status;
  // The pass is recorded, so the ids it was sending are no longer in doubt.
  return { ...pruned({ pending: current.pending.filter((e) => !seen[e.id]), seen }, now), ...(next ? { status: next } : {}) };
}

/** Whether the last failure happened with a config other than `config`. */
export function haChangedSinceFailure(status: HaStatus | null, config: Pick<HomeAssistantConfig, 'mode' | 'url' | 'token' | 'service'>): boolean {
  return !!status?.lastError && !!status.failedFor && status.failedFor !== haConfigKey(config);
}

/**
 * What the drain may send now:
 *  - `all`: nothing holds delivery back, or the config changed since the failure.
 *  - `wait`: a parked failure (until the config changes) or a back-off.
 *  - `tests`: waiting, but a test not tried yet is queued. Only untried tests
 *    are sent, never the alert that failed: sending it first is the retry loop
 *    the park is there to stop, and the test would never be reached.
 */
export function haDrainMode(
  status: HaStatus | null,
  config: HomeAssistantConfig,
  pending: HaEntry[],
  now: Date,
): 'all' | 'wait' | 'tests' {
  if (!status?.lastError || haChangedSinceFailure(status, config)) return 'all';
  const waits = !!status.parked || (!!status.retryAt && now.getTime() < Date.parse(status.retryAt));
  if (!waits) return 'all';
  return pending.some((e) => haUntriedTest(status, e)) ? 'tests' : 'wait';
}

/** A test entry the drain has not tried since the last failure. */
export function haUntriedTest(status: HaStatus | null, entry: Pick<HaEntry, 'id'>): boolean {
  return entry.id.startsWith('test:') && !(status?.triedTests ?? []).includes(entry.id);
}

/** The status after a drain. Unchanged (null) when the drain neither sent nor
 *  dropped anything, so an idle pass never overwrites an error with "Connected". */
export function nextHaStatus(
  previous: HaStatus | null,
  result: Pick<HaDrainResult, 'delivered' | 'dropped' | 'attempted' | 'error' | 'permanent'>
    & { tried?: string[]; outbox?: HaOutbox; unsure?: number },
  config: HomeAssistantConfig,
  now: Date,
): HaStatus | null {
  const unsureNow = result.unsure ?? 0;
  if (!result.attempted && result.dropped === 0 && unsureNow === 0) return null;
  const prev = previous ?? {};
  const t = now.getTime();
  const at = now.toISOString();
  const lastOkAt = result.delivered > 0 ? at : prev.lastOkAt;
  // A running count of the last week's drops: an older count starts over, so
  // the card's "were dropped" stays recent.
  const recentDrops = prev.dropped && prev.droppedAt && t - Date.parse(prev.droppedAt) <= HA_PENDING_MAX_AGE_MS
    ? prev.dropped : 0;
  const dropped = result.dropped > 0
    ? { dropped: recentDrops + result.dropped, droppedAt: at }
    : prev.dropped ? { dropped: prev.dropped, droppedAt: prev.droppedAt } : {};
  // The same for alerts treated as sent without knowing they arrived.
  const recentUnsure = prev.unsure && prev.unsureAt && t - Date.parse(prev.unsureAt) <= HA_PENDING_MAX_AGE_MS
    ? prev.unsure : 0;
  const unsure = unsureNow > 0
    ? { unsure: recentUnsure + unsureNow, unsureAt: at }
    : prev.unsure ? { unsure: prev.unsure, unsureAt: prev.unsureAt } : {};
  const base: HaStatus = { ...(lastOkAt ? { lastOkAt } : {}), ...dropped, ...unsure };
  if (!result.attempted) {
    // Only dropped or unsure: keep whatever error explains why.
    const { lastOkAt: _ok, dropped: _n, droppedAt: _at, unsure: _u, unsureAt: _ua, ...failure } = prev;
    return { ...failure, ...base };
  }
  if (!result.error) return base;
  const key = haConfigKey(config);
  // A failure with a new config starts its own back-off and its own tried tests.
  const sameConfig = prev.failedFor === key;
  // Every tried test still waiting is kept, however many: one dropped from the
  // list would count as untried and be sent again on every pass.
  const stillPending = result.outbox ? new Set(result.outbox.pending.map((e) => e.id)) : null;
  const triedTests = [...new Set([
    ...(sameConfig ? prev.triedTests ?? [] : []),
    ...(result.tried ?? []).filter((id) => id.startsWith('test:')),
  ])].filter((id) => !stillPending || stillPending.has(id));
  const failed: HaStatus = {
    ...base, lastError: result.error, lastErrorAt: at, failedFor: key,
    ...(triedTests.length ? { triedTests } : {}),
  };
  // A park lasts until a delivery or a config change: a test that only timed
  // out through it says nothing about the token, so it does not lift it, but a
  // delivery in the same pass shows delivery works again.
  if (result.permanent || (sameConfig && prev.parked && result.delivered === 0)) return { ...failed, parked: true };
  const failures = (sameConfig ? prev.failures ?? 0 : 0) + 1;
  const wait = Math.min(HA_RETRY_BASE_MS * 2 ** (failures - 1), HA_RETRY_MAX_MS);
  return { ...failed, failures, retryAt: new Date(t + wait).toISOString() };
}

/**
 * One entry's request. `notify`: `POST <url>/api/services/notify/<service>` with
 * `{ title, message }`. `webhook`: `POST <webhook url>` with `{ title, message }`
 * plus `source`, `kind` and `id`, so one automation can tell these alerts apart
 * from other services' and from each other.
 */
export function homeAssistantRequest(config: HomeAssistantConfig, entry: HaEntry): { url: string; init: RequestInit } {
  const title = haTitle(config, entry);
  const link = haEntryUrl(config, entry);
  if (config.mode === 'webhook') {
    return {
      url: config.url.trim(),
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title, message: entry.message, source: 'simplefin-sync', kind: haKind(entry), id: entry.id,
          ...(link ? { url: link } : {}),
        }),
      },
    };
  }
  const base = config.url.replace(/\/+$/, '');
  const service = config.service.replace(/^notify\./, '');
  return {
    url: `${base}/api/services/notify/${encodeURIComponent(service)}`,
    init: {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      // `url` is what the iOS companion app opens on tap, `clickAction` the Android one.
      body: JSON.stringify({
        title, message: entry.message, ...(link ? { data: { url: link, clickAction: link } } : {}),
      }),
    },
  };
}

/** Why a request never got an answer, from the error's kind only. fetch's own
 *  message can hold the whole URL (credentials, a webhook id), so it is never
 *  stored or shown. */
export function haReachProblem(err: unknown): string {
  const e = err as { name?: unknown; cause?: { code?: unknown } } | null;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timed out';
  const code = typeof e?.cause?.code === 'string' ? e.cause.code : '';
  if (code === 'ECONNREFUSED') return 'connection refused';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'host not found';
  if (code === 'ECONNRESET') return 'connection reset';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'timed out';
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|TLS|SSL/.test(code)) return 'certificate problem';
  if (/^E[A-Z_]+$/.test(code)) return code;
  return 'network error';
}

export async function sendHomeAssistantNotification(
  config: HomeAssistantConfig,
  entry: HaEntry,
  fetchImpl: typeof fetch = fetch,
): Promise<HaSendResult> {
  const { url, init } = homeAssistantRequest(config, entry);
  let res: Response;
  try {
    // Never follow a redirect: fetch would turn the POST into a GET and, across
    // origins, drop the token, and a login page's 200 would read as delivered.
    res = await fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    return { ok: false, description: `Could not reach Home Assistant (${haReachProblem(err)})` };
  }
  // Only the status matters: release the connection.
  await res.body?.cancel().catch(() => {});
  if (res.ok) return { ok: true };
  if (res.status >= 300 && res.status < 400) {
    // The origin only: a webhook path is a secret.
    const location = res.headers.get('location');
    let origin = '';
    try { if (location) origin = new URL(location, url).origin; } catch { /* no usable Location */ }
    return {
      ok: false, permanent: true,
      description: origin && origin !== 'null'
        ? `Home Assistant redirected to ${origin}; use that address`
        : 'Home Assistant answered with a redirect; check the address',
    };
  }
  const webhook = config.mode === 'webhook';
  const hint = webhook
    ? (res.status === 404 || res.status === 405 ? ' (check the webhook URL)' : '')
    : res.status === 401 || res.status === 403 ? ' (check the access token)'
      : res.status === 400 || res.status === 404 ? ' (check the notify service name)' : '';
  const permanent = res.status === 401 || res.status === 403
    || (webhook ? res.status === 404 || res.status === 405 : res.status === 400 || res.status === 404);
  return {
    ok: false, description: `Home Assistant answered ${res.status}${hint}`, ...(permanent ? { permanent: true } : {}),
  };
}
