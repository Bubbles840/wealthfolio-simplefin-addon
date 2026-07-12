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

### Syncing

The addon syncs when you open Wealthfolio (a catch-up runs on startup),
while a tab is open (on your chosen interval), and whenever you press
**Sync Now**. A one-hour minimum interval acts as a cooldown, so reloading
the page is a cheap no-op.

### Transfers, card payments & refunds

- Transfers between two synced accounts (e.g. paying a credit card from
  checking) are detected automatically — equal amounts, opposite signs,
  within 3 days — and imported as a Transfer Out / Transfer In pair,
  excluded from spending and income analytics.
- Wealthfolio does not yet expose a linking API to addons ([upstream issue
  filed](companion/upstream-pr.md)), so link the two sides with one click in
  the Spending tab: open the Transfer Out row's ⋮ menu → **Link transfer** →
  pick the matching Transfer In.
- Positive amounts on credit-card accounts import as **Credit** (refunds,
  netted against spending) unless they look like a card payment
  ("payment", "autopay", "thank you", "e-pay"), which become Transfer In.
- Your mapping rules always win over automatic detection — add a rule if a
  bank's phrasing needs different treatment.

### Starting balances

On an account's first sync the addon reads its current balance from
Wealthfolio's valuations API and adds a one-time correction so the account
lands on its real bank balance instead of just the sum of imported
transactions. For a brand-new account the valuation is computed
asynchronously after the first import, so the addon polls briefly and applies
the correction in the same run.

### Background sync (optional companion)

Wealthfolio addons only run while a browser tab is open. If you want data to
refresh without opening the app, the `companion/` folder contains an optional
Docker service that runs the **same sync logic** on a schedule. It is not
required — the addon is the complete product — and is documented separately
in that folder.

## License

MIT
