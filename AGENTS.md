# Agent guide

This repo runs a Crossmint **regulated transfer** end to end. It is designed to be run and extended
by a coding agent (e.g. Claude Code). The output is written to read like documentation - your job is
to drive it and relay what it says.

## The one rule: surface the CLI's own output

When you run a task here, **show the CLI's stdout to the user verbatim** (the plan, the per-step
lines, the Result block). That output IS the result and the documentation - do not replace it with
your own summary. If a step is blocked, the CLI already prints the exact reason and a docs link;
relay that, then add your interpretation if useful.

## Run it

1. `cp .env.example .env`. Set `CROSSMINT_API_KEY` to a server key for a project set up for payouts
   (staging is self-serve; production is enabled by Crossmint).
2. `deno task gen-secret` -> paste into `.env` as `CROSSMINT_SIGNER_SECRET`.
3. `deno task transfer:dry` (prepare, no funds) or `deno task transfer` (execute).

Use `--debug` to see the SDK's own `[SDK]` logs (suppressed by default for clean output).

## Generate documentation from a live run

`deno task docs` runs the flow and writes `docs/REGULATED_TRANSFERS.md` from the real requests,
responses, and addresses of that run. It wraps `fetch` before the SDK initializes, so it captures
the API calls underneath the SDK (not just the REST steps), with full untruncated addresses and ids.
After running it, surface the generated file path - that doc is the deliverable. Re-run to refresh
after anything changes (for example once a gate clears).

## What runs (each step links to the docs in code)

- **Step 1** treasury wallet - `owner: "COMPANY"`, server signer, fixed `alias` (idempotent -> same
  address every run, locator `COMPANY:<alias>`).
- **Step 2** recipient user via the REST users API (provide their userDetails).
- **Step 3** recipient wallet owned by that user.
- **Step 4** the regulated transfer to the recipient's wallet **address** (not the email locator -
  `wallet.send` resolves an on-chain recipient), `transactionType: "regulated-transfer"`.

## Re-runnable by design

- Treasury is idempotent on its alias; recipient wallet is idempotent by owner; the recipient REST
  calls are PUTs. So re-running is safe and cheap.
- A freshly created recipient's KYC takes a few seconds; step 4 retries automatically on "User KYC
  is in progress".
- `--dry-run` prepares the transfer without moving funds - use it freely to validate setup.

## Known gates (what the CLI may report)

- **Treasury wallets not enabled** - payouts are not turned on for this project (staging is
  self-serve).
- **Not configured to support regulated transfers KYC** - project's region/entity not set (this is
  the EU-vs-US gate; see below).
- **Recipient KYC in progress** - transient; the script retries.
- **Recipient screening / can't receive assets** - use a supported `countryOfResidence`. A freshly
  created recipient is screened first, so this can be transient while the screen runs.
- **Insufficient balance** - fund the treasury with the token being sent.

## EU vs US

`RECIPIENT_COUNTRY` drives the KYC legal entity (`US` -> US entity, else EU entity). Run with an
EU-region project key, then a US-region project key, to compare whether a US-region project is
blocked.

## Files

- `main.ts` - config (env via `@std/dotenv`), the server signer, jurisdiction helper, REST helper.
- `ui.ts` - console presentation (plan, steps, spinner, colors; no emojis; SDK-log suppression).
- `scripts/regulated-transfer.ts` - the four-step flow.
- `scripts/generate-docs.ts` - run the flow live and emit `docs/REGULATED_TRANSFERS.md`.
- `scripts/gen-secret.ts` - generate the server-signer secret.

## Docs

- Regulated transfers:
  https://docs.crossmint.com/stablecoin-orchestration/regulated-transfers/quickstart
- Server signer: https://docs.crossmint.com/wallets/guides/signers/server-signer
- Treasury wallets: https://docs.crossmint.com/wallets/guides/treasury-wallets
- Wallets SDK (Node): https://docs.crossmint.com/wallets/quickstarts/nodejs
