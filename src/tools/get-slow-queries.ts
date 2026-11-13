import type { Pool } from 'pg';
import { runReadOnlyQuery } from '../db/pool.js';

export type SlowQueryOrderBy = 'total_time' | 'mean_time' | 'calls';

export interface GetSlowQueriesInput {
  limit?: number;
  min_calls?: number;
  order_by?: SlowQueryOrderBy;
}

export interface SlowQueryEntry {
  queryId: string;
  query: string;
  calls: number;
  totalExecTimeMs: number;
  meanExecTimeMs: number;
  rows: number;
  sharedBlksHit: number;
  sharedBlksRead: number;
  cacheHitRatio: number | null;
}

export interface GetSlowQueriesResult {
  extensionAvailable: boolean;
  message: string;
  queries: SlowQueryEntry[];
}

interface PgStatStatementsRow {
  queryid: string;
  query: string;
  calls: string;
  total_exec_time: number;
  mean_exec_time: number;
  rows: string;
  shared_blks_hit: string;
  shared_blks_read: string;
}

const ORDER_COLUMN_MAP: Record<SlowQueryOrderBy, string> = {
  total_time: 'total_exec_time DESC',
  mean_time: 'mean_exec_time DESC',
  calls: 'calls DESC',
};

/**
 * Queries pg_stat_statements for the slowest or most resource-intensive SQL statements.
 */
export async function executeGetSlowQueries(
  pool: Pool,
  input: GetSlowQueriesInput = {},
): Promise<GetSlowQueriesResult> {
  const extCheck = await runReadOnlyQuery<{ installed: number }>(
    pool,
    `SELECT 1 AS installed FROM pg_extension WHERE extname = 'pg_stat_statements'`,
  );

  if (extCheck.rows.length === 0) {
    return {
      extensionAvailable: false,
      message:
        'The pg_stat_statements extension is not installed in this database. Enable it in postgresql.conf (shared_preload_libraries = \'pg_stat_statements\') and run CREATE EXTENSION IF NOT EXISTS pg_stat_statements;.',
      queries: [],
    };
  }

  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 15)), 50);
  const minCalls = Math.max(1, Math.floor(input.min_calls ?? 1));
  const orderBy: SlowQueryOrderBy = input.order_by ?? 'total_time';
  const orderClause = ORDER_COLUMN_MAP[orderBy] ?? ORDER_COLUMN_MAP.total_time;

  const sql = `
    SELECT
      COALESCE(queryid::text, '') AS queryid,
      query,
      calls::text AS calls,
      ROUND(total_exec_time::numeric, 2)::float8 AS total_exec_time,
      ROUND(mean_exec_time::numeric, 2)::float8 AS mean_exec_time,
      rows::text AS rows,
      shared_blks_hit::text AS shared_blks_hit,
      shared_blks_read::text AS shared_blks_read
    FROM pg_stat_statements
    WHERE calls >= $1
      AND query NOT ILIKE '%pg_stat_statements%'
    ORDER BY ${orderClause}
    LIMIT $2
  `;

  const result = await runReadOnlyQuery<PgStatStatementsRow>(pool, sql, [minCalls, limit]);

  const queries: SlowQueryEntry[] = result.rows.map((row) => {
    const hit = Number(row.shared_blks_hit);
    const read = Number(row.shared_blks_read);
    const totalBlks = hit + read;

    return {
      queryId: row.queryid,
      query: row.query,
      calls: Number(row.calls),
      totalExecTimeMs: row.total_exec_time,
      meanExecTimeMs: row.mean_exec_time,
      rows: Number(row.rows),
      sharedBlksHit: hit,
      sharedBlksRead: read,
      cacheHitRatio: totalBlks > 0 ? Number((hit / totalBlks).toFixed(4)) : null,
    };
  });

  return {
    extensionAvailable: true,
    message: `Returned ${queries.length} slow query record(s) ordered by ${orderBy}.`,
    queries,
  };
}
