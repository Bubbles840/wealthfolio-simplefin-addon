import React, { useRef, useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { Button, ErrorBox, Input } from './ui';
import {
  replaceConnection,
  type ClaimedToken,
  type ReplaceStore,
  type ReplacedConnection,
} from '../utils/connect';
import { REFUSED_CONNECTION_SHORT } from '../../shared/simplefin-connection';

interface Props {
  ctx: AddonContext;
  store: ReplaceStore;
  /** A sync or heal is running: the swap must wait for it. */
  syncing: boolean;
  onReplaced: (r: ReplacedConnection) => void;
}

/** Replace the SimpleFIN token without Reset: the new one is tested before anything is swapped. */
export function ConnectionCard({ ctx, store, syncing, onReplaced }: Props) {
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<ReplacedConnection | null>(null);
  /** A setup token claims once; a retry with the same token reuses its access URL. */
  const claimed = useRef<ClaimedToken | null>(null);
  // Connect can take seconds, and the page's toggleCard closes over the render
  // it was made in: read the handler through a ref so the latest one runs.
  const onReplacedRef = useRef(onReplaced);
  onReplacedRef.current = onReplaced;

  const connect = async () => {
    setConnecting(true);
    setError('');
    setSuccess(null);
    try {
      const outcome = await replaceConnection(token, claimed, { store, network: ctx.api.network });
      if (outcome.kind === 'failed') {
        setError(outcome.message);
        return;
      }
      setSuccess(outcome);
      setToken('');
      onReplacedRef.current(outcome);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <>
      <p className="sfin-subtle" style={{ marginTop: 0 }}>
        Replace the token if SimpleFIN stopped accepting this connection, or you made a new token in
        SimpleFIN Bridge or Lunch Flow. Your mapping, rules and history stay.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Input
          aria-label="New setup token"
          placeholder="Paste new setup token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={{ flex: 1 }}
        />
        <Button onClick={() => void connect()} disabled={!token.trim() || connecting || syncing}>
          {connecting ? 'Connecting…' : 'Connect'}
        </Button>
      </div>
      {error && <div style={{ marginTop: 12 }}><ErrorBox>{error}</ErrorBox></div>}
      {success && (
        <div style={{ marginTop: 12 }}>
          <div className="sfin-callout" role="status">{success.message}</div>
          {success.feedErrors.length > 0 && <ErrorBox>SimpleFin: {success.feedErrors.join('; ')}</ErrorBox>}
        </div>
      )}
    </>
  );
}

/** Under an error SimpleFIN refused: what it means, and the way to the card that fixes it. */
export function RefusedConnectionNote({ onReplace }: { onReplace: () => void }) {
  return (
    <>
      <div>{REFUSED_CONNECTION_SHORT}</div>
      <div style={{ marginTop: 8 }}>
        <Button variant="outline" onClick={onReplace}>Replace token</Button>
      </div>
    </>
  );
}
