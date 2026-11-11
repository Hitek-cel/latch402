# Security

Latch sits between a payment and a delivery. A bug here can charge someone for
nothing or give paid work away, so reports are taken seriously.

## Reporting a vulnerability

Use GitHub's private reporting: **Security → Report a vulnerability** on this
repository. Please do not open a public issue for something exploitable.

Include what you can of: the version, the SDK version if the x402 bridge is
involved, the sequence of requests or failures, and what the caller was charged
versus what it received. A failing test is the best report there is.

This is a one-person project. Expect a first reply within a week.

## What counts

Anything that breaks the promise — *a caller is charged if and only if it
received the good* — or lets someone obtain a paid response they did not pay
for. In particular:

- a payment charged twice, or charged with nothing collectable;
- a handler run more than once for one payment;
- a stored response returned to someone who does not hold its replay token;
- a payment voided while it could still land, or marked delivered when it
  never settled;
- a way to fill the journal without a verified payment.

## What Latch assumes

These are the conditions its guarantees rest on. Breaking one is a deployment
problem rather than a vulnerability in Latch, but if the documentation led you
into it, that is worth a report too.

- **The journal is durable and honest.** `append` must be write-ahead and
  compare-and-set. The conformance kit checks an adapter against the contract.
- **The oracle's RPC endpoint is trusted.** A node that lies about
  `authorizationState` can make Latch deliver unpaid work or void a real
  charge. Use an endpoint you would trust with that decision.
- **Transport is TLS.** The replay token and the payment header travel in
  request headers. Anyone who can read them in transit can use them.
- **`staleMs` exceeds your slowest handler plus the facilitator timeout.** A
  worker that outlives it loses its claim; it then fails closed and charges
  nothing, but its work is wasted.
- **Stored responses and request data are at rest in your database.** Latch
  does not encrypt or purge them.
- **Receipts are HMAC-signed.** They prove the seller issued them to anyone
  holding the secret, and nothing to anyone who does not.

## Supported versions

The latest release only.
