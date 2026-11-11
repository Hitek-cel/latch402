import type { SqlClient, SqlExecutor } from "../adapters/postgres-journal.ts";

/**
 * Durable storage for the x402 `auth-capture` scheme.
 *
 * `auth-capture` puts "charged only if delivered" on chain: the buyer's money
 * is held in escrow, then captured, voided or refunded. What stays off chain
 * is the seller's own record of each hold — which ones exist, how much of each
 * is still capturable, how much is refundable. The SDK keeps that record in an
 * `AuthorizedPaymentStorage`, and the one it ships lives in process memory.
 *
 * Lose that memory and the holds are still on chain, but the server no longer
 * knows about them: it cannot capture what it earned or void what it did not,
 * and the money sits until the buyer reclaims it. This is the same interface
 * on Postgres, so a restart, a deploy or a second instance sees every hold.
 *
 *     new AuthCaptureEvmScheme({ storage: postgresAuthorizedPaymentStorage(sql) })
 *
 * Latch takes no dependency on the SDK, so the record type is a parameter;
 * pass the SDK's `AuthorizedPayment` for full typing.
 */

/** Run once at deploy. Safe to re-run. */
export const AUTH_CAPTURE_SCHEMA = `
create table if not exists latch_authorized_payment (
  payment_info_hash text   primary key,
  payment           jsonb  not null,
  updated_at        bigint not null
)
`;

export async function migrateAuthCapture(sql: SqlExecutor): Promise<void> {
  await sql.query(AUTH_CAPTURE_SCHEMA);
}

export type AuthorizedPaymentUpdate<T> = {
  payment: T | undefined;
  status: "updated" | "unchanged" | "deleted";
};

export type AuthorizedPaymentStore<T> = {
  get(paymentInfoHash: string): Promise<T | undefined>;
  list(): Promise<T[]>;
  /**
   * Read-modify-write as one atomic step per payment. Returning the record it
   * was given leaves it unchanged; returning `undefined` deletes it.
   */
  update(
    paymentInfoHash: string,
    update: (current: T | undefined) => T | undefined,
  ): Promise<AuthorizedPaymentUpdate<T>>;
};

/** Hashes are hex; the same hold must never live under two spellings of its key. */
const normalize = (hash: string): string => hash.toLowerCase();

const parse = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

export function postgresAuthorizedPaymentStorage<T extends object = Record<string, unknown>>(
  sql: SqlClient,
): AuthorizedPaymentStore<T> {
  return {
    async get(paymentInfoHash) {
      const res = await sql.query<{ payment: unknown }>(
        `select payment from latch_authorized_payment where payment_info_hash = $1`,
        [normalize(paymentInfoHash)],
      );
      const row = res.rows[0];
      return row ? parse<T>(row.payment) : undefined;
    },

    async list() {
      const res = await sql.query<{ payment: unknown }>(
        `select payment from latch_authorized_payment order by updated_at asc, payment_info_hash asc`,
      );
      return res.rows.map((r) => parse<T>(r.payment));
    },

    async update(paymentInfoHash, update) {
      const key = normalize(paymentInfoHash);
      return sql.transaction(async (tx) => {
        // A capture decrements what is left to capture. Two of them reading the
        // same balance would both succeed and together capture more than was
        // held, so the read and the write are serialised per payment. The
        // advisory lock also covers the first write, when there is no row yet
        // for a row lock to hold.
        await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [key]);
        const res = await tx.query<{ payment: unknown }>(
          `select payment from latch_authorized_payment where payment_info_hash = $1`,
          [key],
        );
        const row = res.rows[0];
        const current = row ? parse<T>(row.payment) : undefined;
        const next = update(current);

        if (next === current) return { payment: current, status: "unchanged" as const };
        if (!next) {
          await tx.query(`delete from latch_authorized_payment where payment_info_hash = $1`, [key]);
          return { payment: undefined, status: current ? ("deleted" as const) : ("unchanged" as const) };
        }
        await tx.query(
          `insert into latch_authorized_payment (payment_info_hash, payment, updated_at)
           values ($1, $2, $3)
           on conflict (payment_info_hash) do update set payment = excluded.payment, updated_at = excluded.updated_at`,
          [key, JSON.stringify(next), Date.now()],
        );
        return { payment: next, status: "updated" as const };
      });
    },
  };
}
