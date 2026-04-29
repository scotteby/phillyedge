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
  // 1. Convert escaped newlines (e.g. stored as literal \n in some env editors)
  let pem = raw
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    .replace(/\r\n/g, "\n")
    .trim();

  // 2. Extract header, body, footer and reformat body into 64-char lines.
  //    This handles the case where line-breaks were stripped from the body.
  const m = pem.match(
    /^(-----BEGIN [^-]+-----)([\s\S]+?)(-----END [^-]+-----)$/
  );
  if (m) {
    const header = m[1];
    const body   = m[2].replace(/\s+/g, ""); // strip all whitespace from body
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
  const accessKey = process.env.KALSHI_API_KEY_ID ?? "";
  const rawKey    = process.env.KALSHI_PRIVATE_KEY ?? "";

  if (!accessKey) throw new Error("KALSHI_API_KEY_ID is not set in environment");
  if (!rawKey)    throw new Error("KALSHI_PRIVATE_KEY is not set in environment");

  const pem = normalisePem(rawKey);

  // Log non-sensitive diagnostics so failures are visible in server logs
  console.log(
    `[kalshi-sign] key: ${pem.split("\n").length} lines, ` +
    `${pem.length} chars, ` +
    `starts: "${pem.split("\n")[0]}"`
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
      `${pem.split("\n").length} lines, ` +
      `header: "${pem.split("\n")[0]}"): ${msg}`
    );
  }

  return {
    "Content-Type":             "application/json",
    "KALSHI-ACCESS-KEY":        accessKey,
    "KALSHI-ACCESS-SIGNATURE":  signature,
    "KALSHI-ACCESS-TIMESTAMP":  timestamp,
  };
}
