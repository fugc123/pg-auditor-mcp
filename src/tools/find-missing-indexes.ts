import type { Pool } from 'pg';
import { runReadOnlyQuery } from '../db/pool.js';
import { isValidIdentifier } from '../db/safety.js';

export interface FindMissingIndexesInput {
  schema?: string;
  min_seq_scans?: number;
  min_rows?: number;
  limit?: number;
}

export interface MissingIndexCandidate {
  schema: string;
  table: string;
  seqScans: number;
  seqTupRead: number;
  idxScans: number;
  liveRows: number;
  tableSizeBytes: number;
  seqScanRatio: number;
  avgRowsPerSeqScan: number;
}

export interface FindMissingIndexesResult {
  schema: string;
  candidates: MissingIndexCandidate[];
  summary: string;
}

interface PgStatTableRow {
  schemaname: string;
  relname: string;
  seq_scan: string;
  seq_tup_read: string;
  idx_scan: string;
  n_live_tup: string;
  table_size_bytes: string;
}

/**
 * Inspects pg_stat_user_tables to surface tables with heavy sequential scan activity
 * and low index usage.
 */
export async function executeFindMissingIndexes(
  pool: Pool,
  input: FindMissingIndexesInput = {},
): Promise<FindMissingIndexesResult> {
  const schema = input.schema ?? 'public';
  if (!isValidIdentifier(schema)) {
    throw new Error(`Invalid schema identifier: "${schema}".`);
  }

  const minSeqScans = Math.max(0, Math.floor(input.min_seq_scans ?? 10));
  const minRows = Math.max(0, Math.floor(input.min_rows ?? 100));
  const limit = Math.min(Math.max(1, Math.floor(input.limit ?? 20)), 100);

  const sql = `
    SELECT
      schemaname,
      relname,
      COALESCE(seq_scan, 0)::text AS seq_scan,
      COALESCE(seq_tup_read, 0)::text AS seq_tup_read,
      COALESCE(idx_scan, 0)::text AS idx_scan,
      COALESCE(n_live_tup, 0)::text AS n_live_tup,
      pg_total_relation_size(relid)::text AS table_size_bytes
    FROM pg_stat_user_tables
    WHERE schemaname = $1
      AND COALESCE(seq_scan, 0) >= $2
      AND COALESCE(n_live_tup, 0) >= $3
    ORDER BY COALESCE(seq_tup_read, 0) DESC, COALESCE(seq_scan, 0) DESC
    LIMIT $4
  `;

  const result = await runReadOnlyQuery<PgStatTableRow>(pool, sql, [
    schema,
    minSeqScans,
    minRows,
    limit,
  ]);

  const candidates: MissingIndexCandidate[] = result.rows.map((row) => {
    const seqScans = Number(row.seq_scan);
    const seqTupRead = Number(row.seq_tup_read);
    const idxScans = Number(row.idx_scan);
    const liveRows = Number(row.n_live_tup);
    const tableSizeBytes = Number(row.table_size_bytes);
    const totalScans = seqScans + idxScans;

    return {
      schema: row.schemaname,
      table: row.relname,
      seqScans,
      seqTupRead,
      idxScans,
      liveRows,
      tableSizeBytes,
      seqScanRatio: totalScans > 0 ? Number((seqScans / totalScans).toFixed(4)) : 0,
      avgRowsPerSeqScan: seqScans > 0 ? Math.round(seqTupRead / seqScans) : 0,
    };
  });

  const summary =
    candidates.length === 0
      ? `No tables in schema "${schema}" matched >= ${minSeqScans} sequential scans and >= ${minRows} live rows.`
      : `Found ${candidates.length} table(s) in schema "${schema}" with high sequential scan activity.`;

  return { schema, candidates, summary };
}
