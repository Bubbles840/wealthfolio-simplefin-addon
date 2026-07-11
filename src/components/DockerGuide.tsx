import React, { useEffect, useState } from 'react';
import type { SecretsStore } from '../utils/secrets';
import { generateEnvFile, generateComposeSnippet } from '../utils/compose-gen';
import { Button } from './ui';

interface Props { store: SecretsStore }

const isTauri = typeof (window as any).__TAURI__ !== 'undefined';

function CopyBlock({ label, content }: { label: string; content: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <strong style={{ fontSize: 13 }}>{label}</strong>
        <Button variant="ghost" onClick={copy}>{copied ? 'Copied!' : 'Copy'}</Button>
      </div>
      <pre className="sfin-pre">
        {content}
      </pre>
    </div>
  );
}

export function DockerGuide({ store }: Props) {
  const [open, setOpen] = useState(!isTauri);
  const [envFile, setEnvFile] = useState('');
  const [composeSnippet, setComposeSnippet] = useState('');

  useEffect(() => {
    if (!open) return;
    Promise.all([
      store.getAccountMapping(),
      store.getMappingRules(),
      store.getSyncScheduleHours(),
    ]).then(([mapping, rules, hours]) => {
      if (!mapping) return;
      const config = {
        // Wealthfolio's server listens on 8088 inside the container
        wealthfolioApiUrl: 'http://wealthfolio:8088',
        accountMapping: mapping,
        syncSchedule: `0 */${hours ?? 6} * * *`,
        lookbackDays: 7,
        mappingRules: rules,
      };
      setEnvFile(generateEnvFile(config));
      setComposeSnippet(generateComposeSnippet(config));
    });
  }, [open, store]);

  return (
    <div className="sfin-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600, color: 'var(--foreground)', padding: 0, fontSize: 14, fontFamily: 'inherit' }}
      >
        {open ? '▼' : '▶'} Docker Background Sync Setup
        {isTauri && <span className="sfin-subtle" style={{ fontSize: 11, fontWeight: 'normal', marginLeft: 8 }}>(desktop app — only needed if you move to Docker)</span>}
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          <div className="sfin-callout">
            🔐 For security, this guide never shows your bank credentials. Instead, get a{' '}
            <strong>new setup token</strong> from your{' '}
            <a href="https://beta-bridge.simplefin.org" target="_blank" rel="noreferrer">
              SimpleFin Bridge account page
            </a>{' '}
            (the same kind you used to set up this addon) and paste it into the{' '}
            <code>SIMPLEFIN_SETUP_TOKEN=</code> line of the file below. On first start, the sync
            service exchanges the one-time token for credentials and keeps them in its own Docker
            volume — they never touch this file. Still add <code>simplefin-sync.env</code> to{' '}
            <code>.gitignore</code>.
          </div>

          <CopyBlock
            label="1. Copy the sync service source to your server (from the addon repo)"
            content={[
              'ssh your-server mkdir -p /path/to/compose-dir/simplefin-sync',
              'scp -r wealthfolio-simplefin-addon/companion wealthfolio-simplefin-addon/shared \\',
              '  your-server:/path/to/compose-dir/simplefin-sync/',
            ].join('\n')}
          />
          <CopyBlock label="2. Save as simplefin-sync.env, then paste your setup token into it" content={envFile} />
          <CopyBlock label="3. Add to your docker-compose.yml" content={composeSnippet} />
          <CopyBlock label="4. Build and start the service" content="docker compose up -d --build simplefin-sync" />
          <CopyBlock label="5. Verify it's running" content="docker compose logs simplefin-sync" />
        </div>
      )}
    </div>
  );
}
