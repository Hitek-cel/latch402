import { randomHex, randomUuid, sha256Hex } from "./crypto.ts";

/**
 * Identifiers are security boundaries here, not cosmetics.
 *
 * The demo this replaces used Math.random() for invoice ids. Invoice ids are
 * guessed by attackers, so they get real entropy.
 */

export function newId(prefix: string): string {
  return `${prefix}_${randomHex(12)}`;
}

export function newInvoiceId(): string {
  return newId("inv");
}

export function newNonce(): string {
  return randomUuid();
}

/**
 * The key that makes retries safe.
 *
 * Derived, not random: the same logical request produces the same key on every
 * retry, so a caller that times out and retries gets the original result back
 * instead of paying twice. Any change to payer, amount, or request body yields
 * a different key and is therefore a different purchase.
 */
export function deriveIdempotencyKey(parts: {
  invoiceId: string;
  payer: string;
  amountMicros: number;
  requestHash: string;
}): string {
  const canonical = [
    parts.invoiceId,
    parts.payer,
    String(parts.amountMicros),
    parts.requestHash,
  ].join("\u0000");
  return `idem_${sha256Hex(canonical).slice(0, 32)}`;
}

/** Stable hash of a request body, so "same request" is a defined notion. */
export function hashRequest(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Deterministic JSON: sorted keys, no incidental whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
