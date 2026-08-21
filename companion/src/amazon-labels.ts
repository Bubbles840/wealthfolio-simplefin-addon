/**
 * companion/src/amazon-labels.ts
 *
 * Changing an Amazon label's category from Telegram.
 *
 * The label notice announces what category an Amazon order landed in, and
 * until now that was the end of it: a wrong guess meant opening the app to fix
 * it, which is exactly the trip the notice exists to save. This turns the
 * notice into something actionable.
 *
 * MAIN CATEGORIES ONLY, deliberately. Every rule in
 * `DEFAULT_AMAZON_LABEL_RULES` targets a top-level category (Groceries,
 * Housing, Electronics …) and `defaultCategory` is one too, so the feature has
 * never filed an Amazon charge under a subcategory. A picker offering them
 * would imply a precision the rest of the feature does not have — and would
 * need paging, since there are ~52.
 */
import type { InlineKeyboard } from '../../shared/telegram.js';
import { MENU_CALLBACK_PREFIX } from '../../shared/categorize-menu.js';
import {
  DEFAULT_AMAZON_CATEGORY,
  type AmazonMailConfig,
  type AmazonLabelCatalog,
} from '../../shared/amazon-config.js';
import { DEFAULT_AMAZON_LABEL_RULES } from '../../shared/amazon.js';

/** `cz:al:<token>` opens the picker; `cz:alc:<token>:<i>` chooses. Both ride
 *  the categorize prefix so the listener's existing routing and its
 *  foreign-chat authorisation apply unchanged. */
const OPEN_PREFIX = `${MENU_CALLBACK_PREFIX}al:`;
const CHOOSE_PREFIX = `${MENU_CALLBACK_PREFIX}alc:`;

/** How many labels one notice offers a button for. A notice announcing more
 *  than a handful is already a wall of text; the rest stay fixable in the app. */
const MAX_LABEL_BUTTONS = 5;

/** Bounded so a long-running daemon cannot accumulate sessions for notices
 *  nobody will ever tap. Oldest entries are dropped first; a tap on one that
 *  aged out is answered as expired, the same as one that outlived a restart. */
const MAX_SESSIONS = 50;

export interface AmazonLabelMenuDeps {
  readConfig(): Promise<AmazonMailConfig | null>;
  /** MUST merge into the stored config. It holds the mailbox password, and a
   *  whole-object write from a stale snapshot would delete it. */
  writeConfig(next: AmazonMailConfig): Promise<void>;
  readLabels(): Promise<AmazonLabelCatalog>;
  writeLabels(map: AmazonLabelCatalog): Promise<void>;
  /** Top-level spending categories as the user's own Wealthfolio has them. */
  mainCategories(): Promise<string[]>;
  log(msg: string): void;
}

export interface AmazonLabelMenuUi {
  edit(text: string, keyboard?: InlineKeyboard): Promise<void>;
  answer(text?: string): Promise<void>;
}

export interface AmazonLabelMenu {
  /** Buttons to append to a label notice, or undefined when there is nothing
   *  worth offering. */
  keyboardFor(labels: string[]): InlineKeyboard | undefined;
  /** Whether this controller owns the tap — checked before the categorize
   *  controller sees it, since both share the `cz:` prefix. */
  handles(data: string): boolean;
  onCallback(cb: { data: string }, ui: AmazonLabelMenuUi): Promise<void>;
}

/** The categories the built-in rules can produce, used when the database is
 *  not mounted. Deduped and sorted so the picker is stable either way. */
