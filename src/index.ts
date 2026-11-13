#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { closeSharedPool, getSharedPool } from './db/pool.js';
import { createAuditorServer } from './server.js';

async function main(): Promise<void> {
  const pool = getSharedPool();
  const server = createAuditorServer(pool);
  const transport = new StdioServerTransport();

  const shutdown = async () => {
    await server.close().catch(() => undefined);
    await closeSharedPool().catch(() => undefined);
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });

  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal error in pg-auditor-mcp:', error);
  process.exit(1);
});
