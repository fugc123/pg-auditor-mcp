# ODD Feature: pg-auditor-mcp-mvp

## Objective
Build an open-source, production-grade PostgreSQL Query & Index Auditor MCP Server (`pg-auditor-mcp`) in TypeScript with strict read-only guardrails, 4 diagnostic tools, unit tests, Docker demo environment, and a portfolio-ready README.

## Problem & Why
Generic PostgreSQL MCP servers allow arbitrary SQL execution and lack specialized diagnostics for query performance. A dedicated, read-only performance auditor showcases deep PostgreSQL internals (`EXPLAIN ANALYZE`, `pg_stat_user_tables`, `pg_stats`, `CREATE INDEX CONCURRENTLY`), security-first engineering, and modern AI Agent tooling (MCP).

## Scope & Constraints
- Language/Runtime: TypeScript (Node.js 24, ESM), `@modelcontextprotocol/sdk`, `pg`, `zod`, `vitest`.
- Security: 100% read-only enforcement via SQL guard + `BEGIN READ ONLY` + `statement_timeout`.
- TDD Mode: Off (no existing project config); verify every task with `npm run build` and `npm test` (Vitest).
- Delivery Strategy: `single-pr` / local feature branch (`feat/mvp-auditor`).

## Actionable Checklist
- [x] **T1**: Initialize Git repository, `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, and install dependencies. (verified: `npm install` added 162 packages, exit 0)
- [x] **T2**: Implement SQL read-only safety validator (`src/db/safety.ts`) and read-only transaction pool wrapper (`src/db/pool.ts`) with unit tests. (verified: `test/safety.test.ts` 11/11 passed)
- [x] **T3**: Implement the 4 MCP tools (`explain_query`, `find_missing_indexes`, `suggest_index`, `get_slow_queries`) and MCP server registration (`src/server.ts`, `src/index.ts`) with unit tests. (verified: `npm run build` + `npm test` 21/21 passed; T1+T2 commit `58d7620`)
- [ ] **T4**: Add `docker-compose.yml` + `docker/init.sql` (Postgres 16 + `pg_stat_statements` + unindexed sample tables) and comprehensive `README.md`, then run full build & test verification.

## Acceptance Criteria
1. `npm run build` compiles cleanly with zero TypeScript errors.
2. `npm test` passes all unit tests covering SQL safety guardrails, EXPLAIN plan parsing, and tool logic.
3. `docker-compose.yml` defines a ready-to-run PostgreSQL 16 instance with `pg_stat_statements` and realistic unindexed data for immediate demos.

## Progress & Evidence
- Initialized feature task document.
- Next step: T1 (repo & toolchain initialization).
