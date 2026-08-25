import { hmacSha256Hex, sha256Hex, timingSafeEqualHex } from "./crypto.ts";
import { canonicalJson } from "./ids.ts";
import type { State } from "./states.ts";

/**
 * Receipts: what the seller can prove afterwards.
 *
 * Two properties that a plain JSON blob does not have:
 *
 *  1. Signed — the buyer can verify the seller issued it, so it settles disputes.
 *  2. Hash-chained — each receipt commits to the previous one, so the seller
 *     cannot quietly rewrite history either. Tamper-evident in both directions.
 */

export type Receipt = {
  version: 1;
  invoiceId: string;
  outcome: Extract<State, "delivered" | "void" | "refunded" | "stuck">;
  payer: string;
  payTo: string;
  /** What actually moved. Zero for void, and for refunded (it came back). */
  chargedMicros: number;
  asset: string;
  network: string;
  /** Hash of the request, so a receipt is bound to one specific purchase. */
  requestHash: string;
  /** Hash of what was delivered, so "you got nothing" is a checkable claim. */
  resultHash: string | null;
  settlementRef: string | null;
  refundRef: string | null;
  issuedAt: number;
  /** Hash of the previous receipt in this seller's chain. */
  prev: string;
};

export type SignedReceipt = { receipt: Receipt; signature: string };

export type Signer = {
  sign(payload: string): string;
  verify(payload: string, signature: string): boolean;
};

/** HMAC signer. Fine for a single seller; swap for an asymmetric one if buyers must verify without a shared secret. */
export function hmacSigner(secret: string): Signer {
  if (secret.length < 32) {
    throw new Error("Receipt signing secret must be at least 32 characters");
  }
  return {
    sign(payload) {
      return hmacSha256Hex(secret, payload);
    },
    verify(payload, signature) {
      return timingSafeEqualHex(hmacSha256Hex(secret, payload), signature);
    },
  };
}

export const GENESIS = "0".repeat(64);

export function hashReceipt(receipt: Receipt): string {
  return sha256Hex(canonicalJson(receipt));
}

export function issueReceipt(receipt: Receipt, signer: Signer): SignedReceipt {
  return { receipt, signature: signer.sign(canonicalJson(receipt)) };
}

export function verifyReceipt(signed: SignedReceipt, signer: Signer): boolean {
  return signer.verify(canonicalJson(signed.receipt), signed.signature);
}

/**
 * Walk a chain of receipts and confirm nothing was inserted, dropped or edited.
 * Returns the index of the first bad link, or -1 if the chain is intact.
 */
export function auditChain(chain: SignedReceipt[], signer: Signer): number {
  let prev = GENESIS;
  for (let i = 0; i < chain.length; i++) {
    const link = chain[i];
    if (!link) return i;
    if (link.receipt.prev !== prev) return i;
    if (!verifyReceipt(link, signer)) return i;
    prev = hashReceipt(link.receipt);
  }
  return -1;
}
