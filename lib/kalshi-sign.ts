/**
 * Kalshi RSA-PSS request signing helper (server-only).
 *
 * Env vars required:
 *   KALSHI_API_KEY_ID   — UUID from Kalshi settings → API keys
 *   KALSHI_PRIVATE_KEY  — PEM-encoded RSA private key
 *
 * Supports PKCS#1 (-----BEGIN RSA PRIVATE KEY-----) and
 * PKCS#8 (-----BEGIN PRIVATE KEY-----), with or without
 * escaped \n sequences in the env value.
 */

import { createSign, constants } from "crypto";

// ── PEM normalisation ─────────────────────────────────────────────────────────

function normalisePem(raw: string): string {
  let pem = raw
    // 1. Strip surrounding quote characters — dotenv sometimes leaves them
    //    in the value when the key is stored as a single line with quotes.
    .replace(/^["']+|["']+$/g, "")
    // 2. Convert literal \n / \r sequences written by some env editors
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    // 3. Normalise Windows line endings
    .replace(/\r\n/g, "\n")
    .trim();

  // 4. Extract header, raw body, footer — then canonically reformat the
  //    body into 64-char base-64 lines.  This fixes:
  //      • Stripped newlines (body is one long line)
  //      • Spaces used instead of newlines (single-line env value)
  //      • Any other whitespace corruption
  const m = pem.match(/^(-----BEGIN [^-]+-----)([\s\S]+?)(-----END [^-]+-----)$/);
  if (m) {
    const header = m[1];
    const body   = m[2].replace(/\s+/g, ""); // strip every whitespace char
    const footer = m[3];
    const lines  = (body.match(/.{1,64}/g) ?? []).join("\n");
    pem = `${header}\n${lines}\n${footer}`;
  }

  return pem;
}

// ── Header builder ────────────────────────────────────────────────────────────

/**
 * Build the three Kalshi auth headers for a given HTTP method + path.
 * Timestamp is milliseconds-since-epoch as a string (Kalshi v2 format).
 */
export function buildKalshiAuthHeaders(
  method: string,
  path: string
): Record<string, string> {
  const demo = process.env.KALSHI_DEMO_MODE === "true";

  const accessKey = demo
    ? (process.env.KALSHI_DEMO_API_KEY_ID ?? "")
    : (process.env.KALSHI_API_KEY_ID       ?? "");
  const rawKey = demo
    ? (process.env.KALSHI_DEMO_PRIVATE_KEY ?? "")
    : (process.env.KALSHI_PRIVATE_KEY      ?? "");

  if (!accessKey) throw new Error(
    demo ? "KALSHI_DEMO_API_KEY_ID is not set in environment"
         : "KALSHI_API_KEY_ID is not set in environment"
  );
  if (!rawKey) throw new Error(
    demo ? "KALSHI_DEMO_PRIVATE_KEY is not set in environment"
         : "KALSHI_PRIVATE_KEY is not set in environment"
  );

  const pem = normalisePem(rawKey);

  // Log non-sensitive structural diagnostics (no key material)
  console.log(
    `[kalshi-sign] key: ${pem.split("\n").length} lines, ${pem.length} chars`
  );

  const timestamp = String(Date.now());
  const message   = timestamp + method.toUpperCase() + path;

  let signature: string;
  try {
    const signer = createSign("SHA256");
    signer.update(message);
    signer.end();
    signature = signer.sign(
      {
        key:        pem,
        padding:    constants.RSA_PKCS1_PSS_PADDING,
        saltLength: 32, // SHA-256 digest length; equivalent to RSA_PSS_SALTLEN_DIGEST
      },
      "base64"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `RSA-PSS signing failed (key ${pem.length} chars, ` +
      `${pem.split("\n").length} lines): ${msg}`
    );
  }

  return {
    "Content-Type":             "application/json",
    "KALSHI-ACCESS-KEY":        accessKey,
    "KALSHI-ACCESS-SIGNATURE":  signature,
    "KALSHI-ACCESS-TIMESTAMP":  timestamp,
  };
}
