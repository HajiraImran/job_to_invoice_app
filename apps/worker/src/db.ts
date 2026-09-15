import type { Pool, PoolClient } from "pg";

export async function withWorkerRole<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role worker_app");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch {
      /* already aborted */
    }
    throw error;
  } finally {
    client.release();
  }
}
