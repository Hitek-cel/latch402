import { sha256Hex } from "../crypto.ts";

/**
 * A payment identifier derived from the purchase, for the buyer's side.
 *
 * The `payment-identifier` extension only stops a re-signed retry from being
 * charged twice if the retry carries the same identifier as the first try.
 * The stock client sends none, and `appendPaymentIdentifierToExtensions()`
 * without an id generates a fresh random one per call — which a seller rightly
 * treats as a new purchase. Derive it from the purchase instead:
 *
 *     const payload = await client.createPaymentPayload(required);
 *     appendPaymentIdentifierToExtensions(payload.extensions ?? {}, purchasePaymentId(orderId));
 *
 * Same purchase, same identifier, on every retry and after a restart. Pass
 * every part that makes the purchase unique: if your order ids can repeat
 * across buyers, include your wallet address too, or two buyers' purchases
 * will look like one.
 *
 * The result is a hash, so nothing about the order is revealed to the seller
 * beyond the fact that two payments belong to the same purchase.
 */
export function purchasePaymentId(...parts: readonly (string | number)[]): string {
  if (parts.length === 0 || parts.some((p) => String(p).length === 0)) {
    throw new Error("purchasePaymentId needs at least one non-empty part that identifies the purchase");
  }
  // 40 hex characters after a short prefix: inside the extension's 16-128
  // character limit, and only characters its pattern allows.
  return `pay_${sha256Hex(parts.map(String).join("\u0000")).slice(0, 40)}`;
}
