import React, { useState } from 'react';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { Button, CollapsibleCard, Disclosure, statusToneClass } from './ui';
import type { StatusMessage } from './ui';
import { sendTelegramMessage } from '../../shared/telegram';
import { NOTIF_CARD } from '../tabs/NotificationsTab';
import type { TelegramCfgDraft, CfgPatch } from '../tabs/NotificationsTab';

interface Props {
  cfg: TelegramCfgDraft;
  onChange: (patch: CfgPatch) => void;
  ctx: AddonContext;
  /** Owned by the tab because a save reports through it too, and the save bar
   *  lives outside this card. `{ text, tone }` rather than a bare string: the
   *  tone used to be recovered by sniffing a ✅/❌ prefix off the text, which
   *  made the emoji load-bearing — see `statusToneClass`. */
  status: StatusMessage | null;
  onStatus: (status: StatusMessage | null) => void;
  isOpen: (id: string) => boolean;
  toggleCard: (id: string) => void;
}

/**
 * The credentials half: a bot token, a chat id, the one-time setup guide, and a
 * test send.
 *
 * "Send test" deliberately reads the FIELDS rather than the stored config, so a
 * freshly-pasted token can be verified before it is committed — otherwise the
 * only way to find out a token is wrong would be to save the wrong one first.
 */
export function TelegramConnect({
  cfg, onChange, ctx, status, onStatus, isOpen, toggleCard,
}: Props) {
  const [testing, setTesting] = useState(false);
  const connected = !!cfg.botToken && !!cfg.chatId;

  return (
    <CollapsibleCard
      id={NOTIF_CARD.connection}
      title="Telegram connection"
      summary={connected ? 'Connected' : 'Not connected'}
      open={isOpen(NOTIF_CARD.connection)}
      onToggle={() => toggleCard(NOTIF_CARD.connection)}
    >
      <div className="sfin-subtle sfin-notif-intro">
        Daily spending allowances and weekly budget summaries, sent by the companion container.
      </div>

      {/* Read once, ever — so it stays behind a disclosure rather than costing
          every later visit ~130px of scrolling. Same `Disclosure` primitive as
          the cards, in its nested flavour, so there is one pattern to learn. */}
      <div className="sfin-disc-inset sfin-notif-intro">
        <Disclosure
          id={NOTIF_CARD.guide}
          variant="inline"
          title="How to set up your Telegram bot"
          open={isOpen(NOTIF_CARD.guide)}
          onToggle={() => toggleCard(NOTIF_CARD.guide)}
        >
          <ol>
            <li>Open Telegram and search for <strong>@BotFather</strong>.</li>
            <li>Send <code>/newbot</code> to @BotFather and follow prompts to name your bot.</li>
            <li>Copy the HTTP API <strong>Token</strong> (e.g. <code>123456789:ABCdefGHI...</code>).</li>
            <li>Open Telegram and send a message <code>/start</code> to your new bot.</li>
            <li>Search Telegram for <strong>@userinfobot</strong> and send any message to get your numeric <strong>Chat ID</strong> (e.g. <code>987654321</code>).</li>
            <li>Paste your bot token and chat ID below, then click <strong>Send test message</strong>.</li>
          </ol>
        </Disclosure>
      </div>

      <div className="sfin-stack">
        {/* Two short, related fields: side by side on a normal window, and the
            labels are actually tied to their inputs. */}
        <div className="sfin-fields">
          <div>
            <label htmlFor="sfin-bot-token" className="sfin-subtle">Bot token</label>
            <input
              id="sfin-bot-token"
              type="password"
              className="sfin-select"
              placeholder="e.g. 123456789:ABCdefGHI..."
              value={cfg.botToken}
              onChange={(e) => onChange({ botToken: e.target.value })}
            />
          </div>
          <div>
            <label htmlFor="sfin-chat-id" className="sfin-subtle">Chat ID</label>
            <input
              id="sfin-chat-id"
              type="text"
              className="sfin-select"
              placeholder="e.g. 987654321"
              value={cfg.chatId}
              onChange={(e) => onChange({ chatId: e.target.value })}
            />
          </div>
        </div>

        {/* role="status" so the send/save result is announced — the words say
            what happened, and the colour only reinforces it. The in-flight
            "Sending…" message carries the `busy` tone and so is never painted
            destructive-red for having failed no test yet. */}
        {status && (
          <div role="status" className={`sfin-status ${statusToneClass(status.tone)}`}>
            {status.text}
          </div>
        )}

        <div className="sfin-stack-actions">
          <Button
            variant="outline"
            disabled={testing || !connected}
            onClick={async () => {
              setTesting(true);
              onStatus({ text: 'Sending test message…', tone: 'busy' });
              try {
                const timeoutPromise = new Promise<{ ok: false; description: string }>((_, reject) =>
                  setTimeout(() => reject(new Error('Request timed out after 5 seconds')), 5000)
                );

                const sendPromise = sendTelegramMessage(
                  cfg.botToken,
                  cfg.chatId,
                  '🎉 *SimpleFin Sync Telegram Integration Connected!*\n\nYour Telegram bot is configured and ready to send daily category allowances and weekly budget reports.',
                  ctx.api.network,
                );

                const res = await Promise.race([sendPromise, timeoutPromise]);
                if (res.ok) {
                  onStatus({ text: 'Test message sent.', tone: 'ok' });
                } else {
                  onStatus({ text: `Error sending message: ${res.description}`, tone: 'error' });
                }
              } catch (err) {
                console.error('[Telegram Debug Error]:', err);
                onStatus({ text: `Error: ${(err as Error).message}`, tone: 'error' });
              } finally {
                setTesting(false);
              }
            }}
          >
            {testing ? 'Sending…' : 'Send test message'}
          </Button>
        </div>
      </div>
    </CollapsibleCard>
  );
}
