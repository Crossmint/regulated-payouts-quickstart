/**
 * Inspect wallet state through the SDK - balances + transfer/transaction history,
 * the SDK-native way to read a wallet (no raw RPC, no curl). Idempotent: resolves
 * the same treasury (COMPANY:<alias>) and recipient wallets the transfer uses.
 *
 *   deno task inspect
 */
import { type Chain, createCrossmint, CrossmintWallets } from "@crossmint/wallets-sdk";
import {
  CHAIN,
  config,
  RECIPIENT_EMAIL,
  serverSigner,
  TOKEN,
  TREASURY_ALIAS,
  TREASURY_LOCATOR,
} from "../main.ts";
import * as ui from "../ui.ts";

ui.quietSdkLogs(true);

const main = async (): Promise<void> => {
  const wallets = CrossmintWallets.from(createCrossmint({ apiKey: config.CROSSMINT_API_KEY }));

  let treasury;
  try {
    treasury = await wallets.createWallet({
      chain: CHAIN as Chain,
      owner: "COMPANY",
      alias: TREASURY_ALIAS,
      recovery: serverSigner,
    });
  } catch (error) {
    console.error(
      `Failed to resolve treasury wallet (${TREASURY_LOCATOR}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    Deno.exit(1);
  }

  let recipient;
  try {
    recipient = await wallets.createWallet({
      chain: CHAIN as Chain,
      owner: `email:${RECIPIENT_EMAIL}`,
      recovery: { type: "email", email: RECIPIENT_EMAIL },
    });
  } catch (error) {
    console.error(
      `Failed to resolve recipient wallet (email:${RECIPIENT_EMAIL}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    Deno.exit(1);
  }

  console.log("=== balances (wallet.balances) ===");
  console.log("treasury ", treasury.address, JSON.stringify(await treasury.balances([TOKEN])));
  console.log("recipient", recipient.address, JSON.stringify(await recipient.balances([TOKEN])));

  console.log("\n=== treasury transfers (wallet.transfers) ===");
  for (const status of ["successful", "failed"] as const) {
    try {
      console.log(
        `${status}:`,
        JSON.stringify(await treasury.transfers({ tokens: TOKEN, status })),
      );
    } catch (e) {
      console.log(`${status}: error -`, e instanceof Error ? e.message : String(e));
    }
  }

  console.log("\n=== treasury transactions (wallet.transactions, latest 3) ===");
  const txs = await treasury.transactions();
  const list = (txs as unknown as {
    transactions?: Array<{ id?: string; status?: string; onChain?: { txId?: string } }>;
  })
    .transactions ?? [];
  console.log(`count: ${list.length}`);
  for (const t of list.slice(0, 3)) {
    console.log(`  id=${t.id} status=${t.status} txId=${t.onChain?.txId ?? "-"}`);
  }
};

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nError: ${message}`);
  Deno.exit(1);
});
