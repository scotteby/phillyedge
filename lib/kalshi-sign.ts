/**
 * Kalshi RSA-PSS request signing helper (server-only).
 *
 * Env vars required:
 *   KALSHI_API_KEY_ID   — UUID from Kalshi settings → API keys
 *   KALSHI_PRIVATE_KEY  — PEM-encoded RSA private key (supports literal \n in env)
 */

import { sign, constants } from "crypto";

function loadPrivateKey(): string {
  const raw = process.env.KALSHI_PRIVATE_KEY ?? "";
  // .env.local stores multi-line values as escaped \n — normalize them
  return raw.replace(/\\n/g, "\n");
}

/**
 * Build the three Kalshi auth headers for a given HTTP method + path.
 * Timestamp is milliseconds-since-epoch as a string (Kalshi v2 format).
 */
export function buildKalshiAuthHeaders(
  method: string,
  path: string
): Record<string, string> {
  const accessKey = process.env.KALSHI_API_KEY_ID ?? "";
  const privateKeyPem = loadPrivateKey();

  if (!accessKey || !privateKeyPem) {
    throw new Error(
      "Kalshi credentials not configured. Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY in .env.local"
    );
  }

  const timestamp = String(Date.now()); // milliseconds
  const message = timestamp + method.toUpperCase() + path;

  const signature = sign(
    "SHA256",
    Buffer.from(message),
    {
      key: privateKeyPem,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    }
  ).toString("base64");

  return {
    "Content-Type":             "application/json",
    "KALSHI-ACCESS-KEY":        accessKey,
    "KALSHI-ACCESS-SIGNATURE":  signature,
    "KALSHI-ACCESS-TIMESTAMP":  timestamp,
  };
}
