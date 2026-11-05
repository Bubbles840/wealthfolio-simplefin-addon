/**
 * shared/home-assistant.ts
 *
 * Alerts to Home Assistant's notify service, beside Telegram.
 *
 * WHY AN OUTBOX. An add-on can only reach the hosts in its manifest, and a Home
 * Assistant address is different for every install, so only the companion talks
 * to Home Assistant. Both writers turn a sync's alerts into entries in one shared
 * secret (`ha_outbox`); the companion drains it on a short schedule.
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
  formatLargeTransactionAlert, formatRefusedCreatesAlert, formatStuckTransferAlert,
} from './telegram.js';
import { alertLink } from './reports-archive.js';

export const HA_CONFIG_SECRET_KEY = 'homeassistant_config';
export const HA_OUTBOX_SECRET_KEY = 'ha_outbox';
export const HA_STATUS_SECRET_KEY = 'ha_status';

/** Entries waiting longer than this are dropped: Home Assistant has been
 *  unreachable for a week, and a week-old alert is no longer news. */
export const HA_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many entries wait, newest kept, so a broken setup cannot grow
 *  the secret without bound. */
export const HA_PENDING_LIMIT = 50;
/** How long a delivered (or queued) alert's keys suppress a re-report. */
export const HA_SEEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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
}

const WEB_URL = /^https?:\/\/[^\s]+$/;

/** Why a tap-link address cannot be used, or null when it is empty or fine. */
export function haLinkBaseProblem(linkBase: string): string | null {
  const v = linkBase.trim();
  if (!v || WEB_URL.test(v)) return null;
  return 'Use the full address, starting with http:// or https://';
}

/** Whether a config has every field its mode needs. */
export function haConfigComplete(c: Pick<HomeAssistantConfig, 'mode' | 'url' | 'token' | 'service'>): boolean {
  if (!c.url.trim()) return false;
  return c.mode === 'webhook' || (!!c.token.trim() && !!c.service.trim());
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
}

export interface HaStatus {
  /** ISO time of the last delivered notification. */
  lastOkAt?: string;
  /** The last delivery error, cleared by the next success. */
  lastError?: string;
  lastErrorAt?: string;
}

/** The stored config, or null when Home Assistant is not set up or switched off. */
export function parseHomeAssistantConfig(raw: string | null | undefined): HomeAssistantConfig | null {
  if (!raw) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '');
  const config: HomeAssistantConfig = {
    enabled: c.enabled !== false,
    mode: c.mode === 'webhook' ? 'webhook' : 'notify',
    url: str(c.url),
    token: str(c.token),
    service: str(c.service),
    titlePrefix: str(c.titlePrefix),
    linkBase: str(c.linkBase),
  };
  if (!config.enabled || !haConfigComplete(config)) return null;
  return config;
}

/** The stored config for editing: every field, switched off or not, with empty
 *  defaults. */
export function homeAssistantConfigForEditing(raw: string | null | undefined): HomeAssistantConfig {
  const empty: HomeAssistantConfig = {
    enabled: true, mode: 'notify', url: '', token: '', service: '', titlePrefix: '', linkBase: '',
  };
  if (!raw) return empty;
  try {
    const c = JSON.parse(raw) as Record<string, unknown>;
    const str = (x: unknown) => (typeof x === 'string' ? x : '');
    return {
      enabled: c.enabled !== false,
      mode: c.mode === 'webhook' ? 'webhook' : 'notify',
      url: str(c.url),
      token: str(c.token),
      service: str(c.service),
      titlePrefix: str(c.titlePrefix),
      linkBase: str(c.linkBase),
    };
  } catch {
    return empty;
  }
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
  const o = v as { pending?: unknown; seen?: unknown };
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
  return { pending, seen };
}

export function parseHaStatus(raw: string | null | undefined): HaStatus | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as HaStatus) : null;
  } catch {
    return null;
  }
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
 */
