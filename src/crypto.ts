/**
 * The only platform-specific corner of the library, isolated here.
 *
 * SHA-256 and HMAC are implemented in plain JavaScript rather than pulled from
 * `node:crypto`, so the exact same gate runs unchanged in Node and in a browser.
 * That matters for more than convenience: the visual console runs this real
 * source, so what it shows cannot drift away from what the tests verify.
 *
 * WebCrypto is not used because its digest API is async, and hashing sits on
 * paths that must stay synchronous (canonical request hashing, receipt signing).
 * Randomness does come from the platform CSPRNG, which is available in both.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const encoder = new TextEncoder();

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** SHA-256 over raw bytes. Returns 32 bytes. */
export function sha256(input: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  // Pad: 0x80, zeros, then the 64-bit big-endian bit length.
  const bitLen = input.length * 8;
  const withPad = new Uint8Array((((input.length + 8) >> 6) + 1) * 64);
  withPad.set(input);
  withPad[input.length] = 0x80;
  const view = new DataView(withPad.buffer);
  view.setUint32(withPad.length - 4, bitLen >>> 0, false);
  view.setUint32(withPad.length - 8, Math.floor(bitLen / 0x100000000), false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < withPad.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;

      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]!, false);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function sha256Hex(input: string): string {
  return toHex(sha256(encoder.encode(input)));
}

/** HMAC-SHA256, RFC 2104. */
export function hmacSha256Hex(secret: string, message: string): string {
  const blockSize = 64;
  const raw = encoder.encode(secret);
  const key = raw.length > blockSize ? sha256(raw) : raw;

  const padded = new Uint8Array(blockSize);
  padded.set(key);

  const inner = new Uint8Array(blockSize);
  const outer = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    inner[i] = padded[i]! ^ 0x36;
    outer[i] = padded[i]! ^ 0x5c;
  }

  const msg = encoder.encode(message);
  const innerInput = new Uint8Array(blockSize + msg.length);
  innerInput.set(inner);
  innerInput.set(msg, blockSize);
  const innerHash = sha256(innerInput);

  const outerInput = new Uint8Array(blockSize + 32);
  outerInput.set(outer);
  outerInput.set(innerHash, blockSize);
  return toHex(sha256(outerInput));
}

/** Constant-time hex comparison. Never short-circuit on a signature check. */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Minimal shape of the platform CSPRNG, so no DOM lib is required. */
type RandomSource = {
  getRandomValues<T extends Uint8Array>(array: T): T;
  randomUUID?: () => string;
};

function csprng(): RandomSource {
  const c = (globalThis as { crypto?: RandomSource }).crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new Error("No cryptographic random source available");
  }
  return c;
}

export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  csprng().getRandomValues(bytes);
  return toHex(bytes);
}

export function randomUuid(): string {
  const c = csprng();
  if (typeof c.randomUUID === "function") return c.randomUUID();
  return `${randomHex(4)}-${randomHex(2)}-${randomHex(2)}-${randomHex(2)}-${randomHex(6)}`;
}
