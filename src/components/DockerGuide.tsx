import React, { useEffect, useState } from 'react';
import type { SecretsStore } from '../utils/secrets';
import { generateEnvFile, generateComposeSnippet } from '../utils/compose-gen';

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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>{label}</strong>
        <button type="button" onClick={copy}>{copied ? 'Copied!' : 'Copy'}</button>
      </div>
      <pre style={{ background: '#111', color: '#eee', padding: 12, borderRadius: 4, overflow: 'auto', fontSize: 12 }}>
        {content}
      </pre>
    </div>
  );
}

export function DockerGuide({ store }: Props) {
  const [open, setOpen] = useState(!isTauri);
  const [envFile, setEnvFile] = useState('');
  const [composeSnippet, setComposeSnippet] = useState('');
  const [masked, setMasked] = useState(true);
  const [accessUrl, setAccessUrl] = useState('');

  useEffect(() => {
    if (!open) return;
    Promise.all([
      store.getAccessUrl(),
      store.getAccountMapping(),
      store.getMappingRules(),
      store.getSyncScheduleHours(),
    ]).then(([url, mapping, rules, hours]) => {
      if (!url || !mapping) return;
      const config = {
        accessUrl: url,
        wealthfolioApiUrl: 'http://wealthfolio:7500',
        accountMapping: mapping,
        syncSchedule: `0 */${hours ?? 6} * * *`,
        lookbackDays: 7,
        mappingRules: rules,
      };
      setAccessUrl(url);
      setEnvFile(generateEnvFile(config));
      setComposeSnippet(generateComposeSnippet(config));
    });
  }, [open, store]);

  return (
    <div style={{ borderTop: '1px solid #333', marginTop: 16, paddingTop: 16 }}>
      <button type="button" onClick={() => setOpen((o) => !o)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}>
        {open ? '▼' : '▶'} Docker Background Sync Setup
        {isTauri && <span style={{ fontSize: 11, fontWeight: 'normal', marginLeft: 8, opacity: 0.6 }}>(desktop app — only needed if you move to Docker)</span>}
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          <div style={{ background: '#4a1414', color: '#ffaaaa', padding: 10, borderRadius: 4, marginBottom: 16, fontSize: 13 }}>
            ⚠️ The access URL below contains your bank credentials. Treat it like a password — store it only in a <code>.env</code> file and add that file to <code>.gitignore</code>. Never commit it to git.
          </div>

          <div style={{ marginBottom: 12 }}>
            <strong>Your SimpleFin Access URL:</strong>{' '}
            <code>{masked ? accessUrl.replace(/\/\/[^@]+@/, '//***@') : accessUrl}</code>{' '}
            <button type="button" onClick={() => setMasked((m) => !m)}>
              {masked ? 'Reveal' : 'Hide'}
            </button>
            <button
              type="button"
              style={{ marginLeft: 8 }}
              onClick={() => navigator.clipboard.writeText(accessUrl)}
            >
              Copy
            </button>
          </div>

          <CopyBlock label="1. Save as simplefin-sync.env" content={envFile} />
          <CopyBlock label="2. Add to your docker-compose.yml" content={composeSnippet} />
          <CopyBlock label="3. Start the service" content="docker compose up -d simplefin-sync" />
          <CopyBlock label="4. Verify it's running" content="docker compose logs simplefin-sync" />
        </div>
      )}
    </div>
  );
}
