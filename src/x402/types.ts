/**
 * The slice of the official x402 SDK this bridge touches, as structural types.
 *
 * Latch takes no dependency on `@x402/core`. These shapes are the fields the
 * bridge reads and the values it returns; the SDK's own objects satisfy them,
 * and `test/x402.test.ts` typechecks and runs against the real packages so a
 * drift in the SDK fails the build rather than a seller's payments.
 */

export type X402Payload = {
  readonly x402Version: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly resource?: { readonly url?: string } | undefined;
  readonly extensions?: Readonly<Record<string, unknown>> | undefined;
};

export type X402Requirements = {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  /** v2 carries `amount`; v1 carried `maxAmountRequired`. */
  readonly amount?: string | undefined;
  readonly maxAmountRequired?: string | undefined;
  readonly maxTimeoutSeconds?: number | undefined;
};

export type X402VerifyResponse = {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
};

export type X402SettleResponse = {
  success: boolean;
  errorReason?: string;
  errorMessage?: string;
  payer?: string;
  transaction: string;
  network: `${string}:${string}`;
  amount?: string;
  extensions?: Record<string, unknown>;
  extra?: Record<string, unknown>;
};

export type X402VerifyContext = {
  readonly paymentPayload: X402Payload;
  readonly requirements: X402Requirements;
  readonly transportContext?: unknown;
};

export type X402VerifyResultContext = X402VerifyContext & {
  readonly result: Readonly<X402VerifyResponse>;
};

export type X402SettleContext = X402VerifyContext & {
  readonly phase: "before-handler" | "after-handler" | "cancel";
};

export type X402SettleResultContext = X402SettleContext & {
  readonly result: Readonly<X402SettleResponse>;
};

export type X402SettleFailureContext = X402SettleContext & { readonly error: Error };

export type X402CanceledContext = X402SettleContext & {
  readonly reason: string;
  readonly responseStatus?: number | undefined;
  readonly settledPhases: readonly string[];
};

export type Abort = { abort: true; reason: string; message?: string };

export type BeforeVerifyDirective = void | Abort | { skip: true; result: X402VerifyResponse };
export type AfterVerifyDirective =
  | void
  | Abort
  | { skipHandler: true; response?: { contentType?: string; body?: unknown } };
export type BeforeSettleDirective = void | Abort | { skip: true; result: X402SettleResponse };
export type SettleFailureDirective = void | { recovered: true; result: X402SettleResponse };

/**
 * What the bridge needs from a resource server: somewhere to register hooks.
 * `x402ResourceServer` from `@x402/core/server` (re-exported by the Hono,
 * Express and Next packages) is one.
 */
export type X402HookRegistry = {
  onBeforeVerify(hook: (ctx: X402VerifyContext) => Promise<BeforeVerifyDirective>): unknown;
  onAfterVerify(hook: (ctx: X402VerifyResultContext) => Promise<AfterVerifyDirective>): unknown;
  onBeforeSettle(hook: (ctx: X402SettleContext) => Promise<BeforeSettleDirective>): unknown;
  onAfterSettle(hook: (ctx: X402SettleResultContext) => Promise<void>): unknown;
  onSettleFailure(hook: (ctx: X402SettleFailureContext) => Promise<SettleFailureDirective>): unknown;
  onVerifiedPaymentCanceled(hook: (ctx: X402CanceledContext) => Promise<void>): unknown;
  /** Present on the SDK's server. Without it the bridge works, but cannot issue replay tokens. */
  registerExtension?(extension: {
    key: string;
    dynamicInfoFields?: string[];
    enrichDeclaration?: (declaration: unknown, transportContext: unknown) => unknown;
  }): unknown;
};

/** How the payment moves money, which decides how its fate can be checked later. */
export type TransferMethod = "eip3009" | "permit2" | "opaque";

/** What an oracle is asked about: one signed payment, identified the way the chain identifies it. */
export type SettlementProbe = {
  network: string;
  asset: string;
  payer: string;
  nonce: string;
  method: TransferMethod;
  /** Milliseconds. After this the payment can no longer land. */
  expiresAt: number;
};

/**
 * The crash-recovery oracle: has this exact payment moved money?
 *
 * Answer "settled" only when it has. Answer "unsettled" when it has not YET —
 * the bridge decides from the payment's own expiry whether it still can. Throw
 * when the question cannot be answered; the bridge then waits rather than
 * guesses.
 */
export type SettlementOracle = (probe: SettlementProbe) => Promise<"settled" | "unsettled">;
