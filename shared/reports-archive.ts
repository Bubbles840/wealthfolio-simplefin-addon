/**
 * shared/reports-archive.ts
 *
 * The Reports tab's data: for each report (daily, weekly, monthly) the live
 * edition as of the last sync, plus an archive of the editions that were sent.
 *
 * Why it exists. The Telegram reports were the part of Telegram worth keeping:
 * every report kept as a browsable history, and any report pulled up on demand.
 * The companion now publishes them into Wealthfolio itself, so the history
 * lives next to the data it describes and needs no chat app. The companion
 * writes; the addon only reads.
 *
 * Stored one addon secret per report kind (`reports_daily`, …), each bounded by
 * a count AND a byte cap, so no key can grow past what the host will store.
 */

export type ReportKind = 'daily' | 'weekly' | 'monthly';
export const REPORT_KINDS: readonly ReportKind[] = ['daily', 'weekly', 'monthly'];

export interface ReportEdition {
  kind: ReportKind;
  /** `YYYY-MM-DD` for a day, the Monday `YYYY-MM-DD` for a week, `YYYY-MM` for a month. */
  period: string;
  /** Heading shown above the edition, e.g. "Wednesday, Sep 23". */
  title: string;
  /** ISO timestamp the text was composed. */
  generatedAt: string;
  /** The report body, in Telegram's Markdown (the same text Telegram gets). */
  text: string;
}

export interface ReportStore {
  /** The current period's edition, recomposed after every sync. */
  live: ReportEdition | null;
  /** Editions as they were sent, newest first. */
  archive: ReportEdition[];
}

export const reportsSecretKey = (kind: ReportKind) => `reports_${kind}`;

/** Two months of dailies, half a year of weeklies, two years of wrap-ups. */
export const REPORT_ARCHIVE_LIMITS: Record<ReportKind, number> = { daily: 62, weekly: 26, monthly: 24 };

/** The same ceiling the report cube uses for one secret. */
export const REPORTS_MAX_BYTES = 200_000;

export const emptyReportStore = (): ReportStore => ({ live: null, archive: [] });

const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

export function withLive(store: ReportStore, edition: ReportEdition): ReportStore {
  return { ...store, live: edition };
}

/**
 * Adds an edition to the archive: newest first, one per period (a resend
 * replaces the earlier copy), trimmed from the OLD end to the kind's count and
 * then to the byte cap.
 */
export function withArchived(store: ReportStore, edition: ReportEdition): ReportStore {
  const archive = [edition, ...store.archive.filter((e) => e.period !== edition.period)]
    .sort((a, b) => (a.period < b.period ? 1 : a.period > b.period ? -1 : 0))
    .slice(0, REPORT_ARCHIVE_LIMITS[edition.kind]);
  const next: ReportStore = { ...store, archive };
  while (next.archive.length > 1 && byteLength(next) > REPORTS_MAX_BYTES) next.archive.pop();
  return next;
}

/** Parses a stored secret, tolerating absence and damage: the tab shows
 *  "nothing yet" rather than breaking over one bad value. */
export function parseReportStore(raw: string | null | undefined): ReportStore {
  if (!raw) return emptyReportStore();
  try {
    const parsed = JSON.parse(raw) as Partial<ReportStore>;
    return {
      live: parsed.live && typeof parsed.live.text === 'string' ? parsed.live : null,
      archive: Array.isArray(parsed.archive) ? parsed.archive.filter((e) => e && typeof e.text === 'string') : [],
    };
  } catch {
    return emptyReportStore();
  }
}

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The period a report covers at `now`, in local time like every other report. */
export function reportPeriod(kind: ReportKind, now: Date): string {
  if (kind === 'daily') return ymd(now);
  if (kind === 'monthly') return ymd(now).slice(0, 7);
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  return ymd(monday);
}

const ADDON_ROUTE = '/addons/simplefin-sync';

/** Where a notification tap lands: the Reports tab, on this report. */
export function reportsLink(kind: ReportKind): string {
  return `${ADDON_ROUTE}?tab=reports&report=${kind}`;
}

/** Reads a route's query. `null` unless it asks for the Reports tab; an
 *  unknown report falls back to Daily rather than an empty panel. */
export function parseReportsLink(search: string | undefined): { report: ReportKind } | null {
  if (!search) return null;
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (params.get('tab') !== 'reports') return null;
  const report = params.get('report');
  return { report: (REPORT_KINDS as readonly string[]).includes(report ?? '') ? (report as ReportKind) : 'daily' };
}

/** One short plain-text line for a notification body: markdown stripped,
 *  lines joined, cut at a word. */
export function notificationPreview(text: string, max = 180): string {
  const plain = text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' · ');
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20))}…`;
}
