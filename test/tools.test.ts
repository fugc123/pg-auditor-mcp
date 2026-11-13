import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { executeFindMissingIndexes } from '../src/tools/find-missing-indexes.js';
import { executeGetSlowQueries } from '../src/tools/get-slow-queries.js';
import {
  buildCreateIndexSql,
  executeSuggestIndex,
  findCoveringIndex,
} from '../src/tools/suggest-index.js';

function createMockPoolForResponses(
  handler: (sql: string, params?: unknown[]) => { rows: unknown[] },
): Pool {
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (
        sql === 'BEGIN READ ONLY' ||
        sql.startsWith('SET LOCAL statement_timeout') ||
        sql === 'COMMIT' ||
        sql === 'ROLLBACK'
      ) {
        return { rows: [] };
      }
      return handler(sql, params);
    }),
    release: vi.fn(),
  } as unknown as PoolClient;

  return {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
}

describe('find_missing_indexes', () => {
  it('rejects invalid schema identifiers', async () => {
    const pool = createMockPoolForResponses(() => ({ rows: [] }));
    await expect(
      executeFindMissingIndexes(pool, { schema: 'public; DROP TABLE users' }),
    ).rejects.toThrow(/Invalid schema identifier/i);
  });

  it('computes seqScanRatio and avgRowsPerSeqScan from pg_stat_user_tables', async () => {
    const pool = createMockPoolForResponses(() => ({
      rows: [
        {
          schemaname: 'public',
          relname: 'orders',
          seq_scan: '80',
          seq_tup_read: '400000',
          idx_scan: '20',
          n_live_tup: '5000',
          table_size_bytes: '1048576',
        },
      ],
    }));

    const res = await executeFindMissingIndexes(pool, { schema: 'public' });
    expect(res.candidates).toHaveLength(1);
    expect(res.candidates[0]).toMatchObject({
      table: 'orders',
      seqScans: 80,
      idxScans: 20,
      seqScanRatio: 0.8,
      avgRowsPerSeqScan: 5000,
    });
  });
});

describe('suggest_index', () => {
  it('detects existing covering index on leading column', () => {
    const covering = findCoveringIndex(
      [
        {
          indexName: 'idx_orders_user_status',
          indexDef: 'CREATE INDEX idx_orders_user_status ON public.orders USING btree (user_id, status)',
        },
      ],
      ['user_id'],
    );
    expect(covering?.indexName).toBe('idx_orders_user_status');
  });

  it('builds CREATE INDEX CONCURRENTLY SQL with optional WHERE clause', () => {
    const sql = buildCreateIndexSql('public', 'orders', ['status', 'created_at'], 'btree', "status = 'pending'");
    expect(sql).toBe(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_status_created_at ON public.orders USING btree (status, created_at) WHERE status = 'pending';",
    );
  });

  it('recommends GIN for jsonb columns when btree is requested', async () => {
    const pool = createMockPoolForResponses((sql) => {
      if (sql.includes('FROM pg_indexes')) {
        return { rows: [] };
      }
      return {
        rows: [
          {
            column_name: 'metadata',
            data_type: 'jsonb',
            n_distinct: 120,
            null_frac: 0.05,
          },
        ],
      };
    });

    const res = await executeSuggestIndex(pool, {
      table: 'events',
      columns: ['metadata'],
    });

    expect(res.alreadyCovered).toBe(false);
    expect(res.notes.some((n) => n.includes('index_type: "gin"'))).toBe(true);
  });
});

describe('get_slow_queries', () => {
  it('returns actionable message when pg_stat_statements is not installed', async () => {
    const pool = createMockPoolForResponses(() => ({ rows: [] }));
    const res = await executeGetSlowQueries(pool);

    expect(res.extensionAvailable).toBe(false);
    expect(res.queries).toHaveLength(0);
    expect(res.message).toContain('pg_stat_statements');
  });

  it('calculates cacheHitRatio when pg_stat_statements rows are returned', async () => {
    const pool = createMockPoolForResponses((sql) => {
      if (sql.includes('FROM pg_extension')) {
        return { rows: [{ installed: 1 }] };
      }
      return {
        rows: [
          {
            queryid: '12345',
            query: 'SELECT * FROM orders WHERE customer_id = $1',
            calls: '250',
            total_exec_time: 1250.5,
            mean_exec_time: 5.0,
            rows: '500',
            shared_blks_hit: '900',
            shared_blks_read: '100',
          },
        ],
      };
    });

    const res = await executeGetSlowQueries(pool, { order_by: 'mean_time' });
    expect(res.extensionAvailable).toBe(true);
    expect(res.queries).toHaveLength(1);
    expect(res.queries[0].cacheHitRatio).toBe(0.9);
  });
});
