/**
 * Regulated transfer, end to end, with the Crossmint wallets SDK + server signer.
 *
 * What it does: moves a stablecoin from a COMPANY-owned treasury wallet to a
 * KYC-verified recipient, as a `regulated-transfer`. It prints a plan before it
 * runs, narrates each step, and on a block prints the exact reason + the docs
 * link - so the output alone documents what a project needs to support the flow.
 *
 * Run:
 *   deno task transfer            # set up wallets + recipient, then send
 *   deno task transfer:dry        # same setup, but prepare the transfer only
 *
 * The setup steps are idempotent (wallets are keyed by owner; the recipient-user
 * calls are PUTs), so it is safe to re-run as a test suite. Each run that is not
 * a dry run sends one fresh transfer.
 *
 * Prerequisites: a project set up for payouts. Staging is self-serve; production is enabled by
 *   Crossmint.
 *     Docs: https://docs.crossmint.com/stablecoin-orchestration/regulated-transfers/quickstart
 */
import { type Chain, createCrossmint, CrossmintWallets, type Wallet } from "@crossmint/wallets-sdk";
import { parseArgs } from "@std/cli/parse-args";
import { delay } from "@std/async/delay";
import {
  AMOUNT,
  apiJson,
  buildUserDetails,
  CHAIN,
  config,
  ENV,
  kycLegalEntity,
  RECIPIENT,
  serverSigner,
  TOKEN,
  TOKEN_LOCATOR,
  TREASURY_ALIAS,
  TREASURY_LOCATOR,
} from "../main.ts";
import * as ui from "../ui.ts";

const { "dry-run": dryRun, debug } = parseArgs(Deno.args, { boolean: ["dry-run", "debug"] });
const TOTAL = 4;

/**
 * Right after a recipient is created, their KYC takes a few seconds to
 * finish; the transfer returns "User KYC is in progress" until then. We retry so a
 * fresh run completes unattended. On re-runs (KYC already done) the first try wins.
 */
const KYC_RETRY = { attempts: 12, delayMs: 5_000 };
const isKycPending = (message: string): boolean =>
  /KYC is in progress|retry in a few seconds/i.test(message);

/** The SDK client. Created inside `main` (after the plan prints) so a bad key is reported cleanly. */
type Wallets = ReturnType<typeof CrossmintWallets.from>;

/** Result shape of `wallet.send` (and its prepareOnly path, where hash is absent). */
type SendResult = { transactionId?: string; hash?: string; explorerLink?: string };

/** How long to keep confirming settlement after the SDK stops waiting for the userOp. */
const SETTLE_RETRY = { attempts: 12, delayMs: 5_000 };

/** The SDK's confirmation wait can expire before the bundler settles - treat as non-fatal. */
const isConfirmationTimeout = (message: string): boolean =>
  /confirmation timeout|timed out|timeout/i.test(message);

/**
 * Confirm a regulated transfer settled via `wallet.transfers` - the authoritative
 * money-movement view. The userOp transaction record can stay `pending` even after the
 * transfer lands on-chain, so polling `transactions()` is not enough; the successful
 * transfers list is. Returns the on-chain hash + explorer link of an outbound transfer
 * that completed after `since`.
 */
const confirmSettlement = async (
  treasury: Wallet<Chain>,
  since: number,
): Promise<SendResult | null> => {
  for (let attempt = 1; attempt <= SETTLE_RETRY.attempts; attempt++) {
    try {
      const { data } = await treasury.transfers({ tokens: TOKEN, status: "successful" }) as {
        data: Array<
          {
            type?: string;
            completedAt?: string;
            onChain?: { txId?: string; explorerLink?: string };
          }
        >;
      };
      const match = data.find((t) =>
        t.type === "wallets.transfer.out" && t.completedAt != null &&
        new Date(t.completedAt).getTime() >= since
      );
      if (match?.onChain?.txId) {
        return { hash: match.onChain.txId, explorerLink: match.onChain.explorerLink };
      }
    } catch {
      // transfers list not ready yet; keep polling
    }
    await delay(SETTLE_RETRY.delayMs);
  }
  return null;
};

/**
 * Step 1 - the treasury (source) wallet: owner "COMPANY", server signer, fixed alias.
 * Idempotent on the alias, so it resolves to the same address (locator `COMPANY:<alias>`)
 * on every run - fund it once, then re-run freely.
 * Docs: https://docs.crossmint.com/wallets/guides/treasury-wallets
 */
