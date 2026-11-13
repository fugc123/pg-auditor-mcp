import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Pool } from 'pg';
import { z } from 'zod';
import { executeExplainQuery } from './tools/explain-query.js';
import { executeFindMissingIndexes } from './tools/find-missing-indexes.js';
import { executeGetSlowQueries } from './tools/get-slow-queries.js';
import { executeSuggestIndex } from './tools/suggest-index.js';

function formatToolResponse(payload: unknown, isError = false) {
  return {
    isError,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function formatToolError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return formatToolResponse({ error: message }, true);
}

/**
 * Creates and configures the pg-auditor-mcp server with all 4 read-only auditing tools.
 */
export function createAuditorServer(pool: Pool): McpServer {
  const server = new McpServer({
    name: 'pg-auditor-mcp',
    version: '0.1.0',
  });

  server.registerTool(
    'explain_query',
    {
      title: 'Explain PostgreSQL Query',
      description:
        'Runs EXPLAIN (FORMAT JSON) inside a strict READ ONLY transaction with statement_timeout to detect sequential scans, cost bottlenecks, and row estimation skew.',
      inputSchema: {
        sql: z.string().min(1).describe('Read-only SELECT or WITH SQL query to explain.'),
        analyze: z
          .boolean()
          .optional()
          .describe('Run EXPLAIN ANALYZE inside a read-only transaction (executes the SELECT).'),
        buffers: z
          .boolean()
          .optional()
          .describe('Include buffer usage stats (only applies when analyze=true).'),
        timeout_ms: z
          .number()
          .int()
          .positive()
          .max(60000)
          .optional()
          .describe('Optional statement_timeout in milliseconds (default 5000, max 60000).'),
      },
    },
    async (args) => {
      try {
        const result = await executeExplainQuery(pool, args);
        return formatToolResponse(result, !result.valid);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    'find_missing_indexes',
    {
      title: 'Find Missing Indexes',
      description:
        'Queries pg_stat_user_tables to surface tables with heavy sequential scan activity and low index usage.',
      inputSchema: {
        schema: z.string().optional().describe('Target PostgreSQL schema (default: "public").'),
        min_seq_scans: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Minimum sequential scans threshold (default: 10).'),
        min_rows: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Minimum estimated live rows threshold (default: 100).'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Maximum number of tables to return (default: 20).'),
      },
    },
    async (args) => {
      try {
        const result = await executeFindMissingIndexes(pool, args);
        return formatToolResponse(result);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    'suggest_index',
    {
      title: 'Suggest Safe Index',
      description:
        'Inspects existing indexes and column statistics to recommend a non-blocking CREATE INDEX CONCURRENTLY statement (advisory only, never executes DDL).',
      inputSchema: {
        table: z.string().min(1).describe('Target table name.'),
        columns: z
          .array(z.string().min(1))
          .min(1)
          .describe('Ordered list of columns for the index.'),
        schema: z.string().optional().describe('Target schema (default: "public").'),
        index_type: z
          .enum(['btree', 'gin', 'gist', 'hash'])
          .optional()
          .describe('PostgreSQL index access method (default: "btree").'),
        where_clause: z
          .string()
          .optional()
          .describe('Optional partial index predicate without the WHERE keyword.'),
      },
    },
    async (args) => {
      try {
        const result = await executeSuggestIndex(pool, args);
        return formatToolResponse(result);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  server.registerTool(
    'get_slow_queries',
    {
      title: 'Get Slow Queries',
      description:
        'Reads pg_stat_statements to rank the slowest or most frequently executed queries by total time, mean time, or call count.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Maximum number of queries to return (default: 15).'),
        min_calls: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe('Minimum number of calls (default: 1).'),
        order_by: z
          .enum(['total_time', 'mean_time', 'calls'])
          .optional()
          .describe('Sort order (default: "total_time").'),
      },
    },
    async (args) => {
      try {
        const result = await executeGetSlowQueries(pool, args);
        return formatToolResponse(result);
      } catch (error) {
        return formatToolError(error);
      }
    },
  );

  return server;
}
