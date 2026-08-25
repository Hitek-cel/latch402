/**
 * Integer-only money. All amounts are USDC micros (1 USDC = 1_000_000).
 *
 * Floats are banned here. A payment gate that rounds is a gate that leaks,
 * and the leak is always in someone's favour but never yours.
 */

export const MICROS_PER_UNIT = 1_000_000;

/** Largest amount we will handle. Keeps every sum inside Number.MAX_SAFE_INTEGER. */
export const MAX_MICROS = 2 ** 53 - 1;

export function isMicros(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_MICROS
  );
}

/** Parse an on-the-wire amount string ("24000") into micros. Rejects anything lossy. */
export function parseMicros(raw: string): number {
  if (!/^\d{1,16}$/.test(raw)) {
    throw new RangeError(`Not an integer micro amount: ${JSON.stringify(raw)}`);
  }
  const value = Number(raw);
  if (!isMicros(value)) {
    throw new RangeError(`Micro amount out of safe range: ${raw}`);
  }
  return value;
}

/** Serialise micros for the wire. x402 carries amounts as decimal strings. */
export function toWire(micros: number): string {
  assertMicros(micros);
  return String(micros);
}

export function assertMicros(value: unknown): asserts value is number {
  if (!isMicros(value)) {
    throw new RangeError(`Invalid micro amount: ${String(value)}`);
  }
}

export function addMicros(a: number, b: number): number {
  assertMicros(a);
  assertMicros(b);
  const sum = a + b;
  if (sum > MAX_MICROS) throw new RangeError("Micro addition overflow");
  return sum;
}

export function subMicros(a: number, b: number): number {
  assertMicros(a);
  assertMicros(b);
  if (b > a) throw new RangeError("Micro subtraction would go negative");
  return a - b;
}

/** Human display only. Never feed this back into arithmetic. */
export function formatUsd(micros: number): string {
  assertMicros(micros);
  const whole = Math.floor(micros / MICROS_PER_UNIT);
  const frac = micros % MICROS_PER_UNIT;
  if (frac === 0) return `$${whole}.00`;
  const trimmed = String(frac).padStart(6, "0").replace(/0+$/, "");
  return `$${whole}.${trimmed.length < 2 ? trimmed.padEnd(2, "0") : trimmed}`;
}
