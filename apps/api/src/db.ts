import type { Pool, PoolClient } from "pg";

export async function withApiRole<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role api_app");
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

export async function withTenant<T>(
  pool: Pool,
  workspaceId: string,
  actorId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withApiRole(pool, async (client) => {
    await client.query("select identity.set_local_tenant_context($1::uuid, $2::uuid)", [workspaceId, actorId]);
    return fn(client);
  });
}
