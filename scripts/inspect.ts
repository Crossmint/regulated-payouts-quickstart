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
    treasury = await wallets.getWallet(`COMPANY:${TREASURY_ALIAS}`, {
      chain: CHAIN as Chain,
    });
  } catch {
    console.error(
      `Treasury wallet not found (${TREASURY_LOCATOR}). Run \`deno task transfer:dry\` first to create it.`,
    );
    Deno.exit(1);
  }

  let recipient;
  try {
    recipient = await wallets.getWallet(`email:${RECIPIENT_EMAIL}`, {
      chain: CHAIN as Chain,
    });
  } catch {
    console.error(
      `Recipient wallet not found (email:${RECIPIENT_EMAIL}). Run \`deno task transfer:dry\` first to create it.`,
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
