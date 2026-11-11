# Changelog

0.3.0 is the first version published to npm. Earlier versions existed only in
this repository.

## 0.3.0 — 2026-11

Latch now works with the official x402 SDK instead of beside it.

### Added

- **`latch402/x402` — a bridge for the official SDK.** `latchX402(server, …)`
  registers lifecycle hooks on an `x402ResourceServer` and journals every
  payment on the `exact` scheme's default flow. Route handlers do not change.
  - One atomic claim per payment, keyed by (payer, nonce) as the chain keys it.
    Concurrent copies of a payment run the handler once.
  - The response is stored before the settle is requested, so a payment that
    lands always has something to deliver.
  - A failed or timed-out settle is checked against an oracle before anything
    is concluded. Money that moved is delivered; a payment that can still land
    waits; one that cannot is voided.
  - A retry of a settled payment gets the stored response back, authorised by a
    per-402 replay token carried in a `latch` extension. A new signature under
    the same `payment-identifier` is answered from the store and never settled.
  - `sweep()` and `recover()` finish or close payments whose process died.
    Recovery never initiates a charge.
- **`eip3009Oracle`** — asks the token contract `authorizationState(payer,
  nonce)` over JSON-RPC. No key, no dependency.
- **`postgresAuthorizedPaymentStorage`** — the SDK's `auth-capture`
  `AuthorizedPaymentStorage` interface on Postgres, so the record of escrow
  holds survives a restart.
- A JavaScript build with type declarations. The package now runs on Node 20+
  without a TypeScript loader.

### Changed

- `Latch.sweep()` skips invoices opened by the x402 bridge, so the two can
  share one journal.
- The package exports compiled files from `dist/`. Import paths are unchanged.

### Notes

- The strict gate (`quote` / `redeem`) is unchanged and still does not speak
  the x402 wire format. Use the bridge for x402.
- Nothing in this release has been run against a live facilitator. See
  "Status" and "Limits" in the README.

## 0.2.0 — 2026-10

- Batched settlement: wait by default, or serve now on bounded credit.
- Executable conformance kits for the `Journal` and `Facilitator` ports, and
  fixes for the six adapter bugs they found.

## 0.1.0 — 2026-08

- The strict gate, the in-memory and Postgres journals, signed hash-chained
  receipts, and crash injection at every journal write.
