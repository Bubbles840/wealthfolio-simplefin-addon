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

### Architecture: addon first, companion optional

The addon is the complete product: it syncs when you use the app (Sync Now
plus the in-app schedule while a tab is open), detects transfers, types card
refunds, and creates one-time starting-balance corrections using accurate
balances from Wealthfolio's valuations API. The Docker companion exists only
because Wealthfolio addons can't run when no browser tab is open — it runs
the **same shared sync logic** in the background. Running both is safe: the
correction math self-cancels when the other side already did the work.

The one thing only the companion can do today is *link* the two sides of a
transfer (the addon SDK exposes no link API — upstream issue filed). Without
the companion, link a detected pair with one click in the Spending UI.

## License

MIT
