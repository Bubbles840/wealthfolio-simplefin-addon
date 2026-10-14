import React, { useState } from 'react';
import { Button } from './ui';
import { composeSnippet } from '../../shared/compose-snippet';

/** This browser's IANA zone, or null where Intl cannot say. */
export function browserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * The body of Settings → "Background sync (Docker)" (project 4, G1): the ONE
 * compose service (shared/compose-snippet.ts) with this browser's timezone
 * filled in, and a Copy button. It is the only setup instruction most people
 * read, so it is complete — the database mount included. The `<pre>` stays
 * selectable: the add-on runs in a sandboxed iframe, where the clipboard API
 * may be refused.
 */
export function DockerSnippet({ timezone = browserTimezone() }: { timezone?: string | null }) {
  const snippet = composeSnippet({ timezone });
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  };
  return (
    <div>
      <div className="sfin-subtle sfin-docker-intro">
        {/* The keys sit in <code> with the colon outside, so the note's text never
            reads as the snippet to a /services:/ search (SettingsTab.test.tsx). */}
        Add this to the same docker-compose.yml as Wealthfolio — merge its{' '}
        <code>services</code>: and <code>secrets</code>: into the ones already there.
      </div>
      <pre className="sfin-pre sfin-docker-pre" aria-label="Docker Compose snippet" tabIndex={0}>{snippet}</pre>
      <div className="sfin-docker-copy">
        <Button variant="outline" onClick={copy}>Copy snippet</Button>
        {/* Always in the DOM: screen readers announce changes only inside a live
            region that already exists. */}
        <span role="status" className="sfin-subtle">
          {copied === 'ok' && ' Copied.'}
          {copied === 'failed' && " Couldn't copy here — select the text above and copy it."}
        </span>
      </div>
      <div className="sfin-subtle sfin-docker-note">
        The database mount is what lets the companion count spending that still
        needs a category, and fill in category names and budgets in its reports.
        Point it at the folder that contains <code>wealthfolio.db</code>. It syncs
        every 6 hours; add <code>SYNC_SCHEDULE</code> (a cron line) to change that.
      </div>
    </div>
  );
}
