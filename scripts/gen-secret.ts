/**
 * Generates a Crossmint server-signer secret: `xmsk1_<64 hex chars>`.
 *
 * Run once, then store the result as CROSSMINT_SIGNER_SECRET in .env. The secret
 * is deterministic for the wallet: the same secret always derives the same wallet.
 *
 * Usage: deno task gen-secret
 */
const bytes = new Uint8Array(32);
crypto.getRandomValues(bytes);
const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
console.log(`xmsk1_${hex}`);
