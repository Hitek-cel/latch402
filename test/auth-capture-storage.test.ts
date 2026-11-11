import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import {
  AuthCaptureEvmScheme,
  InMemoryAuthorizedPaymentStorage,
  type AuthorizedPayment,
  type AuthorizedPaymentStorage,
} from "@x402/evm/auth-capture/server";

import type { SqlClient, SqlExecutor } from "../src/adapters/postgres-journal.ts";
import { migrateAuthCapture, postgresAuthorizedPaymentStorage } from "../src/x402/auth-capture-storage.ts";

/**
 * The SDK's in-memory store is the specification here. Every behaviour is
 * asserted against it first and then against Postgres, so "the same interface"
 * is a tested claim rather than a hopeful one. What Postgres adds — surviving a
 * restart, and serialising concurrent updates in the database rather than in
 * one process — is tested on its own at the end.
 */

function pgClient(db: PGlite): SqlClient {
  const exec = (runner: { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }> }): SqlExecutor => ({
    async query<R>(text: string, params: readonly unknown[] = []) {
      const r = await runner.query(text, [...params]);
      return { rows: r.rows as R[], rowCount: r.affectedRows ?? r.rows.length };
    },
  });
  return {
    ...exec(db),
    async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
      return (await db.transaction(async (tx) => fn(exec(tx)))) as T;
    },
  };
}

const HASH = `0x${"Ab".repeat(32)}` as const;
const OTHER = `0x${"cd".repeat(32)}` as const;

function hold(hash: `0x${string}`, capturable: string): AuthorizedPayment {
  return {
    paymentInfoHash: hash,
    paymentInfo: {} as AuthorizedPayment["paymentInfo"],
    receiverAuthorizer: "0x0000000000000000000000000000000000000001",
    policy: "0x0000000000000000000000000000000000000002",
    network: "eip155:8453",
    capturableAmount: capturable,
    refundableAmount: "0",
    collectTransaction: "0xcollect",
    createdAt: 1,
    name: "USDC",
    version: "2",
    paymentFlow: "escrow",
    operatorType: "delegated",
    assetTransferMethod: "eip3009",
    authCaptureEscrow: "0x0000000000000000000000000000000000000003",
  } as AuthorizedPayment;
}

async function stores(): Promise<{ name: string; store: AuthorizedPaymentStorage; close: () => Promise<void> }[]> {
  const db = await PGlite.create();
  const sql = pgClient(db);
  await migrateAuthCapture(sql);
  await migrateAuthCapture(sql); // idempotent
  return [
    { name: "sdk in-memory", store: new InMemoryAuthorizedPaymentStorage(), close: async () => {} },
    { name: "latch postgres", store: postgresAuthorizedPaymentStorage<AuthorizedPayment>(sql), close: () => db.close() },
  ];
}

test("auth-capture storage: it is accepted where the SDK expects its own", async () => {
  const db = await PGlite.create();
  const sql = pgClient(db);
  await migrateAuthCapture(sql);
  const storage = postgresAuthorizedPaymentStorage<AuthorizedPayment>(sql);
  const scheme = new AuthCaptureEvmScheme({ storage });
  assert.equal(scheme.getStorage(), storage);
  await db.close();
});

test("auth-capture storage: same behaviour as the SDK's own store", async () => {
  for (const { name, store, close } of await stores()) {
    assert.equal(await store.get(HASH), undefined, name);
    assert.deepEqual(await store.list(), [], name);

    // Updating nothing into nothing is not a write.
    assert.deepEqual(await store.update(HASH, (c) => c), { payment: undefined, status: "unchanged" }, name);
    assert.deepEqual(await store.update(HASH, () => undefined), { payment: undefined, status: "unchanged" }, name);

    const created = await store.update(HASH, (c) => c ?? hold(HASH, "1000"));
    assert.equal(created.status, "updated", name);
    assert.equal(created.payment?.capturableAmount, "1000", name);

    // The SDK's "store once" idiom: a second authorize must not overwrite the first.
    const again = await store.update(HASH, (c) => c ?? hold(HASH, "9999"));
    assert.equal(again.status, "unchanged", name);
    assert.equal((await store.get(HASH))?.capturableAmount, "1000", name);

    // Keys are hashes; case must not create a second record.
    assert.equal((await store.get(HASH.toLowerCase()))?.capturableAmount, "1000", name);
    assert.equal((await store.get(HASH.toUpperCase().replace("0X", "0x")))?.capturableAmount, "1000", name);

    const captured = await store.update(HASH, (c) => (c ? { ...c, capturableAmount: "400", refundableAmount: "600" } : c));
    assert.equal(captured.status, "updated", name);
    assert.deepEqual(
      [(await store.get(HASH))?.capturableAmount, (await store.get(HASH))?.refundableAmount],
      ["400", "600"],
      name,
    );

    await store.update(OTHER, () => hold(OTHER, "5"));
    assert.deepEqual((await store.list()).map((p) => p.capturableAmount).sort(), ["400", "5"], name);

    assert.deepEqual(await store.update(HASH, () => undefined), { payment: undefined, status: "deleted" }, name);
    assert.equal(await store.get(HASH), undefined, name);
    assert.equal((await store.list()).length, 1, name);
    await close();
  }
});

test("auth-capture storage: concurrent captures cannot spend the same balance twice", async () => {
  for (const { name, store, close } of await stores()) {
    await store.update(HASH, () => hold(HASH, "1000"));

    // Twenty captures of 100 against a hold of 1000. Each reads the balance
    // and writes it back smaller; any lost update would leave more than zero
    // capturable after more than ten of them "succeeded".
    let succeeded = 0;
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.update(HASH, (c) => {
          if (!c || BigInt(c.capturableAmount) < 100n) return c;
          succeeded++;
          return { ...c, capturableAmount: (BigInt(c.capturableAmount) - 100n).toString() };
        }),
      ),
    );
    assert.equal(succeeded, 10, `${name}: exactly the held amount may be captured`);
    assert.equal((await store.get(HASH))?.capturableAmount, "0", name);
    await close();
  }
});

test("auth-capture storage: holds survive the process that recorded them", async () => {
  const db = await PGlite.create();
  const sql = pgClient(db);
  await migrateAuthCapture(sql);

  // Process A authorizes two holds and dies.
  const a = postgresAuthorizedPaymentStorage<AuthorizedPayment>(sql);
  await a.update(HASH, () => hold(HASH, "1000"));
  await a.update(OTHER, () => hold(OTHER, "250"));

  // The SDK's own store, in the same situation, would start empty.
  assert.deepEqual(await new InMemoryAuthorizedPaymentStorage().list(), []);

  // Process B starts over the same database and still knows what it may capture.
  const b = postgresAuthorizedPaymentStorage<AuthorizedPayment>(sql);
  const held = await b.list();
  assert.deepEqual(held.map((p) => p.capturableAmount).sort(), ["1000", "250"]);
  assert.equal((await b.get(HASH))?.collectTransaction, "0xcollect");
  await db.close();
});
