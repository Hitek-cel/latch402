// Proves the published shape works: plain JavaScript, resolved through the
// package's own export map, with no TypeScript loader involved.
import assert from "node:assert/strict";

const core = await import("latch402");
const x402 = await import("latch402/x402");
const conformance = await import("latch402/conformance");

const gate = new core.Latch(
  { payTo: "0xseller" },
  {
    journal: core.memoryJournal(),
    facilitator: core.ledgerFacilitator(),
    producer: { produce: async () => ({ ok: true }) },
    signer: core.hmacSigner("smoke-test-secret-long-enough-000000"),
  },
);
const { quote } = await gate.quote({ payer: "agt", sku: "s", amountMicros: 1000, request: { q: 1 } });
assert.match(quote.invoiceId, /^inv_/);

assert.equal(typeof x402.latchX402, "function");
assert.equal(typeof x402.eip3009Oracle, "function");
assert.equal(typeof x402.postgresAuthorizedPaymentStorage, "function");
assert.match(
  x402.x402InvoiceId(
    { x402Version: 2, payload: { authorization: { from: "0xabc", nonce: "0x01" } } },
    { scheme: "exact", network: "eip155:8453", asset: "0xdef", payTo: "0x1" },
  ),
  /^x402_[0-9a-f]{40}$/,
);

const report = await conformance.runJournalConformance({ create: () => core.memoryJournal() });
assert.equal(report.failed, 0);
console.log("dist smoke test passed");
