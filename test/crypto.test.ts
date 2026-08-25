import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { hmacSha256Hex, sha256Hex, timingSafeEqualHex } from "../src/crypto.ts";

/**
 * The library hashes and signs with its own SHA-256 so the same source runs in
 * a browser. Hand-rolled crypto is exactly the kind of thing that is quietly
 * wrong, so it is checked two ways: against published vectors, and
 * differentially against Node's own implementation over random input.
 */

test("SHA-256 matches published test vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(
    sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  );
});

test("HMAC-SHA256 matches published test vectors", () => {
  assert.equal(
    hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog"),
    "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
  );
});

test("SHA-256 agrees with node:crypto across sizes and block boundaries", () => {
  // 55/56/63/64/65 straddle the padding and block edges, where naive
  // implementations break.
  const lengths = [0, 1, 55, 56, 63, 64, 65, 127, 128, 129, 1000, 4096];
  for (const n of lengths) {
    const input = randomBytes(n).toString("hex").slice(0, n);
    const expected = createHash("sha256").update(input, "utf8").digest("hex");
    assert.equal(sha256Hex(input), expected, `mismatch at length ${n}`);
  }
});

test("SHA-256 agrees with node:crypto on multi-byte UTF-8", () => {
  for (const s of ["café", "日本語のテキスト", "🔒🔑", "a\u0000b"]) {
    assert.equal(sha256Hex(s), createHash("sha256").update(s, "utf8").digest("hex"), s);
  }
});

test("HMAC agrees with node:crypto, including keys longer than the block size", () => {
  const keys = ["", "k", "x".repeat(63), "x".repeat(64), "x".repeat(65), "y".repeat(200)];
  for (const key of keys) {
    const msg = randomBytes(40).toString("hex");
    const expected = createHmac("sha256", key).update(msg, "utf8").digest("hex");
    assert.equal(hmacSha256Hex(key, msg), expected, `mismatch for key length ${key.length}`);
  }
});

test("signature comparison rejects mismatches of every shape", () => {
  const a = "a".repeat(64);
  assert.equal(timingSafeEqualHex(a, a), true);
  assert.equal(timingSafeEqualHex(a, "b".repeat(64)), false);
  assert.equal(timingSafeEqualHex(a, a.slice(0, 63)), false);
  assert.equal(timingSafeEqualHex(a, ""), false);
});
