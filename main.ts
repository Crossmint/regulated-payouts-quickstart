/**
 * Configuration, the Crossmint server signer, and a REST helper.
 *
 * Environment variables are loaded by `@std/dotenv` (from `.env`) and read once
 * here - the scripts never touch `Deno.env` directly.
 *
 * Env-agnostic: ENV selects staging vs production. Chain-agnostic: CHAIN.
 */
import "@std/dotenv/load";

/** Reads a required env var, or exits with a clear message. */
const required = (name: string): string => {
  const value = Deno.env.get(name);
  if (!value) {
    console.error(`Missing required env var: ${name} (see .env.example)`);
    Deno.exit(1);
  }
  return value;
};

/** Reads an optional env var with a fallback. */
const optional = (name: string, fallback: string): string => Deno.env.get(name) ?? fallback;

/** "staging" (default) or "production". */
export const ENV: string = optional("ENV", "staging");
const isStaging = ENV !== "production";

/** Chain string. Default `polygon-amoy` (an EVM testnet that supports regulated transfers). */
export const CHAIN: string = optional("CHAIN", "polygon-amoy");
/**
 * Token to transfer: a currency symbol ("usdc") or a contract address. This is what
 * `wallet.send` expects - the chain is taken from the wallet, so it is NOT prefixed.
 */
export const TOKEN: string = optional("TOKEN", "usdc");
/** Human-readable `<chain>:<token>`, e.g. "polygon-amoy:usdc". For display only. */
export const TOKEN_LOCATOR: string = `${CHAIN}:${TOKEN}`;

/**
 * Stable alias for the treasury wallet. `createWallet` is idempotent on alias, so the
 * same alias always resolves to the same treasury address across runs - fund it once,
 * then re-run freely. (Owner "COMPANY" alone is not deduplicated; the alias is the key.)
 */
export const TREASURY_ALIAS: string = optional("TREASURY_ALIAS", "payouts-treasury");
/** The treasury's Crossmint locator: `COMPANY:<alias>`. Reused across runs - no extra env var. */
export const TREASURY_LOCATOR: string = `COMPANY:${TREASURY_ALIAS}`;

/** Recipient locator: "email:..." or "userId:...". */
export const RECIPIENT: string = optional(
  "RECIPIENT",
  "email:regulated-transfer-recipient@example.com",
);
/**
 * The recipient's email for the KYC payload. Taken from the RECIPIENT locator when it
 * is an `email:...` locator; otherwise from RECIPIENT_EMAIL (needed when RECIPIENT is a
 * `userId:...` locator, since the KYC payload still requires an email).
 */
export const RECIPIENT_EMAIL: string = RECIPIENT.startsWith("email:")
  ? RECIPIENT.slice("email:".length)
  : optional("RECIPIENT_EMAIL", "regulated-transfer-recipient@example.com");
/** Transfer amount (decimal string). Default a small fraction so a funded treasury covers many runs. */
export const AMOUNT: string = optional("AMOUNT", "0.1");

/**
 * The Crossmint legal entity that handles KYC for a given country of residence.
 *
 * Crossmint routes regulated-transfer KYC by jurisdiction: US residents go to the
 * US entity, everyone else to the EU entity. A project can only complete the flow
 * for the entity its KYC config supports - which is exactly what the EU-vs-US test
 * below exercises. Values match the Crossmint backend.
 */
export const kycLegalEntity = (countryCode: string): { id: string; label: string } =>
  countryCode.toUpperCase() === "US"
    ? { id: "crossmint-horizon", label: "Crossmint Horizon (US)" }
    : { id: "crossmint-europe", label: "Crossmint Europe (EU / rest of world)" };

/** Everything else, read once. */
export const config = {
  /** Server-side API key. Docs: https://docs.crossmint.com/introduction/platform/api-keys/overview */
  CROSSMINT_API_KEY: required("CROSSMINT_API_KEY"),
  /** Server-signer secret (xmsk1_...). Generate with `deno task gen-secret`. */
  SIGNER_SECRET: required("CROSSMINT_SIGNER_SECRET"),
  RECIPIENT_FIRST_NAME: optional("RECIPIENT_FIRST_NAME", "Regulated"),
  RECIPIENT_LAST_NAME: optional("RECIPIENT_LAST_NAME", "Recipient"),
  RECIPIENT_DOB: optional("RECIPIENT_DOB", "2000-01-01"),
  /**
   * ISO 3166-1 alpha-2 country. Drives the KYC legal entity (see `kycLegalEntity`).
   * Must be a SUPPORTED country (e.g. US, or a supported European country). Unsupported
   * countries like CA are rejected at transfer time.
   */
  RECIPIENT_COUNTRY: optional("RECIPIENT_COUNTRY", "US"),
  /** Versioned REST root, env-aware. */
  apiRoot: `${
    isStaging ? "https://staging.crossmint.com" : "https://www.crossmint.com"
  }/api/2025-06-09`,
} as const;

