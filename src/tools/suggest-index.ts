import type { Pool } from 'pg';
import { runReadOnlyQuery } from '../db/pool.js';
import { isValidIdentifier } from '../db/safety.js';

export type SupportedIndexType = 'btree' | 'gin' | 'gist' | 'hash';

export interface SuggestIndexInput {
  table: string;
  columns: string[];
  schema?: string;
  index_type?: SupportedIndexType;
  where_clause?: string;
}

export interface ExistingIndexInfo {
  indexName: string;
  indexDef: string;
}

export interface ColumnStatInfo {
  columnName: string;
  dataType: string;
  nDistinct: number | null;
  nullFrac: number | null;
}

export interface SuggestIndexResult {
  schema: string;
  table: string;
  columns: string[];
  indexType: SupportedIndexType;
  alreadyCovered: boolean;
  coveringIndexName?: string;
  recommendedSql: string;
  existingIndexes: ExistingIndexInfo[];
  columnStats: ColumnStatInfo[];
  notes: string[];
}

interface PgIndexRow {
  indexname: string;
  indexdef: string;
}

interface PgColumnStatRow {
  column_name: string;
  data_type: string;
  n_distinct: number | null;
  null_frac: number | null;
}

const VALID_INDEX_TYPES = new Set<SupportedIndexType>(['btree', 'gin', 'gist', 'hash']);

/**
 * Checks whether an existing index definition already covers the requested leading column(s).
 */
export function findCoveringIndex(
  existingIndexes: ExistingIndexInfo[],
  columns: string[],
): ExistingIndexInfo | undefined {
  if (columns.length === 0) return undefined;
  const targetPrefix = columns.map((c) => c.toLowerCase()).join(', ');
  const firstCol = columns[0].toLowerCase();

  for (const idx of existingIndexes) {
    const match = /\(([^)]+)\)/.exec(idx.indexDef);
    if (!match) continue;
    const idxCols = match[1]
      .split(',')
      .map((part) => part.trim().replace(/^"|"$/g, '').split(/\s+/)[0].toLowerCase());
    if (idxCols.join(', ').startsWith(targetPrefix)) {
      return idx;
    }
    if (columns.length === 1 && idxCols[0] === firstCol) {
      return idx;
    }
  }
  return undefined;
}

/**
 * Builds a safe CREATE INDEX CONCURRENTLY statement (never executed, advisory only).
 */
export function buildCreateIndexSql(
  schema: string,
  table: string,
  columns: string[],
  indexType: SupportedIndexType,
  whereClause?: string,
): string {
  const indexName = `idx_${table}_${columns.join('_')}`.slice(0, 63);
  const colList = columns.join(', ');
  const base = `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${indexName} ON ${schema}.${table} USING ${indexType} (${colList})`;
  if (whereClause && whereClause.trim().length > 0) {
    return `${base} WHERE ${whereClause.trim()};`;
  }
  return `${base};`;
}

/**
 * Inspects existing indexes and column statistics to recommend a safe non-blocking index.
 */
export async function executeSuggestIndex(
  pool: Pool,
  input: SuggestIndexInput,
): Promise<SuggestIndexResult> {
  const schema = input.schema ?? 'public';
  const indexType: SupportedIndexType = input.index_type ?? 'btree';

  if (!isValidIdentifier(schema)) {
    throw new Error(`Invalid schema identifier: "${schema}".`);
  }
  if (!isValidIdentifier(input.table)) {
    throw new Error(`Invalid table identifier: "${input.table}".`);
  }
  if (!Array.isArray(input.columns) || input.columns.length === 0) {
    throw new Error('At least one column must be provided.');
  }
  for (const col of input.columns) {
    if (!isValidIdentifier(col)) {
      throw new Error(`Invalid column identifier: "${col}".`);
    }
  }
  if (!VALID_INDEX_TYPES.has(indexType)) {
    throw new Error(`Unsupported index_type "${indexType}".`);
  }
  if (input.where_clause && input.where_clause.includes(';')) {
    throw new Error('where_clause must not contain semicolons.');
  }

  const indexesResult = await runReadOnlyQuery<PgIndexRow>(
    pool,
    `
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = $1 AND tablename = $2
      ORDER BY indexname
    `,
    [schema, input.table],
  );

  const existingIndexes: ExistingIndexInfo[] = indexesResult.rows.map((r) => ({
    indexName: r.indexname,
    indexDef: r.indexdef,
  }));

  const statsResult = await runReadOnlyQuery<PgColumnStatRow>(
    pool,
    `
      SELECT
        c.column_name,
        c.data_type,
        s.n_distinct,
        s.null_frac
      FROM information_schema.columns c
      LEFT JOIN pg_stats s
        ON s.schemaname = c.table_schema
        AND s.tablename = c.table_name
        AND s.attname = c.column_name
      WHERE c.table_schema = $1
        AND c.table_name = $2
        AND c.column_name = ANY($3::text[])
    `,
    [schema, input.table, input.columns],
  );

  const columnStats: ColumnStatInfo[] = statsResult.rows.map((r) => ({
    columnName: r.column_name,
    dataType: r.data_type,
    nDistinct: r.n_distinct,
    nullFrac: r.null_frac,
  }));

  const covering = findCoveringIndex(existingIndexes, input.columns);
  const recommendedSql = buildCreateIndexSql(
    schema,
    input.table,
    input.columns,
    indexType,
    input.where_clause,
  );

  const notes: string[] = [];
  if (covering) {
    notes.push(
      `Existing index "${covering.indexName}" already covers the leading column(s): ${covering.indexDef}`,
    );
  } else {
    notes.push('Uses CREATE INDEX CONCURRENTLY to avoid blocking writes in production.');
  }

  if (columnStats.length < input.columns.length) {
    notes.push(
      'One or more requested columns were not found in information_schema.columns; verify column names before applying.',
    );
  }

  for (const stat of columnStats) {
    if (stat.nullFrac !== null && stat.nullFrac >= 0.7) {
      notes.push(
        `Column "${stat.columnName}" is ${(stat.nullFrac * 100).toFixed(0)}% NULL; consider a partial index (WHERE ${stat.columnName} IS NOT NULL).`,
      );
    }
    if (stat.dataType === 'jsonb' && indexType === 'btree') {
      notes.push(
        `Column "${stat.columnName}" is jsonb; consider index_type: "gin" for containment (@>) queries.`,
      );
    }
  }

  return {
    schema,
    table: input.table,
    columns: input.columns,
    indexType,
    alreadyCovered: Boolean(covering),
    coveringIndexName: covering?.indexName,
    recommendedSql,
    existingIndexes,
    columnStats,
    notes,
  };
}
