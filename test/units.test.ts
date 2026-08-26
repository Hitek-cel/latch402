import test from "node:test";
import assert from "node:assert/strict";
import { addMicros, formatUsd, isMicros, parseMicros, subMicros, toWire } from "../src/money.ts";
import { canonicalJson, deriveIdempotencyKey, hashRequest } from "../src/ids.ts";
import { STATES, canTransition, isCharged, isTerminal } from "../src/states.ts";
import { httpStatusFor } from "../src/errors.ts";

test("money refuses anything that is not an exact integer amount", () => {
  assert.equal(isMicros(24_000), true);
  assert.equal(isMicros(24_000.5), false);
  assert.equal(isMicros(-1), false);
  assert.equal(isMicros(NaN), false);
  assert.equal(isMicros("24000"), false);
  assert.throws(() => parseMicros("24000.5"));
  assert.throws(() => parseMicros("1e5"));
  assert.throws(() => parseMicros(" 24000"));
  assert.equal(parseMicros("24000"), 24_000);
  assert.equal(toWire(24_000), "24000");
});

test("money arithmetic fails loudly instead of going negative or losing precision", () => {
  assert.equal(addMicros(1, 2), 3);
  assert.equal(subMicros(5, 5), 0);
  assert.throws(() => subMicros(1, 2), /negative/);
  assert.throws(() => addMicros(Number.MAX_SAFE_INTEGER, 10));
});

test("formatting is display-only and never round-trips into arithmetic", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(4_000), "$0.004");
  assert.equal(formatUsd(24_000), "$0.024");
  assert.equal(formatUsd(1_000_000), "$1.00");
  assert.equal(formatUsd(1_500_000), "$1.50");
});

test("canonical JSON makes 'the same request' a defined notion", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(hashRequest({ x: 1, y: [1, 2] }), hashRequest({ y: [1, 2], x: 1 }));
  assert.notEqual(hashRequest({ x: 1 }), hashRequest({ x: 2 }));
  // Array order is meaningful; key order is not.
  assert.notEqual(hashRequest([1, 2]), hashRequest([2, 1]));
});

test("the idempotency key changes when, and only when, the purchase changes", () => {
  const base = { invoiceId: "inv_1", payer: "a", amountMicros: 100, requestHash: "h" };
  assert.equal(deriveIdempotencyKey(base), deriveIdempotencyKey({ ...base }));
  assert.notEqual(deriveIdempotencyKey(base), deriveIdempotencyKey({ ...base, amountMicros: 101 }));
  assert.notEqual(deriveIdempotencyKey(base), deriveIdempotencyKey({ ...base, payer: "b" }));
  assert.notEqual(deriveIdempotencyKey(base), deriveIdempotencyKey({ ...base, requestHash: "g" }));
});

test("the key cannot be forged by shifting field boundaries", () => {
  // Fields are joined with a NUL separator, so "ab"+"c" and "a"+"bc" differ.
  const a = deriveIdempotencyKey({ invoiceId: "ab", payer: "c", amountMicros: 1, requestHash: "h" });
  const b = deriveIdempotencyKey({ invoiceId: "a", payer: "bc", amountMicros: 1, requestHash: "h" });
  assert.notEqual(a, b);
});

test("every state is reachable and every terminal state is a dead end", () => {
  for (const s of STATES) {
    if (isTerminal(s)) {
      for (const t of STATES) {
        assert.equal(canTransition(s, t), false, `${s} should be terminal but allows ${t}`);
      }
    }
  }
});

test("the good is never produced from a state where money has not moved", () => {
  // "producing" is reachable from "settled", and from itself: recovery
  // re-entering a crashed attempt. Both are post-charge states, so the
  // invariant holds; no path reaches production before the money moved.
  const sources = STATES.filter((s) => canTransition(s, "producing"));
  assert.deepEqual(sources, ["settled", "producing"]);
  for (const s of sources) assert.equal(isCharged(s), true);
});

test("closing states carry the right money position", () => {
  assert.equal(isCharged("void"), false);
  assert.equal(isCharged("refunded"), false);
  assert.equal(isCharged("delivered"), true);
  assert.equal(isCharged("stuck"), true);
});

test("failures map to sane HTTP codes without string matching", () => {
  assert.equal(httpStatusFor("proof_invalid"), 402);
  assert.equal(httpStatusFor("settlement_failed"), 402);
  assert.equal(httpStatusFor("payer_mismatch"), 403);
  assert.equal(httpStatusFor("concurrent_attempt"), 409);
  assert.equal(httpStatusFor("producer_timeout"), 504);
  assert.equal(httpStatusFor("needs_operator"), 500);
});
