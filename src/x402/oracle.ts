import type { SettlementOracle } from "./types.ts";

/** `authorizationState(address,bytes32)` — the EIP-3009 view that says whether a nonce was used. */
const AUTHORIZATION_STATE = "0xe94a0102";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

/**
 * A settlement oracle for EIP-3009 payments (x402 `exact` on EVM, the USDC
 * default), answered by the token contract itself.
 *
 * A facilitator's settle response can be lost, time out, or simply be wrong.
 * The token contract cannot: `authorizationState(payer, nonce)` is true exactly
 * when that signed authorization has moved money. One read-only `eth_call`, no
 * key, no dependency.
 *
 * `rpcUrls` maps a CAIP-2 network to a JSON-RPC endpoint, e.g.
 * `{ "eip155:8453": "https://mainnet.base.org" }`. Use an endpoint you trust:
 * a lying node is a lying oracle.
 */
export function eip3009Oracle(config: {
  rpcUrls: Readonly<Record<string, string>>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): SettlementOracle {
  const doFetch = config.fetch ?? fetch;
  const timeoutMs = config.timeoutMs ?? 5_000;

  return async (probe) => {
    if (probe.method !== "eip3009") {
      throw new Error(`eip3009Oracle cannot answer for transfer method "${probe.method}"`);
    }
    const url = config.rpcUrls[probe.network];
    if (!url) throw new Error(`eip3009Oracle has no RPC URL for network "${probe.network}"`);
    if (!ADDRESS.test(probe.asset)) throw new Error("eip3009Oracle: asset is not an EVM address");
    if (!ADDRESS.test(probe.payer)) throw new Error("eip3009Oracle: payer is not an EVM address");
    if (!BYTES32.test(probe.nonce)) throw new Error("eip3009Oracle: nonce is not 32 bytes");

    const data =
      AUTHORIZATION_STATE +
      probe.payer.slice(2).toLowerCase().padStart(64, "0") +
      probe.nonce.slice(2).toLowerCase();

    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: probe.asset, data }, "latest"],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`eip3009Oracle: RPC answered HTTP ${res.status}`);

    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`eip3009Oracle: RPC error: ${body.error.message ?? "unknown"}`);
    // Anything but one clean 32-byte word is not an answer. An empty "0x" is
    // what a call to a non-contract returns, and must never read as "unused".
    if (typeof body.result !== "string" || !BYTES32.test(body.result)) {
      throw new Error("eip3009Oracle: RPC returned a malformed result");
    }
    return BigInt(body.result) !== 0n ? "settled" : "unsettled";
  };
}
