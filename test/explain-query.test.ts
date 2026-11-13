import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import {
  analyzeExplainPlan,
  executeExplainQuery,
  type ExplainJsonRoot,
} from '../src/tools/explain-query.js';

function createMockPool(queryImpl: PoolClient['query']): Pool {
  const client = {
    query: queryImpl,
    release: vi.fn(),
  } as unknown as PoolClient;

  return {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
}

describe('analyzeExplainPlan', () => {
  it('detects nested Seq Scan nodes and row estimation skew', () => {
    const plan: ExplainJsonRoot = {
      'Planning Time': 0.45,
      'Execution Time': 42.1,
      Plan: {
        'Node Type': 'Hash Join',
        'Total Cost': 2500,
        'Plan Rows': 500,
        'Actual Rows': 500,
        Plans: [
          {
            'Node Type': 'Seq Scan',
            'Relation Name': 'orders',
            'Filter': "(status = 'pending'::text)",
            'Total Cost': 1800,
            'Plan Rows': 1200,
            'Actual Rows': 18000,
          },
          {
            'Node Type': 'Index Scan',
            'Relation Name': 'users',
            'Index Name': 'users_pkey',
            'Total Cost': 120,
            'Plan Rows': 100,
            'Actual Rows': 100,
          },
        ],
      },
    };

    const analysis = analyzeExplainPlan(plan, true);
    expect(analysis.rootNodeType).toBe('Hash Join');
    expect(analysis.seqScans).toHaveLength(1);
    expect(analysis.seqScans[0]).toMatchObject({
      relation: 'orders',
      filter: "(status = 'pending'::text)",
      estimatedRows: 1200,
      actualRows: 18000,
    });
    expect(analysis.warnings.some((w) => w.includes('Sequential scan on "orders"'))).toBe(true);
    expect(analysis.warnings.some((w) => w.includes('Row estimate skew on orders'))).toBe(true);
  });
});

describe('executeExplainQuery', () => {
  it('blocks mutating SQL before touching the database pool', async () => {
    const connectSpy = vi.fn();
    const pool = { connect: connectSpy } as unknown as Pool;

    const result = await executeExplainQuery(pool, {
      sql: 'DELETE FROM orders WHERE id = 1',
    });

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/SELECT or WITH/i);
    expect(connectSpy).not.toHaveBeenCalled();
  });

  it('executes EXPLAIN inside BEGIN READ ONLY with statement_timeout', async () => {
    const executedSql: string[] = [];
    const mockPlan: ExplainJsonRoot[] = [
      {
        'Planning Time': 0.2,
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': 'orders',
          'Total Cost': 45,
          'Plan Rows': 200,
        },
      },
    ];

    const queryMock = vi.fn(async (sql: string) => {
      executedSql.push(sql);
      if (sql.startsWith('EXPLAIN')) {
        return { rows: [{ 'QUERY PLAN': mockPlan }] };
      }
      return { rows: [] };
    }) as unknown as PoolClient['query'];

    const pool = createMockPool(queryMock);
    const result = await executeExplainQuery(pool, {
      sql: 'SELECT * FROM orders;',
      timeout_ms: 2500,
    });

    expect(result.valid).toBe(true);
    expect(result.seqScans).toHaveLength(1);
    expect(executedSql[0]).toBe('BEGIN READ ONLY');
    expect(executedSql[1]).toBe("SET LOCAL statement_timeout = '2500ms'");
    expect(executedSql[2]).toBe('EXPLAIN (FORMAT JSON, COSTS TRUE) SELECT * FROM orders');
    expect(executedSql[3]).toBe('COMMIT');
  });
});
