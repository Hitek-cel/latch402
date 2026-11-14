# Changelog

0.3.0 is the first version published to npm. Earlier versions existed only in
this repository.

## 0.4.1 — 2026-11-14

- **The report is now a dashboard.** Filters for time range, outcome and
  search scope the whole page; the payments table sorts, expands each payment
  into a step-by-step timeline, and exports to CSV; the activity chart splits
  delivered from not delivered and has a table view; new sections show what
  sold by route, top buyers and median time to deliver.
- **Light, dark and auto themes**, remembered between visits.
- **Added `journalReportData(sql)`**: the same data as plain objects, for
  anything else that wants to build on the journal. `journalReport` gains a
  `refreshSeconds` option for a page served live.

## 0.4.0 — 2026-11-14

- **Added `journalReport(sql)`**: a read-only HTML page built from a Postgres
  journal — headline numbers, where every payment ended, activity over time,
  recoveries, and each payment with its path and settlement link. The page is
  self-contained and loads nothing from the network.
- **`npm run report` / `npm run report:testnet`** open that page for the demo's
  payments. The demo now keeps its journal in `.latch-demo/` between runs and
  signs receipts with a fixed demo secret.

## 0.3.2 — 2026-11-14

- **Added `purchasePaymentId(...parts)`** in `latch402/x402`: a payment
  identifier derived from the purchase, for the buyer's side. The
  `payment-identifier` extension only stops a re-signed retry from being
  charged twice when the retry carries the same identifier; the stock client
  sends none, and generating a random one per call protects nothing. Reported
  by Selliksss after running the demo.
- **The demo has a new step:** a buyer told "failed" signs a new payment for
  the same order. The second signature is refused, and retrying the original
  finishes the purchase with one charge.
- The README states the identifier requirement plainly.

## 0.3.1 — 2026-11-13

No change to the library's behaviour. Documentation, tests and a demo.

- **Ran live on Base Sepolia** through the public x402 facilitator with test
  USDC. All five demo steps held, and the chain showed exactly three charges
  for three purchases. The README's status section now says what has and has
  not been run.
- **A runnable demo** in the repository: `npm run example` (offline, no keys)
  and `npm run example:testnet` (Base Sepolia). It is not part of the npm
  package.
- **Documented a limit:** while a settle is unresolved, a client that signs a
  new payment can be charged twice unless the route declares the
  `payment-identifier` extension. The quickstart now declares it, and two
  tests pin both cases.
- Tested against `@x402/core` 2.31.0 as well as 2.30.0.
- The author is credited in the README and the package metadata.

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