/**
 * Server-signer config: the SDK derives the wallet address from the secret and
 * signs locally (only the address is sent to Crossmint). Same secret -> same wallet.
 * Docs: https://docs.crossmint.com/wallets/guides/signers/server-signer
 */
export const serverSigner = { type: "server" as const, secret: config.SIGNER_SECRET };

/**
 * The KYC payload the client provides for a recipient: userDetails +
 * kycData + dueDiligence + verificationHistory. The regulated transfer screens this
 * data; for a supported country of residence a clean recipient clears it. The field
 * shape is country-aware - see `buildPreVerifiedKyc`.
 * Docs: https://docs.crossmint.com/stablecoin-orchestration/regulated-transfers/quickstart
 */
export type PreVerifiedKyc = {
  userDetails: {
    firstName: string;
    lastName: string;
    dateOfBirth: string;
    countryOfResidence: string;
  };
  kycData: {
    nationality: string;
    addressOfResidence: {
      line1: string;
      city: string;
      stateOrRegion: string;
      postalCode: string;
    };
    email: string;
    phoneNumber: string;
    identityDocument: { type: string; number: string; issuingCountryCode: string };
  };
  dueDiligence: {
    employmentStatus: string;
    sourceOfFunds: string;
    industry: string;
    estimatedYearlyIncome?: string;
  };
  verificationHistory: {
    idVerificationTimestamp: string;
    livenessVerificationTimestamp: string;
  };
};

/** An ISO 8601 timestamp `minutes` in the past. Verification events must be recent - the
 * backend rejects timestamps older than one year. */
const isoMinutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

/**
 * Builds the KYC payload for the recipient's country of residence. The
 * required fields are country-aware:
 * - US residents: an SSN identity document (XXX-XX-XXXX, issued by US), a phone number,
 *   and an estimatedYearlyIncome bracket in dueDiligence (all required for US).
 * - Everyone else (EU / EEA / rest of world): a passport, and NO estimatedYearlyIncome
 *   (the API rejects that field for non-US residents).
 */
export const buildPreVerifiedKyc = (countryCode: string): PreVerifiedKyc => {
  const country = countryCode.toUpperCase();
  const isUS = country === "US";

  const userDetails = {
    firstName: config.RECIPIENT_FIRST_NAME,
    lastName: config.RECIPIENT_LAST_NAME,
    dateOfBirth: config.RECIPIENT_DOB,
    countryOfResidence: country,
  };

  const kycData = {
    nationality: country,
    addressOfResidence: isUS
      ? {
        line1: "123 Market Street",
        city: "San Francisco",
        stateOrRegion: "CA",
        postalCode: "94105",
      }
      : {
        line1: "123 King Street West",
        city: "Toronto",
        stateOrRegion: "ON",
        postalCode: "M5H 1A1",
      },
    email: RECIPIENT_EMAIL,
    phoneNumber: "+14155550123",
    identityDocument: isUS
      ? { type: "ssn", number: "123-45-6789", issuingCountryCode: "US" }
      : { type: "passport", number: "X1234567", issuingCountryCode: country },
  };

  const dueDiligence = isUS
    ? {
      employmentStatus: "full-time",
      sourceOfFunds: "salary-disbursement",
      industry: "information",
      estimatedYearlyIncome: "income-50k-100k",
    }
    : {
      employmentStatus: "full-time",
      sourceOfFunds: "salary-disbursement",
      industry: "information",
    };

  const verificationHistory = {
    idVerificationTimestamp: isoMinutesAgo(15),
    livenessVerificationTimestamp: isoMinutesAgo(10),
  };

  return { userDetails, kycData, dueDiligence, verificationHistory };
};

/**
 * Minimal Crossmint REST helper (used for the recipient-user REST setup).
 * Docs: https://docs.crossmint.com/wallets/quickstarts/restapi
 */
export const apiJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const res = await fetch(`${config.apiRoot}${path}`, {
    ...init,
    headers: {
      "x-api-key": config.CROSSMINT_API_KEY,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${JSON.stringify(body)}`);
  }
  return body as T;
};