const ensureTreasuryWallet = async (wallets: Wallets): Promise<Wallet<Chain>> => {
  const s = ui.step(1, TOTAL, "Treasury wallet");
  try {
    const wallet = await wallets.createWallet({
      chain: CHAIN as Chain,
      owner: "COMPANY",
      alias: TREASURY_ALIAS,
      recovery: serverSigner,
    });
    s.ok(`${wallet.address}  (${TREASURY_LOCATOR})`);
    return wallet;
  } catch (error) {
    s.fail();
    throw error;
  }
};

/**
 * Step 2 - register the recipient as a user via the REST users API: submit their
 * `userDetails` (name, date of birth, country of residence), the MINIMAL_PERSONAL_DATA tier.
 * One idempotent PUT. The regulated transfer in step 4 triggers the KYC + sanctions screen
 * automatically, so no separate verification call is needed.
 *
 * RECIPIENT_COUNTRY must be a SUPPORTED country of residence (e.g. US -> Crossmint
 * Horizon, or a supported European country -> Crossmint Europe). An unsupported country
 * (e.g. CA) is rejected, surfacing as the misleading "Recipient user is sanctioned and
 * can't receive assets".
 * Docs: https://docs.crossmint.com/stablecoin-orchestration/regulated-transfers/quickstart
 */
const setupRecipientUser = async (): Promise<void> => {
  const s = ui.step(2, TOTAL, "Recipient user (KYC)");
  try {
    const loc = encodeURIComponent(RECIPIENT);
    await apiJson(`/users/${loc}`, {
      method: "PUT",
      body: JSON.stringify(buildUserDetails(config.RECIPIENT_COUNTRY)),
    });
    s.ok(kycLegalEntity(config.RECIPIENT_COUNTRY).label);
  } catch (error) {
    s.fail();
    throw error;
  }
};

/**
 * Step 3 - a wallet owned by the recipient user. Idempotent by owner.
 * Docs: https://docs.crossmint.com/wallets/quickstarts/nodejs
 */
const ensureRecipientWallet = async (wallets: Wallets): Promise<string> => {
  const s = ui.step(3, TOTAL, "Recipient wallet");
  try {
    const wallet = await wallets.createWallet({
      chain: CHAIN as Chain,
      owner: RECIPIENT,
      recovery: serverSigner,
    });
    s.ok(wallet.address);
    return wallet.address;
  } catch (error) {
    s.fail();
    throw error;
  }
};

/**
 * Step 4 - the regulated transfer. The transfer targets the recipient's wallet
 * ADDRESS (from step 3), not the email locator: `wallet.send` resolves an on-chain
 * recipient, so it needs the concrete address. The server signer signs via the SDK.
 * With `--dry-run` the transfer is prepared (built + validated) but not executed.
 * Docs: https://docs.crossmint.com/stablecoin-orchestration/regulated-transfers/guides/transfers
 */
const sendRegulatedTransfer = async (
  treasury: Wallet<Chain>,
  recipientAddress: string,
): Promise<SendResult> => {
  const s = ui.step(4, TOTAL, dryRun ? "Regulated transfer (dry run)" : "Regulated transfer");
  const since = Date.now() - 30_000; // tolerate minor clock skew when matching the settled transfer
  try {
    await treasury.useSigner(serverSigner);
    for (let attempt = 1;; attempt++) {
      try {
        const tx = await treasury.send(recipientAddress, TOKEN, AMOUNT, {
          prepareOnly: dryRun,
          transactionType: "regulated-transfer",
        }) as SendResult;
        if (dryRun) {
          s.skip(`prepared, not executed${tx.transactionId ? ` (${tx.transactionId})` : ""}`);
        } else s.ok(tx.hash ?? tx.transactionId);
        return tx;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isKycPending(message) && attempt < KYC_RETRY.attempts) {
          s.update(`recipient KYC processing, retrying ${attempt}/${KYC_RETRY.attempts}`);
          await delay(KYC_RETRY.delayMs);
          continue;
        }
        // The SDK stops waiting for confirmation before the bundler settles the userOp.
        // The transfer usually lands anyway, so confirm it through wallet.transfers.
        if (!dryRun && isConfirmationTimeout(message)) {
          s.update("submitted, confirming settlement via wallet.transfers");
          const settled = await confirmSettlement(treasury, since);
          if (settled) {
            s.ok(settled.hash);
            return settled;
          }
        }
        throw error;
      }
    }
  } catch (error) {
    s.fail();
    throw error;
  }
};

