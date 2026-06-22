/**
 * Self-documenting POC.
 *
 * Runs the regulated-transfer flow live and writes a markdown reference built from
 * the REAL requests, responses, addresses, and outcomes of that run. The doc is a
 * byproduct of execution, so it can never drift from how the API actually behaves.
 * Re-run `deno task docs` to refresh it (for example, after a gate clears).
 *
 * How it captures the HTTP: it wraps `globalThis.fetch` before the SDK initializes,
 * so even the calls the SDK makes under the hood (createWallet -> POST /wallets,
 * send -> POST /transactions) are recorded with their real bodies.
 *
 * Safety: addresses, hashes, transaction ids, and uuids are never truncated. The
 * API key is never recorded (it lives in a header we do not capture), and any
 * server-signer secret is redacted from request bodies.
 *
 * For agents: run `deno task docs`, then surface the path it prints. The generated
 * file under docs/ is the deliverable.
 */
import { type Chain, createCrossmint, CrossmintWallets, type Wallet } from "@crossmint/wallets-sdk";
import { delay } from "@std/async/delay";
import {
  AMOUNT,
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
import { quietSdkLogs } from "../ui.ts";

// ----------------------------------------------------------------------------
// HTTP recorder - wrap fetch before anything makes a request.
// ----------------------------------------------------------------------------
type Http = {
  method: string;
  url: string;
  requestBody: unknown;
  status: number;
  responseBody: unknown;
};
const httpLog: Http[] = [];

/** Redact server-signer secrets if one ever appears in a captured body. */
const redact = (value: unknown): unknown => {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value).replace(/xmsk1_[0-9a-fA-F]{64}/g, "xmsk1_<redacted>"));
  } catch {
    return value;
  }
};

const parseMaybeJson = (body: unknown): unknown => {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
};

const originalFetch = globalThis.fetch;
globalThis.fetch =
  (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const response = await originalFetch(input, init);
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      // Skip the SDK's own telemetry/log shipping - it is not part of the API surface.
      if (/telemetry\.|datadoghq|ddforward/i.test(url)) return response;
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET"))
        .toUpperCase();
      const text = await response.clone().text();
      let responseBody: unknown;
      try {
        responseBody = JSON.parse(text);
      } catch {
        responseBody = text;
      }
      httpLog.push({
        method,
        url,
        requestBody: parseMaybeJson(init?.body),
        status: response.status,
        responseBody,
      });
    } catch {
      // Never let the recorder break the real request.
    }
    return response;
  }) as typeof fetch;

const mark = (): number => httpLog.length;
const since = (from: number): Http[] => httpLog.slice(from);

// ----------------------------------------------------------------------------
// Run the flow, capturing a record per step.
// ----------------------------------------------------------------------------
type Step = {
  n: number;
  title: string;
  what: string;
  docs: string;
  sdk?: string;
  http: Http[];
  outputs: Record<string, string>;
  status: "ok" | "blocked";
  error?: string;
};

const errMessage = (
  error: unknown,
): string => (error instanceof Error ? error.message : String(error));
const isKycPending = (message: string): boolean =>
  /KYC is in progress|retry in a few seconds/i.test(message);
const KYC_RETRY = { attempts: 12, delayMs: 5_000 };

const wallets = CrossmintWallets.from(createCrossmint({ apiKey: config.CROSSMINT_API_KEY }));

