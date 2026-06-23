# Testing matrix

How to exercise Crossmint regulated transfers end to end with this POC: the cases, how to run each, and what to expect.

## Prerequisites

- A Crossmint project and a server-side API key. Staging is self-serve; production payouts are enabled by Crossmint (reach out to your Crossmint contact).
- A server API key for that project (`CROSSMINT_API_KEY`).
- A server-signer secret: `deno task gen-secret`, then set `CROSSMINT_SIGNER_SECRET`.
- For a live transfer, the treasury funded with the chain's USDC. On production polygon, that is native USDC `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` (not bridged USDC.e `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174`). On staging polygon-amoy, use testnet USDC from the [Circle faucet](https://faucet.circle.com). Use a small `AMOUNT` (e.g. `0.1`) so one funding covers many runs.

## The flow (every run)

1. **Treasury wallet** - COMPANY-owned, server signer, idempotent by alias. Fund it once.
2. **Recipient user** (REST users API): submit their details (`PUT /users/{id}` with `userDetails`).
3. **Recipient wallet** - owned by the recipient user.
4. **Regulated transfer** - treasury to recipient, `transactionType: "regulated-transfer"`. This triggers the KYC + sanctions screen automatically (no separate verification call needed); the CLI retries while it processes, then confirms settlement via `wallet.transfers` (the userOp record can stay `pending` even after the transfer lands).

## The one gotcha: supported country

`RECIPIENT_COUNTRY` must be a **supported** country of residence. An unsupported country (e.g. `CA`) is rejected at transfer time.

## Commands

- `deno task transfer:dry` - run the flow, prepare the transfer, move no funds.
- `deno task transfer` - run the flow and execute the transfer.
- `deno task inspect` - print treasury + recipient balances and recent transfers (via the SDK).

## Cases

| # | Env | Chain | Recipient country | Expectation |
|---|-----|-------|-------------------|-------------|
| 1 | production | polygon | US (supported) | transfer succeeds |
| 2 | production | polygon | any, dry run | prepares, no funds move |
| 3 | staging | polygon-amoy | supported | transfer succeeds (same as prod) |
| 4 | production | polygon | unsupported (e.g. CA) | rejected (unsupported country) |

### Case 1 - production, supported country

```
# .env
ENV="production"
CHAIN="polygon"
RECIPIENT_EMAIL="<recipient-email>"
RECIPIENT_COUNTRY="US"
AMOUNT="0.1"
```

```
deno task transfer
```

Expected: `status completed`, with the on-chain transaction hash and a Polygonscan link printed in the Result block.

### Case 2 - production dry-run (no funds)

```
deno task transfer:dry
```

Expected: steps 1-3 pass; step 4 prepares the transfer without moving funds.

### Case 3 - staging

Set `ENV="staging"`, `CHAIN="polygon-amoy"`, and a supported `RECIPIENT_COUNTRY`. Staging behaves the same as production.

### Case 4 - unsupported country

Set `RECIPIENT_COUNTRY="CA"`. The transfer is rejected because the country is not supported. Switch to a supported country to proceed.

## Docs

- Regulated transfers: https://docs.crossmint.com/stablecoin-orchestration/regulated-transfers/quickstart
- Treasury wallets: https://docs.crossmint.com/wallets/guides/treasury-wallets
- Wallets SDK: https://docs.crossmint.com/wallets/quickstarts/nodejs