export function syncAlertEntries(
  result: SyncResult,
  now: Date,
  known: (key: string) => boolean,
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
  if (result.importedTransactions.length > 0) {
    const ids = result.importedTransactions.map((t) => `${t.sfAccountId}:${t.txId}`).sort();
    out.push(entryFromTelegram(
      `import:${digest(ids)}`, formatImportNotice(result.importedTransactions, []), 'New transactions', now,
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

/** Drops what aged out: pending past 7 days (and beyond the 50 newest), seen
 *  keys past 30 days. */
function pruned(outbox: HaOutbox, now: Date): HaOutbox {
  const t = now.getTime();
  const pending = outbox.pending
    .filter((e) => t - Date.parse(e.createdAt) <= HA_PENDING_MAX_AGE_MS)
    .slice(-HA_PENDING_LIMIT);
  const seen: Record<string, string> = {};
  for (const [k, at] of Object.entries(outbox.seen)) {
    if (t - Date.parse(at) <= HA_SEEN_MAX_AGE_MS) seen[k] = at;
  }
  return { pending, seen };
}

/** The outbox with `entries` queued, skipping any whose id is already known. */
export function enqueueHa(outbox: HaOutbox, entries: HaEntry[], now: Date): HaOutbox {
  const known = haKnown(outbox);
  const fresh = entries.filter((e) => !known(e.id));
  return pruned({ pending: [...outbox.pending, ...fresh], seen: outbox.seen }, now);
}

/** Reads and writes one add-on secret by key: the SDK store on the add-on, the
 *  REST client in the companion. */
export interface HaSecretIo {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/**
 * Queues `entries` when Home Assistant is set up; a no-op otherwise. Never
 * throws: a notification problem is not a sync problem.
 */
export async function queueHaEntries(
  io: HaSecretIo,
  build: (known: (key: string) => boolean) => HaEntry[],
  now: Date,
): Promise<void> {
  try {
    if (!parseHomeAssistantConfig(await io.get(HA_CONFIG_SECRET_KEY))) return;
    const raw = await io.get(HA_OUTBOX_SECRET_KEY);
    const outbox = parseHaOutbox(raw);
    const entries = build(haKnown(outbox));
    if (entries.length === 0) return;
    const next = enqueueHa(outbox, entries, now);
    const json = JSON.stringify(next);
    if (json !== raw) await io.set(HA_OUTBOX_SECRET_KEY, json);
  } catch {
    // The next sync queues what it finds then; the alert ledgers are untouched.
  }
}

export type HaSend =(entry: HaEntry) => Promise<{ ok: boolean; description?: string }>;

/**
 * Sends every pending entry, oldest first. A delivered entry moves to `seen`;
 * a failed one stays for the next pass. Stops at the first failure: Home
 * Assistant is down or the config is wrong, and the rest would fail the same way.
 */
export async function drainHaOutbox(
  outbox: HaOutbox,
  send: HaSend,
  now: Date,
): Promise<{ outbox: HaOutbox; delivered: number; error?: string }> {
  const current = pruned(outbox, now);
  const seen = { ...current.seen };
  const remaining = [...current.pending];
  let delivered = 0;
  while (remaining.length > 0) {
    const entry = remaining[0];
    const res = await send(entry);
    if (!res.ok) {
      return { outbox: { pending: remaining, seen }, delivered, error: res.description ?? 'delivery failed' };
    }
    remaining.shift();
    delivered++;
    for (const k of [entry.id, ...(entry.keys ?? [])]) seen[k] ??= entry.createdAt;
  }
  return { outbox: { pending: remaining, seen }, delivered };
}

/**
 * Folds a drain's outcome into the outbox as it is NOW, not as it was when the
 * drain read it: the other writer may have queued alerts while the sends ran,
 * and writing the drained copy back would drop them.
 */
export function mergeDrained(current: HaOutbox, drained: HaOutbox, now: Date): HaOutbox {
  const seen = { ...current.seen, ...drained.seen };
  return pruned({ pending: current.pending.filter((e) => !seen[e.id]), seen }, now);
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

export async function sendHomeAssistantNotification(
  config: HomeAssistantConfig,
  entry: HaEntry,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; description?: string }> {
  const { url, init } = homeAssistantRequest(config, entry);
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
    if (res.ok) return { ok: true };
    const hint = config.mode === 'webhook'
      ? (res.status === 404 || res.status === 405 ? ' (check the webhook URL)' : '')
      : res.status === 401 ? ' (check the access token)'
        : res.status === 400 || res.status === 404 ? ' (check the notify service name)' : '';
    return { ok: false, description: `Home Assistant answered ${res.status}${hint}` };
  } catch (err) {
    return { ok: false, description: `Could not reach Home Assistant: ${(err as Error).message}` };
  }
}
