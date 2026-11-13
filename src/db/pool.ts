import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';

const DEFAULT_STATEMENT_TIMEOUT_MS = 5000;
const MAX_STATEMENT_TIMEOUT_MS = 60000;

export interface AuditorPoolOptions {
  connectionString?: string;
  statementTimeoutMs?: number;
}

/**
 * Resolves the statement timeout in milliseconds, clamped to a safe range.
 */
export function resolveStatementTimeoutMs(rawTimeout?: number | string): number {
  if (rawTimeout === undefined || rawTimeout === '') {
    return DEFAULT_STATEMENT_TIMEOUT_MS;
  }
  const parsed = typeof rawTimeout === 'number' ? rawTimeout : Number.parseInt(rawTimeout, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_STATEMENT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(parsed), MAX_STATEMENT_TIMEOUT_MS);
}

/**
 * Builds a pg PoolConfig from explicit options or standard PostgreSQL environment variables.
 */
export function buildPoolConfig(options: AuditorPoolOptions = {}): PoolConfig {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (connectionString) {
    return {
      connectionString,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    };
  }

  return {
    host: process.env.PGHOST ?? 'localhost',
    port: process.env.PGPORT ? Number.parseInt(process.env.PGPORT, 10) : 5432,
    database: process.env.PGDATABASE ?? 'postgres',
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? 'postgres',
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  };
}

let sharedPool: Pool | null = null;

/**
 * Returns a shared pg.Pool instance configured for read-only auditing.
 */
export function getSharedPool(options: AuditorPoolOptions = {}): Pool {
  if (!sharedPool) {
    sharedPool = new Pool(buildPoolConfig(options));
  }
  return sharedPool;
}

/**
 * Closes the shared pool gracefully (useful during shutdown or tests).
 */
export async function closeSharedPool(): Promise<void> {
  if (sharedPool) {
    await sharedPool.end();
    sharedPool = null;
  }
}

/**
 * Executes a callback inside an explicit PostgreSQL READ ONLY transaction
 * with a local statement_timeout guard.
 */
export async function withReadOnlyTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  const safeTimeout = resolveStatementTimeoutMs(timeoutMs ?? process.env.PG_STATEMENT_TIMEOUT_MS);
  const client = await pool.connect();

  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${safeTimeout}ms'`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback errors if connection already dropped
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Runs a single parameterized query inside a strict READ ONLY transaction.
 */
export async function runReadOnlyQuery<T extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  sql: string,
  params: unknown[] = [],
  timeoutMs?: number,
): Promise<QueryResult<T>> {
  return withReadOnlyTransaction(pool, (client) => client.query<T>(sql, params), timeoutMs);
}
