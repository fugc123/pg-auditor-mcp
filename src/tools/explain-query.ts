import type { Pool } from 'pg';
import { withReadOnlyTransaction } from '../db/pool.js';
import { validateReadOnlySql } from '../db/safety.js';

export interface ExplainQueryInput {
  sql: string;
  analyze?: boolean;
  buffers?: boolean;
  timeout_ms?: number;
}

export interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Schema'?: string;
  'Alias'?: string;
  'Startup Cost'?: number;
  'Total Cost'?: number;
  'Plan Rows'?: number;
  'Actual Rows'?: number;
  'Actual Total Time'?: number;
  'Actual Loops'?: number;
  'Filter'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Plans'?: PlanNode[];
  [key: string]: unknown;
}

export interface ExplainJsonRoot {
  Plan: PlanNode;
  'Planning Time'?: number;
  'Execution Time'?: number;
}

export interface SeqScanFinding {
  relation: string;
  filter?: string;
  estimatedRows: number;
  actualRows?: number;
  totalCost: number;
}

export interface ExplainAnalysisResult {
  valid: boolean;
  error?: string;
  sanitizedSql?: string;
  analyzed: boolean;
  rootNodeType?: string;
  totalCost?: number;
  estimatedRows?: number;
  planningTimeMs?: number;
  executionTimeMs?: number;
  seqScans: SeqScanFinding[];
  warnings: string[];
  rawPlan?: ExplainJsonRoot;
}

/**
 * Recursively walks a PostgreSQL JSON EXPLAIN plan to extract sequential scans
 * and performance warnings (e.g. large seq scans, row estimation skew).
 */
export function analyzeExplainPlan(
  planRoot: ExplainJsonRoot,
  analyzed: boolean,
): Omit<ExplainAnalysisResult, 'valid' | 'sanitizedSql' | 'error'> {
  const seqScans: SeqScanFinding[] = [];
  const warnings: string[] = [];

  function walk(node: PlanNode): void {
    const nodeType = node['Node Type'];
    const planRows = node['Plan Rows'] ?? 0;
    const actualRows = node['Actual Rows'];
    const totalCost = node['Total Cost'] ?? 0;

    if (nodeType === 'Seq Scan') {
      const relation = node['Relation Name'] ?? node['Alias'] ?? 'unknown';
      seqScans.push({
        relation,
        filter: node['Filter'],
        estimatedRows: planRows,
        actualRows,
        totalCost,
      });

      if (node['Filter'] && (planRows >= 1000 || (actualRows !== undefined && actualRows >= 1000))) {
        warnings.push(
          `Sequential scan on "${relation}" with filter ${node['Filter']} (est. ${planRows} rows). Consider adding an index on the filtered column(s).`,
        );
      } else if (planRows >= 10000) {
        warnings.push(
          `Large sequential scan on "${relation}" (est. ${planRows} rows, cost ${totalCost}).`,
        );
      }
    }

    if (analyzed && actualRows !== undefined && planRows > 0) {
      const ratio = Math.max(actualRows / planRows, planRows / Math.max(actualRows, 1));
      if (ratio >= 10 && Math.max(actualRows, planRows) >= 100) {
        const target = node['Relation Name'] ?? nodeType;
        warnings.push(
          `Row estimate skew on ${target}: planned ${planRows} vs actual ${actualRows} rows (${ratio.toFixed(1)}x). Run ANALYZE on the table.`,
        );
      }
    }

    if (Array.isArray(node['Plans'])) {
      for (const child of node['Plans']) {
        walk(child);
      }
    }
  }

  walk(planRoot.Plan);

  return {
    analyzed,
    rootNodeType: planRoot.Plan['Node Type'],
    totalCost: planRoot.Plan['Total Cost'],
    estimatedRows: planRoot.Plan['Plan Rows'],
    planningTimeMs: planRoot['Planning Time'],
    executionTimeMs: planRoot['Execution Time'],
    seqScans,
    warnings,
    rawPlan: planRoot,
  };
}

/**
 * Runs EXPLAIN (FORMAT JSON) on a validated read-only SQL query inside a READ ONLY transaction.
 */
export async function executeExplainQuery(
  pool: Pool,
  input: ExplainQueryInput,
): Promise<ExplainAnalysisResult> {
  const validation = validateReadOnlySql(input.sql);
  if (!validation.valid || !validation.sanitizedSql) {
    return {
      valid: false,
      error: validation.reason ?? 'Invalid SQL query.',
      analyzed: Boolean(input.analyze),
      seqScans: [],
      warnings: [],
    };
  }

  const analyze = Boolean(input.analyze);
  const buffers = Boolean(input.buffers) && analyze;
  const options = ['FORMAT JSON', 'COSTS TRUE'];
  if (analyze) options.push('ANALYZE TRUE');
  if (buffers) options.push('BUFFERS TRUE');

  const explainSql = `EXPLAIN (${options.join(', ')}) ${validation.sanitizedSql}`;

  const rows = await withReadOnlyTransaction(
    pool,
    async (client) => {
      const result = await client.query<{ 'QUERY PLAN': ExplainJsonRoot[] }>(explainSql);
      return result.rows;
    },
    input.timeout_ms,
  );

  const planArray = rows[0]?.['QUERY PLAN'];
  const planRoot = Array.isArray(planArray) ? planArray[0] : undefined;

  if (!planRoot || !planRoot.Plan) {
    return {
      valid: true,
      sanitizedSql: validation.sanitizedSql,
      analyzed: analyze,
      error: 'PostgreSQL did not return a valid JSON EXPLAIN plan.',
      seqScans: [],
      warnings: [],
    };
  }

  const analysis = analyzeExplainPlan(planRoot, analyze);
  return {
    valid: true,
    sanitizedSql: validation.sanitizedSql,
    ...analysis,
  };
}