/** Maps a known API error to a plain-language explanation + docs link. */
const explain = (message: string): string => {
  if (/Invalid API key|validate signature/i.test(message)) {
    return [
      "The CROSSMINT_API_KEY is invalid (it failed local signature validation).",
      "Use a server-side key for the project under test - see .env.example.",
      "Docs: https://docs.crossmint.com/introduction/platform/api-keys/overview",
    ].join("\n  ");
  }
  if (/Treasury Wallets are not enabled/i.test(message)) {
    return [
      "Treasury wallets are not enabled for this project.",
      "Staging is self-serve; for production, contact Crossmint.",
      "Docs: https://docs.crossmint.com/wallets/guides/treasury-wallets",
    ].join("\n  ");
  }
  if (isKycPending(message)) {
    return [
      "The recipient's KYC is still processing (this is transient).",
      "Wait a minute and re-run - the recipient is reused, so it will go through.",
    ].join("\n  ");
  }
  if (/regulated transfers KYC|not configured to support/i.test(message)) {
    return [
      "This project is not set up for payouts. Staging is self-serve; for production, contact Crossmint.",
      "This is also what blocks a project whose KYC entity does not match the recipient's jurisdiction.",
      "Docs: https://docs.crossmint.com/stablecoin-orchestration/regulated-transfers/quickstart",
    ].join("\n  ");
  }
  if (/insufficient|balance/i.test(message)) {
    return `The treasury wallet has insufficient ${TOKEN_LOCATOR}. Fund it, then re-run.`;
  }
  return message;
};

const main = async (): Promise<void> => {
  ui.quietSdkLogs(!debug); // drop the SDK's [SDK]-prefixed console noise unless --debug
  const entity = kycLegalEntity(config.RECIPIENT_COUNTRY);

  ui.heading(
    "Crossmint regulated transfers - end-to-end test",
    "Treasury (COMPANY) wallet -> KYC-verified recipient, signed with a server signer.",
  );

  ui.section("Configuration");
  ui.kv("environment", ENV);
  ui.kv("chain", CHAIN);
  ui.kv("token", TOKEN_LOCATOR);
  ui.kv("amount", AMOUNT);
  ui.kv("recipient", `${RECIPIENT}  (${config.RECIPIENT_COUNTRY} -> ${entity.label})`);
  ui.kv("treasury", `${TREASURY_LOCATOR}  (created or reused, idempotent by alias)`);
  ui.kv("signer", "server (address derived locally from the secret)");
  ui.kv(
    "mode",
    dryRun ? "dry run (prepare the transfer, do not execute)" : "live (execute the transfer)",
  );

  ui.section("Plan");
  ui.planItem(1, "Treasury wallet", "create or reuse a COMPANY-owned source wallet");
  ui.planItem(2, "Recipient user", "register + KYC via the REST users API");
  ui.planItem(3, "Recipient wallet", "create or reuse a wallet owned by that user");
  ui.planItem(4, "Transfer", `send ${AMOUNT} ${TOKEN_LOCATOR} as a regulated-transfer`);

  ui.section("Running");
  try {
    const wallets = CrossmintWallets.from(createCrossmint({ apiKey: config.CROSSMINT_API_KEY }));
    const treasury = await ensureTreasuryWallet(wallets);
    await setupRecipientUser();
    const recipientWallet = await ensureRecipientWallet(wallets);
    const tx = await sendRegulatedTransfer(treasury, recipientWallet);

    ui.section("Result");
    ui.kv("status", dryRun ? "prepared (dry run)" : "completed");
    ui.kv("treasury", treasury.address);
    ui.kv("recipient", recipientWallet);
    if (tx.transactionId) ui.kv("transaction", tx.transactionId);
    if (tx.hash) ui.kv("hash", tx.hash);
    if (tx.explorerLink) ui.kv("explorer", tx.explorerLink);
    ui.note(
      `treasury is reused across runs (locator ${TREASURY_LOCATOR}) - fund this address once with test ${TOKEN.toUpperCase()} for a live transfer`,
    );
    ui.done(
      dryRun
        ? "Dry run complete - the transfer was prepared but not executed."
        : "Regulated transfer complete.",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ui.section("Result");
    ui.kv("status", "blocked");
    ui.failed(`Blocked / failed:\n  ${explain(message)}`);
    Deno.exit(1);
  }
};

main();
