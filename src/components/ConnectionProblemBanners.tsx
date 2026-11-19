import React from 'react';
import {
  connectionProblemText,
  connectionProblemTitle,
  type ConnectionProblem,
} from '../../shared/connection-problems';

/**
 * One warning banner per SimpleFin connection problem the page decided to show
 * (#81). The Bridge link is the Bridge's own origin, computed from the access
 * URL by the page: this component never sees the URL or its credentials.
 */
export function ConnectionProblemBanners({ problems, bridgeSite }: {
  problems: readonly ConnectionProblem[];
  bridgeSite: string | null;
}) {
  return (
    <>
      {problems.map((p) => (
        <div className="sfin-banner-warn" key={p.key}>
          <div className="sfin-banner-body">
            {p.kind === 'other' && <b>{connectionProblemTitle(p)}. </b>}
            {connectionProblemText(p)}
            {p.kind === 'signin' && bridgeSite && (
              <div className="sfin-banner-actions">
                <a className="sfin-btn sfin-btn--outline" href={bridgeSite} target="_blank" rel="noreferrer">
                  Open SimpleFIN Bridge
                </a>
              </div>
            )}
          </div>
        </div>
      ))}
    </>
  );
}
