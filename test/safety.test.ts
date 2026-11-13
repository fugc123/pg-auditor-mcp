import { describe, expect, it } from 'vitest';
import { isValidIdentifier, validateReadOnlySql } from '../src/db/safety.js';

describe('validateReadOnlySql', () => {
  it('accepts a simple SELECT query and strips trailing semicolon', () => {
    const res = validateReadOnlySql('  SELECT id, email FROM users WHERE active = true;  ');
    expect(res.valid).toBe(true);
    expect(res.sanitizedSql).toBe('SELECT id, email FROM users WHERE active = true');
  });

  it('accepts CTE (WITH) read-only queries', () => {
    const res = validateReadOnlySql(`
      WITH recent_orders AS (
        SELECT user_id, total FROM orders WHERE created_at > NOW() - INTERVAL '7 days'
      )
      SELECT user_id, SUM(total) FROM recent_orders GROUP BY user_id
    `);
    expect(res.valid).toBe(true);
    expect(res.sanitizedSql).toContain('WITH recent_orders AS');
  });

  it('rejects empty queries', () => {
    expect(validateReadOnlySql('   ').valid).toBe(false);
    expect(validateReadOnlySql('').valid).toBe(false);
  });

  it('rejects multiple statements separated by semicolon', () => {
    const res = validateReadOnlySql('SELECT 1; DROP TABLE users');
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/multiple/i);
  });

  it('rejects DML and DDL statements', () => {
    const forbidden = [
      'INSERT INTO users (name) VALUES (\'x\')',
      'UPDATE users SET active = false',
      'DELETE FROM users WHERE id = 1',
      'DROP TABLE users',
      'ALTER TABLE users ADD COLUMN foo TEXT',
      'TRUNCATE users',
      'CREATE INDEX idx_x ON users(id)',
      'GRANT ALL ON users TO public',
    ];

    for (const sql of forbidden) {
      const res = validateReadOnlySql(sql);
      expect(res.valid).toBe(false);
    }
  });

  it('rejects CTEs containing mutating keywords', () => {
    const res = validateReadOnlySql('WITH deleted AS (DELETE FROM orders RETURNING *) SELECT * FROM deleted');
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/DELETE/i);
  });

  it('rejects SELECT ... INTO table creation', () => {
    const res = validateReadOnlySql('SELECT * INTO temp_users FROM users');
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/SELECT INTO/i);
  });

  it('rejects SELECT ... FOR UPDATE locking', () => {
    const res = validateReadOnlySql('SELECT * FROM orders WHERE id = 1 FOR UPDATE');
    expect(res.valid).toBe(false);
    expect(res.reason).toMatch(/row-level locking/i);
  });

  it('ignores keywords inside string literals and comments', () => {
    const res = validateReadOnlySql(`
      -- DELETE comment should be ignored
      SELECT 'DELETE FROM users' AS label, /* DROP TABLE */ id FROM orders
    `);
    expect(res.valid).toBe(true);
  });
});

describe('isValidIdentifier', () => {
  it('accepts valid PostgreSQL identifiers', () => {
    expect(isValidIdentifier('users')).toBe(true);
    expect(isValidIdentifier('public')).toBe(true);
    expect(isValidIdentifier('order_items_2025')).toBe(true);
    expect(isValidIdentifier('_private_col')).toBe(true);
  });

  it('rejects invalid or unsafe identifiers', () => {
    expect(isValidIdentifier('')).toBe(false);
    expect(isValidIdentifier('123abc')).toBe(false);
    expect(isValidIdentifier('users; DROP TABLE users')).toBe(false);
    expect(isValidIdentifier('users.orders')).toBe(false);
    expect(isValidIdentifier('user-name')).toBe(false);
  });
});