const run = async (): Promise<Step[]> => {
  const steps: Step[] = [];
  const entity = kycLegalEntity(config.RECIPIENT_COUNTRY);

  // Step 1 - treasury wallet
  let treasury: Wallet<Chain> | null = null;
  {
    const at = mark();
    const step: Step = {
      n: 1,
      title: "Treasury wallet",
      what:
        "Create (or reuse) the COMPANY-owned source wallet. A fixed alias makes createWallet idempotent, so the same address comes back on every run.",
      docs: "https://docs.crossmint.com/wallets/guides/treasury-wallets",
      sdk:
        `const treasury = await wallets.createWallet({\n  chain: "${CHAIN}",\n  owner: "COMPANY",\n  alias: "${TREASURY_ALIAS}",\n  recovery: serverSigner,\n});`,
      http: [],
      outputs: {},
      status: "ok",
    };
    try {
      treasury = await wallets.createWallet({
        chain: CHAIN as Chain,
        owner: "COMPANY",
        alias: TREASURY_ALIAS,
        recovery: serverSigner,
      });
      step.outputs = { address: treasury.address, locator: TREASURY_LOCATOR };
    } catch (error) {
      step.status = "blocked";
      step.error = errMessage(error);
    }
    step.http = since(at);
    steps.push(step);
  }

  // Step 2 - recipient user via the REST users API (raw REST)
  {
    const at = mark();
    const locator = encodeURIComponent(RECIPIENT);
    const step: Step = {
      n: 2,
      title: "Recipient user (REST users API)",
      what:
        "Register the recipient as a user via the REST users API: submit their userDetails (name, date of birth, country of residence), the MINIMAL_PERSONAL_DATA tier. The regulated transfer triggers the KYC + sanctions screen automatically; a supported country of residence is required. No SDK method covers this, so it is one REST PUT.",
      docs: "https://docs.crossmint.com/stablecoin-orchestration/regulated-transfers/quickstart",
      http: [],
      outputs: {
        recipient: RECIPIENT,
        legalEntity: `${entity.id} (from country ${config.RECIPIENT_COUNTRY})`,
      },
      status: "ok",
    };
    const put = (path: string, body: unknown) =>
      fetch(`${config.apiRoot}${path}`, {
        method: "PUT",
        headers: { "x-api-key": config.CROSSMINT_API_KEY, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      const r = await put(`/users/${locator}`, buildUserDetails(config.RECIPIENT_COUNTRY));
      if (!r.ok) {
        step.status = "blocked";
        step.error = `users PUT returned ${r.status}`;
      }
    } catch (error) {
      step.status = "blocked";
      step.error = errMessage(error);
    }
    step.http = since(at);
    steps.push(step);
  }

  // Step 3 - recipient wallet
  let recipientAddress: string | null = null;
  {
    const at = mark();
    const step: Step = {
      n: 3,
      title: "Recipient wallet",
      what:
        "Create (or reuse) a Crossmint-managed wallet owned by the recipient user. Idempotent by owner.",
      docs: "https://docs.crossmint.com/wallets/quickstarts/nodejs",
      sdk:
        `const recipient = await wallets.createWallet({\n  chain: "${CHAIN}",\n  owner: "${RECIPIENT}",\n  recovery: serverSigner,\n});`,
      http: [],
      outputs: {},
      status: "ok",
    };
    try {
      const wallet = await wallets.createWallet({
        chain: CHAIN as Chain,
        owner: RECIPIENT,
        recovery: serverSigner,
      });
      recipientAddress = wallet.address;
      step.outputs = { address: wallet.address, owner: RECIPIENT };
    } catch (error) {
      step.status = "blocked";
      step.error = errMessage(error);
    }
    step.http = since(at);
    steps.push(step);
  }

  // Step 4 - the regulated transfer (dry run: prepared, not executed)
  {
    const at = mark();
    const step: Step = {
      n: 4,
      title: "Regulated transfer",
      what:
        "Send the token from the treasury to the recipient's wallet address as a regulated-transfer. The server signer signs via the SDK. This run uses prepareOnly, so it is built and validated but not executed.",
      docs:
        "https://docs.crossmint.com/stablecoin-orchestration/regulated-transfers/guides/transfers",
      sdk:
        `await treasury.useSigner(serverSigner);\nconst tx = await treasury.send(\n  recipientAddress, // the 0x... address from step 3, not the email locator\n  "${TOKEN}",       // a currency symbol; the chain comes from the wallet\n  "${AMOUNT}",\n  { prepareOnly: true, transactionType: "regulated-transfer" },\n);`,
      http: [],
      outputs: {},
      status: "ok",
    };
    if (treasury && recipientAddress) {
      try {
        await treasury.useSigner(serverSigner);
        for (let attempt = 1;; attempt++) {
          try {
            const tx = await treasury.send(recipientAddress, TOKEN, AMOUNT, {
              prepareOnly: true,
              transactionType: "regulated-transfer",
            }) as { transactionId?: string; hash?: string; explorerLink?: string };
            step.outputs = {
              ...(tx.transactionId ? { transactionId: tx.transactionId } : {}),
              ...(tx.hash ? { hash: tx.hash } : {}),
              ...(tx.explorerLink ? { explorerLink: tx.explorerLink } : {}),
              mode: "prepareOnly (not executed)",
            };
            break;
          } catch (error) {
            const message = errMessage(error);
            if (isKycPending(message) && attempt < KYC_RETRY.attempts) {
              console.log(
                `  recipient KYC processing, retrying ${attempt}/${KYC_RETRY.attempts} ...`,
              );
              await delay(KYC_RETRY.delayMs);
              continue;
            }
            step.status = "blocked";
            step.error = message;
            break;
          }
        }
      } catch (error) {
        step.status = "blocked";
        step.error = errMessage(error);
      }
    } else {
      step.status = "blocked";
      step.error = "Skipped: a previous step did not complete.";
    }
    step.http = since(at);
    steps.push(step);
  }

  return steps;
};

// ----------------------------------------------------------------------------
// Markdown rendering.
// ----------------------------------------------------------------------------
const fence = (lang: string, body: string): string => "```" + lang + "\n" + body + "\n```";
const json = (value: unknown): string => fence("json", JSON.stringify(redact(value), null, 2));

const curl = (h: Http): string => {
  const lines = [
    `curl -X ${h.method} '${h.url}' \\`,
    `  -H 'x-api-key: <CROSSMINT_API_KEY>' \\`,
    `  -H 'content-type: application/json'`,
  ];
  if (h.requestBody !== undefined && h.requestBody !== null) {
    lines[lines.length - 1] += " \\";
    lines.push(`  -d '${JSON.stringify(redact(h.requestBody))}'`);
  }
  return fence("bash", lines.join("\n"));
};

const table = (headers: string[], rows: string[][]): string => {
  const head = `| ${headers.join(" | ")} |`;
  const sep = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return [head, sep, body].join("\n");
};

const statusLabel = (s: Step): string => (s.status === "ok" ? "ok" : "blocked");

const renderStep = (s: Step): string => {
  const parts: string[] = [`## Step ${s.n} - ${s.title}`, s.what];
  if (s.sdk) parts.push("**SDK call**", fence("ts", s.sdk));
  if (s.http.length > 0) {
    parts.push("**Under the hood (real HTTP from this run)**");
    for (const h of s.http) {
      parts.push(curl(h), `Response \`${h.status}\`:`, json(h.responseBody));
    }
  }
  if (Object.keys(s.outputs).length > 0) {
    parts.push(
      "**Result**",
      table(["field", "value"], Object.entries(s.outputs).map(([k, v]) => [k, `\`${v}\``])),
    );
  }
  if (s.error) parts.push("**Outcome: blocked**", fence("text", s.error));
  parts.push(`Docs: ${s.docs}`);
  return parts.join("\n\n");
};

const renderConsole = (steps: Step[]): string => {
  const lines = ["Running"];
  for (const s of steps) {
    const detail = s.outputs.address ?? s.outputs.legalEntity ?? s.outputs.transactionId ?? "";
    lines.push(`  [${s.n}/4] ${s.title} ...`);
    lines.push(`     ${statusLabel(s)}${detail ? `  ${detail}` : ""}`);
  }
  const last = steps[steps.length - 1];
  lines.push("", "Result", `  status        ${last.status === "ok" ? "completed" : "blocked"}`);
  if (last.error) lines.push(`  ${last.error}`);
  return fence("text", lines.join("\n"));
};

const GATES = [
  [
    "Treasury Wallets are not enabled",
    "Payouts are not enabled for this project",
    "Staging is self-serve; for production, contact Crossmint",
  ],
  [
    "User KYC is in progress",
    "The recipient's KYC is still processing",
    "Transient - retry (the CLI retries automatically)",
  ],
  [
    "Recipient user is sanctioned and can't receive assets",
    "The recipient has not cleared sanctions screening",
    "Clear the recipient's screening (staging approval is internal)",
  ],
  [
    "not configured to support regulated transfers KYC",
    "The project's region/legal entity is not set up",
    "Configure the project's regulated-transfers region (US vs EU)",
  ],
  [
    "insufficient / balance",
    "The treasury has no balance of the token",
    "Fund the treasury, then re-run",
  ],
];

const buildDoc = (steps: Step[], generatedAt: string): string => {
  const entity = kycLegalEntity(config.RECIPIENT_COUNTRY);
  const idTable: string[][] = [];
  for (const s of steps) {
    for (const [k, v] of Object.entries(s.outputs)) {
      if (/^0x|address|hash|transaction|locator|explorer/i.test(k) || /^0x/.test(v)) {
        idTable.push([`${s.title}: ${k}`, `\`${v}\``]);
      }
    }
  }

  return [
    "# Crossmint Regulated Transfers - End-to-End Reference",
    "> Auto-generated by `deno task docs` from a live staging run. Every address, hash, transaction id, and uuid below is real and untruncated. Re-run to refresh.",
    table(["", ""], [
      ["generated", `\`${generatedAt}\``],
      ["environment", `\`${ENV}\``],
      ["chain", `\`${CHAIN}\``],
      ["token", `\`${TOKEN_LOCATOR}\``],
      ["recipient", `\`${RECIPIENT}\` -> ${entity.label}`],
    ]),
    "Moves a stablecoin from a COMPANY treasury wallet to a KYC-verified recipient as a `regulated-transfer`, using the Crossmint wallets SDK and a server signer.",
    "## Flow",
    fence(
      "text",
      [
        "Step 1  Treasury wallet (COMPANY)    create or reuse",
        "Step 2  Recipient user               KYC via REST users API",
        "Step 3  Recipient wallet             create or reuse",
        "Step 4  Regulated transfer           treasury -> recipient",
      ].join("\n"),
    ),
    "## Prerequisites",
    "Staging is self-serve - create a project and a server-side API key in the Console. Production payouts are enabled by Crossmint.",
    ...steps.map(renderStep),
    "## Console output (this run)",
    renderConsole(steps),
    ...(idTable.length > 0
      ? ["## Addresses and ids (full, untruncated)", table(["what", "value"], idTable)]
      : []),
    "## Gates and errors (reference)",
    table(["message", "meaning", "fix"], GATES),
    "## Regenerate",
    "This file is produced by running the flow live:",
    fence("bash", "deno task docs"),
    "The HTTP shown above is captured by wrapping `fetch`, so it reflects exactly what the SDK and REST calls send and receive.",
  ].join("\n\n");
};

// ----------------------------------------------------------------------------
// Main.
// ----------------------------------------------------------------------------
const main = async (): Promise<void> => {
  quietSdkLogs(true); // keep the operator console clean; HTTP is captured via fetch, not logs
  console.log(`Running the flow live to generate docs (env=${ENV} chain=${CHAIN}) ...\n`);
  const steps = await run();
  const generatedAt = new Date().toISOString();
  const doc = buildDoc(steps, generatedAt);

  await Deno.mkdir("docs", { recursive: true });
  const path = "docs/REGULATED_TRANSFERS.md";
  await Deno.writeTextFile(path, doc + "\n");

  const okCount = steps.filter((s) => s.status === "ok").length;
  console.log(`\nWrote ${path}`);
  console.log(`Steps: ${okCount}/${steps.length} ok, ${httpLog.length} HTTP calls captured.`);
  const blocked = steps.find((s) => s.status === "blocked");
  if (blocked) console.log(`First block: step ${blocked.n} (${blocked.title}) - ${blocked.error}`);
};

main();
