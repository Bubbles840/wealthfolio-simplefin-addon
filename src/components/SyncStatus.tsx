import React from 'react';
import { budgetStatusLine } from '../../shared/simplefin-budget';

interface Props {
  lastSyncAt: Date | null;
  imported: number | null;
  syncing: boolean;
  /** SimpleFin requests in the last 24 hours; null/absent = unknown, say nothing. */
  simplefinToday?: number | null;
}

function timeAgo(date: Date): string {
  const mins = Math.floor((Date.now() - date.getTime()) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function SyncStatus({ lastSyncAt, imported, syncing, simplefinToday }: Props) {
  const style = { margin: '4px 0 0' };
  if (syncing) return <p className="sfin-subtle" style={style}>Syncing…</p>;
  if (!lastSyncAt) return <p className="sfin-subtle" style={style}>Never synced</p>;
  return (
    <p className="sfin-subtle" style={style}>
      Last synced {timeAgo(lastSyncAt)}
      {imported !== null && ` • ${imported} transaction${imported === 1 ? '' : 's'} imported`}
      {simplefinToday != null && ` • ${budgetStatusLine(simplefinToday)}`}
    </p>
  );
}
