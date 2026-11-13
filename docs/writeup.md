# One x402 payment, three handler runs: making paid HTTP crash-safe

*By Azzam ([@Hitek-cel](https://github.com/Hitek-cel)), November 2026.*

x402 lets an HTTP endpoint charge for a response: the server answers `402 Payment Required`, the client signs a stablecoin payment, and the server delivers. The official SDK makes that easy. I wanted to know what happens when something goes wrong between "the money moved" and "the caller got the answer" — and whether I could make that gap safe without replacing the SDK.

The promise I was after is one sentence: **a caller is charged if and only if it receives what it paid for.**

## What the SDK does on its own

I tested `@x402/hono` and `@x402/fetch` 2.30 and 2.31 with a fake chain and a facilitator I could make fail on purpose. Four things stood out.

**Three copies of one payment run the paid work three times.** If the same signed payment arrives three times at once — a retrying client, a proxy, a nervous agent — each copy passes verification, because verification is read-only. The handler runs three times. The chain only accepts the payment once, so one caller gets 200 and two get a 402, but only after the work was already done.

**A lost reply means the answer is gone.** If the response is lost after the money moved and the client resends the same payment, the SDK answers 402: the payment is spent. The caller paid and has nothing.

**A settle can move money and still report failure.** A facilitator can broadcast the transaction and then time out. The SDK sees a failure and answers 402, although the caller was charged.

**A re-signed retry is a second purchase.** A client that gets a 402 and signs again creates a new payment. In my test, two signatures for one purchase were both charged.

None of this is exotic. These are retries and timeouts.

## What I built

[Latch](../README.md) is a small library that plugs into the SDK's own lifecycle hooks and journals each step of a payment in Postgres, write-ahead. Route handlers don't change.

- **One claim per payment.** A payment is identified the way the chain identifies it: by payer and nonce. The claim is an atomic insert made after the facilitator verifies the payment and before the handler runs, so of any number of concurrent copies exactly one proceeds. Claiming after verification means junk headers can't fill the database.
- **Store the response before asking for the money.** Whatever happens to the process next, a payment that lands has something to deliver.
- **Never trust a failed settle.** On any failure, Latch asks the token contract directly — USDC's `authorizationState(payer, nonce)` is true exactly when that authorization moved money. If it did, the caller gets the stored response.
- **Recovery never charges.** A sweep finishes payments whose process died. It only learns what already happened: delivered if the chain says it settled, void once it can no longer land.

## The replay problem I didn't expect

Giving a stored response back to "the same payment" sounds simple. It isn't, because a settled EIP-3009 payment is public. Its payer, nonce and signature are all in the settlement transaction's calldata. Anyone watching the chain could rebuild the payment header and ask for the response.

So the payment can't be the proof. The 402 carries a fresh random token in a small server extension; the official client echoes server extensions back with its payment, and the token travels only inside TLS, never to the chain. A retry gets the stored response only by presenting it. For the re-signed-retry case, the SDK's `payment-identifier` extension does the job: a second signature under the same identifier is refused while the first is unresolved, and answered from the store once it settles. That holds only if the client reuses the identifier for the same purchase, deriving it from an order or invoice id; the stock client sends none, and generating a fresh random one per call protects nothing. After someone pointed that out by running the demo, Latch gained a small `purchasePaymentId(orderId)` helper for the buyer's side, and the demo now shows a buyer told "failed" signing again for the same order without being charged twice.

## Killing the server at every write

The test I trust most kills the process at every journal write — just before the write became durable, and just after — then starts a fresh process over the same database, runs the sweep, and replays the client's retry. Three facilitator behaviours (settles normally, hangs with nothing landed, lands and loses its reply), 48 cases. Every case asserts:

- at most one charge, and at most one handler run across both processes;
- charged if and only if the response is collectable;
- every payment ends `delivered` or `void`, never stuck in flight.

All 48 hold, along with 130 tests overall.

## Then I ran it for real

`npm run example:testnet` starts a real server on localhost, protects it with Latch, and pays it with the official client on Base Sepolia through the public x402 facilitator, with free test USDC. It runs a normal purchase, a lost reply, three concurrent copies and a server that dies right after the money moves. The buyer's balance went from 20.00 to 19.97 test USDC: exactly three charges for three purchases. The retry, the duplicates and the crash recovery moved nothing extra. A second run, with the extra step for a buyer who signs again for the same order, took the balance from 19.97 to 19.93: four charges for four purchases.

It hasn't handled real money. Nothing here has run on mainnet or in production.

## What happened upstream

I reported the findings to the x402 project, and that turned out to be the most useful part.

- A comment with implementation data on the open **recovery extension** proposal led its author to revise the spec three times. It now requires an atomic claim before the handler, forbids sending a losing copy a fresh payment challenge (which invites signing again), and includes the crash matrix as a conformance check.
- A bug report about hook error handling was **partly wrong**: the TypeScript behaviour I reported is documented and intended. A contributor checked the other SDKs and found the real bug — Go silently dropped the error and Python raised. A fix was merged into the official SDK the next day, along with a docs sentence I suggested. I corrected the report in place.

## Limits

Latch covers the `exact` scheme on the SDK's default flow. It can only replay JSON or HTML responses. Without the `payment-identifier` extension declared, it can't tell a re-signed purchase from a new one. The full list is in the [README](../README.md#limits).

## Try it

```bash
git clone https://github.com/Hitek-cel/latch402 && cd latch402 && npm install
npm run example
```

It takes about a minute and needs no network, keys or wallet. If you run an x402 server and Latch breaks on your traffic, that report is worth more to me than a star.

*I used an AI coding assistant to help build Latch and write this post. I've reviewed the code, run the tests, and run the live demo myself.*
