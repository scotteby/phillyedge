/**
 * Kalshi RSA-PSS request signing helper (server-only).
 *
 * Env vars required:
 *   KALSHI_API_KEY_ID   — UUID from Kalshi settings → API keys
 *   KALSHI_PRIVATE_KEY  — PEM-encoded RSA private key
 *
 * Key format notes:
 *   • Supports PKCS#1 (-----BEGIN RSA PRIVATE KEY-----) and
 *     PKCS#8 (-----BEGIN PRIVATE KEY-----)
 *   • Handles .env.local quirks: escaped \n, stripped line-breaks,
 *     Windows CRLF endings
 */

import { createPrivateKey, sign, constants, type KeyObject } from "crypto";

// ── PEM normalisation ─────────────────────────────────────────────────────────

function normalisePem(raw: string): string {
  // 1. Convert literal \n (from some env editors) to real newlines
  let pem = raw.replace(/\\n/g, "\n").replace(/\\r/g, "").replace(/\r\n/g, "\n").trim();

  // 2. If the entire key ended up on one line (no newlines in the body),
  //    reformat it with standard 64-character base-64 lines.
  const oneLineMatch = pem.match(
    /^(-----BEGIN (?:RSA )?PRIVATE KEY-----)([\s\S]+?)(-----END (?:RSA )?PRIVATE KEY-----)$/
  );
  if (oneLineMatch) {
    const header = oneLineMatch[1];
    const body   = oneLineMatch[2].replace(/\s+/g, ""); // strip all whitespace
    const footer = oneLineMatch[3];
    if (!body.includes("\n")) {
      // Reformat body into 64-char lines
      const lines = (body.match(/.{1,64}/g) ?? []).join("\n");
      pem = `${header}\n${lines}\n${footer}`;
    }
  }

  return pem;
}

// ── Key loading (cached per process) ─────────────────────────────────────────

let _cachedKey: KeyObject | null = null;

function loadPrivateKey(): KeyObject {
  if (_cachedKey) return _cachedKey;

  const raw = process.env.KALSHI_PRIVATE_KEY ?? "";
  if (!raw) throw new Error("KALSHI_PRIVATE_KEY is not set in environment");

  const pem = normalisePem(raw);

  try {
    _cachedKey = createPrivateKey({ key: pem, format: "pem" });
    return _cachedKey;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Cannot parse KALSHI_PRIVATE_KEY: ${msg}. ` +
      "Ensure it is a valid PEM-encoded RSA private key " +
      "(PKCS#1 or PKCS#8) with correct line breaks."
    );
  }
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
  if (!accessKey) throw new Error("KALSHI_API_KEY_ID is not set in environment");

  const privateKey = loadPrivateKey(); // throws with a clear message on failure

  const timestamp = String(Date.now());
  const message   = timestamp + method.toUpperCase() + path;

  const signature = sign(
    "SHA256",
    Buffer.from(message),
    {
      key:        privateKey,
      padding:    constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32, // SHA-256 digest length — equivalent to RSA_PSS_SALTLEN_DIGEST
    }
  ).toString("base64");

  return {
    "Content-Type":             "application/json",
    "KALSHI-ACCESS-KEY":        accessKey,
    "KALSHI-ACCESS-SIGNATURE":  signature,
    "KALSHI-ACCESS-TIMESTAMP":  timestamp,
  };
}
