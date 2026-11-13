# pg-auditor-mcp

A read-only **PostgreSQL Query & Index Auditor** built on the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/).

`pg-auditor-mcp` gives AI coding assistants (Claude Desktop, Cursor, Claude Code) safe, read-only visibility into PostgreSQL execution plans, sequential scan hotspots, `pg_stat_statements` slow queries, and non-blocking `CREATE INDEX CONCURRENTLY` recommendations.

## Architecture

```mermaid
flowchart LR
  Client["MCP Client (Claude / Cursor)"] -->|stdio JSON-RPC| Server["pg-auditor-mcp (src/server.ts)"]
  Server --> Safety["SQL Safety Guard (src/db/safety.ts)"]
  Safety -->|SELECT / WITH only| Pool["Read-Only Pool (BEGIN READ ONLY + timeout)"]
  Pool --> PG[("PostgreSQL 16+")]
```

## Safety Guardrails

1. **AST / Token SQL Validation (`src/db/safety.ts`)**: Only single `SELECT` or `WITH` queries are accepted. DML/DDL (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `COPY`), multi-statement payloads, `SELECT ... INTO`, and row-level locking (`FOR UPDATE` / `FOR SHARE`) are rejected before touching the database.
2. **Database-Enforced Read-Only Transactions (`src/db/pool.ts`)**: Every query executes inside `BEGIN READ ONLY` with `SET LOCAL statement_timeout` (default `5000ms`, max `60000ms`).
3. **Advisory DDL Only**: `suggest_index` never executes `CREATE INDEX`; it inspects `pg_indexes` and `pg_stats` and returns a `CREATE INDEX CONCURRENTLY IF NOT EXISTS` recommendation for human review.

## Available Tools

| Tool | Purpose |
| :--- | :--- |
| `explain_query` | Runs `EXPLAIN (FORMAT JSON)` (optional `ANALYZE` & `BUFFERS`) and flags sequential scans and row estimation skew. |
| `find_missing_indexes` | Inspects `pg_stat_user_tables` to rank tables with heavy sequential scans and low index usage. |
| `suggest_index` | Checks existing `pg_indexes` and `pg_stats` to recommend non-blocking `CREATE INDEX CONCURRENTLY` DDL. |
| `get_slow_queries` | Reads `pg_stat_statements` to surface slowest queries by total time, mean time, or call count, including buffer cache hit ratio. |

## Quick Start

### 1. Install & Build

```bash
npm install
npm run build
npm test
```

### 2. Optional Local Demo Database (Docker)

```bash
docker compose up -d
```

This starts PostgreSQL 16 on `localhost:5432` (`postgres/postgres`, database `auditor_demo`) with `pg_stat_statements` enabled and 41,000 seeded rows across `users`, `orders`, and `transactions` with intentional missing indexes.

### 3. Configure in Claude Desktop / Cursor / Claude Code

```json
{
  "mcpServers": {
    "pg-auditor": {
      "command": "node",
      "args": ["/absolute/path/to/pg-auditor-mcp/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://postgres:postgres@localhost:5432/auditor_demo",
        "PG_STATEMENT_TIMEOUT_MS": "5000"
      }
    }
  }
}
```

## Environment Variables

- `DATABASE_URL`: PostgreSQL connection string (or standard `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`).
- `PG_STATEMENT_TIMEOUT_MS`: Per-query `statement_timeout` in milliseconds (default `5000`, max `60000`).

## License

MIT
