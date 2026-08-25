/**
 * The state machine.
 *
 * The whole product is one promise:
 *
 *   A caller is charged if and only if it received the good.
 *
 * You cannot get true atomicity across a payment network and your own compute,
 * so the promise is kept a different way: every state is durably journaled
 * BEFORE the side effect it authorises, every committed step has a compensating
 * step, and the good is never produced until the money is durably settled.
 *
 * At rest an invoice is always in a terminal state, and each one has a defined
 * money position:
 *
 *   VOID       nothing moved.        The caller was never charged.
 *   DELIVERED  amount moved once.    The caller was charged and got the good.
 *   REFUNDED   net zero.             Charged, production failed, money returned.
 *   STUCK      money held, alarmed.  Refund itself failed. A human is paged.
 *
 * STUCK is deliberate. A gate that silently swallows this case is the gate that
 * loses other people's money.
 */

export const STATES = [
  "quoted",
  "verifying",
  "settling",
  "settled",
  "producing",
  "delivered",
  "void",
  "refunding",
  "refunded",
  "stuck",
] as const;

export type State = (typeof STATES)[number];

export const TERMINAL_STATES = ["delivered", "void", "refunded", "stuck"] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

/** States where work was started but not finished. Recovery targets exactly these. */
export const IN_FLIGHT_STATES = [
  "verifying",
  "settling",
  "settled",
  "producing",
  "refunding",
] as const;

const LEGAL: Record<State, readonly State[]> = {
  // Payment proof arrived, or the quote timed out.
  quoted: ["verifying", "void"],
  // Facilitator says the proof is good, or it isn't.
  verifying: ["settling", "void"],
  // Settlement submitted. It lands, or it doesn't and nothing moved.
  settling: ["settled", "void"],
  // Money is durably ours. Only now may we spend compute.
  settled: ["producing"],
  // The good is being made. It works, or we owe a refund.
  producing: ["delivered", "refunding"],
  // Refund is the compensating action for a settle we cannot honour.
  refunding: ["refunded", "stuck"],
  delivered: [],
  void: [],
  refunded: [],
  stuck: [],
};

export function isTerminal(state: State): state is TerminalState {
  return (TERMINAL_STATES as readonly State[]).includes(state);
}

export function isInFlight(state: State): boolean {
  return (IN_FLIGHT_STATES as readonly State[]).includes(state);
}

export function canTransition(from: State, to: State): boolean {
  return (LEGAL[from] ?? []).includes(to);
}

export function assertTransition(from: State, to: State): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal transition: ${from} -> ${to}`);
  }
}

/**
 * Has the caller's money moved to us, and stayed moved?
 * Used to decide whether a failure owes a refund or owes nothing.
 */
export function isCharged(state: State): boolean {
  return ["settled", "producing", "delivered", "refunding", "stuck"].includes(state);
}
