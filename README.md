# wealthfolio-simplefin-addon

A Wealthfolio addon for wealthfolio-simplefin-addon

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev:server

# Build for production
npm run build

# Package addon
npm run bundle
```

## Features

- Add your features here

## Usage

### Transfers, card payments & refunds

- Transfers between two synced accounts (e.g. paying a credit card from
  checking) are detected automatically — equal amounts, opposite signs,
  within 3 days — and imported as a linked Transfer Out / Transfer In pair,
  excluded from spending and income analytics.
- The in-app **Sync Now** can type transfers but not link them; the Docker
  companion links them on its next run (or link manually in the Spending UI).
- Positive amounts on credit-card accounts import as **Credit** (refunds,
  netted against spending) unless they look like a card payment
  ("payment", "autopay", "thank you", "e-pay"), which become Transfer In.
- Your mapping rules always win over automatic detection — add a rule if a
  bank's phrasing needs different treatment.
- The companion logs a warning when a synced account's balance drifts more
  than $1 from what SimpleFin reports.

### Starting balances

Automatic starting-balance corrections (so an account lands on its real bank
balance instead of just the sum of imported transactions) are handled by the
**Docker companion only** — it reads accurate balances from Wealthfolio's
valuations API and tracks which accounts are done in its own state. The
in-app **Sync Now** deliberately never creates balance entries. If you run
without the companion, set an opening balance once via the account page's
edit-balance control.

## License

MIT