function fallbackCategories(): string[] {
  const names = new Set<string>([DEFAULT_AMAZON_CATEGORY]);
  for (const rule of DEFAULT_AMAZON_LABEL_RULES) names.add(rule.category);
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Telegram rejects a callback_data over 64 bytes, and silently misbehaves
 *  around the edge, so the choice is carried as an INDEX into a remembered
 *  list rather than as a category name of unknown length. */
interface Session {
  label: string;
  /** Snapshotted when the picker is drawn, so the index a tap carries always
   *  refers to what that message actually showed — even if the category list
   *  changed in between. */
  categories: string[];
}

export function createAmazonLabelMenu(deps: AmazonLabelMenuDeps): AmazonLabelMenu {
  const sessions = new Map<string, Session>();
  let counter = 0;

  const remember = (label: string): string => {
    // Reuse an existing token for the same label, so two notices about one
    // label do not both occupy a slot.
    for (const [token, s] of sessions) if (s.label === label) return token;
    const token = String(++counter);
    sessions.set(token, { label, categories: [] });
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
    return token;
  };

  const expired = async (ui: AmazonLabelMenuUi) => {
    await ui.answer('That menu expired — set the category in the addon instead.');
  };

  return {
    keyboardFor(labels: string[]): InlineKeyboard | undefined {
      const shown = labels.slice(0, MAX_LABEL_BUTTONS);
      if (shown.length === 0) return undefined;
      return {
        inline_keyboard: shown.map((label) => [{
          // The label is in the button because the notice may list several and
          // "Change category" alone would not say which one this changes.
          text: `Change: ${label}`,
          callback_data: `${OPEN_PREFIX}${remember(label)}`,
        }]),
      };
    },

    handles(data: string): boolean {
      return data.startsWith(OPEN_PREFIX) || data.startsWith(CHOOSE_PREFIX);
    },

    async onCallback(cb, ui) {
      try {
        if (cb.data.startsWith(OPEN_PREFIX)) {
          const token = cb.data.slice(OPEN_PREFIX.length);
          const session = sessions.get(token);
          if (!session) return void await expired(ui);

          let categories = await deps.mainCategories().catch(() => []);
          if (categories.length === 0) categories = fallbackCategories();
          session.categories = categories;

          await ui.edit(
            `Category for *${session.label}*?`,
            {
              inline_keyboard: [
                ...categories.map((name, i) => [{
                  text: name,
                  callback_data: `${CHOOSE_PREFIX}${token}:${i}`,
                }]),
              ],
            },
          );
          await ui.answer();
          return;
        }

        const rest = cb.data.slice(CHOOSE_PREFIX.length);
        const sep = rest.lastIndexOf(':');
        const token = sep === -1 ? rest : rest.slice(0, sep);
        const index = sep === -1 ? NaN : Number(rest.slice(sep + 1));
        const session = sessions.get(token);
        // Resolved against the SNAPSHOT the picker drew, never a fresh read —
        // a category added in between would otherwise shift every index and
        // file the order under the wrong one.
        const category = session?.categories[index];
        if (!session || !category) return void await expired(ui);

        // Read-modify-write: this secret also holds the mailbox host, user and
        // app password.
        const cfg = (await deps.readConfig()) ?? {};
        await deps.writeConfig({
          ...cfg,
          labelOverrides: { ...(cfg.labelOverrides ?? {}), [session.label]: category },
        });

        // Keep the addon's own label list in step, so the Sync page shows the
        // same answer as the chat does. Best-effort: the override above is what
        // actually decides future filings, and failing to update a display
        // catalogue must not report the change as failed.
        try {
          const labels = await deps.readLabels();
          await deps.writeLabels({
            ...labels,
            [session.label]: { category, matched: true },
          });
        } catch (err) {
          deps.log(`Amazon label catalogue not updated for "${session.label}": ${String(err)}`);
        }

        await ui.edit(
          `*${session.label}* → *${category}*\n\n`
          + 'Future Amazon orders with this label file here. Charges already '
          + 'imported keep the category they were given.',
        );
        await ui.answer(`Set to ${category}`);
      } catch (err) {
        deps.log(`Amazon label menu error: ${String(err)}`);
        // Never leave the button spinning, whatever went wrong.
        await ui.answer('Could not save that — try the addon.').catch(() => {});
      }
    },
  };
}
