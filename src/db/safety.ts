const FORBIDDEN_KEYWORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'TRUNCATE',
  'CREATE',
  'REPLACE',
  'GRANT',
  'REVOKE',
  'VACUUM',
  'ANALYZE',
  'CLUSTER',
  'REINDEX',
  'COPY',
  'CALL',
  'DO',
  'EXECUTE',
  'PREPARE',
  'LOCK',
  'SET',
  'COMMIT',
  'ROLLBACK',
  'BEGIN',
  'START',
]);

const ALLOWED_START_KEYWORDS = new Set(['SELECT', 'WITH']);

export interface SqlValidationResult {
  valid: boolean;
  reason?: string;
  sanitizedSql?: string;
}

/**
 * Strips single-quoted string literals and SQL comments so keyword/semicolon
 * inspection cannot be bypassed or triggered by literal values.
 */
function stripCommentsAndStrings(sql: string): string {
  // Replace single-quoted string literals (handling escaped '') with empty ''
  const withoutStrings = sql.replace(/'([^']|'')*'/g, "''");
  // Remove block comments /* ... */
  const withoutBlockComments = withoutStrings.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Remove line comments -- ...
  return withoutBlockComments.replace(/--[^\r\n]*/g, ' ');
}

/**
 * Validates that a user-provided SQL query is a single, strictly read-only
 * SELECT or CTE (WITH ... SELECT) statement.
 */
export function validateReadOnlySql(rawSql: string): SqlValidationResult {
  const trimmed = rawSql.trim();
  if (!trimmed) {
    return { valid: false, reason: 'SQL query cannot be empty.' };
  }

  // Strip a single trailing semicolon if present
  const withoutTrailingSemicolon = trimmed.replace(/;\s*$/, '');
  const stripped = stripCommentsAndStrings(withoutTrailingSemicolon).trim();

  if (!stripped) {
    return { valid: false, reason: 'SQL query contains only comments.' };
  }

  if (stripped.includes(';')) {
    return {
      valid: false,
      reason: 'Multiple SQL statements are not allowed.',
    };
  }

  const tokens = stripped.toUpperCase().match(/[A-Z_][A-Z0-9_]*/g) ?? [];
  if (tokens.length === 0) {
    return { valid: false, reason: 'No valid SQL keywords found.' };
  }

  const firstKeyword = tokens[0];
  if (!ALLOWED_START_KEYWORDS.has(firstKeyword)) {
    return {
      valid: false,
      reason: `Only SELECT or WITH queries are permitted. Found: ${firstKeyword}.`,
    };
  }

  if (/\bSELECT\b[\s\S]*\bINTO\b/i.test(stripped)) {
    return {
      valid: false,
      reason: 'SELECT INTO is not allowed because it creates a new table.',
    };
  }

  if (/\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE|KEY\s+SHARE)\b/i.test(stripped)) {
    return {
      valid: false,
      reason: 'Row-level locking clauses (FOR UPDATE / FOR SHARE) are not allowed.',
    };
  }

  for (const token of tokens) {
    if (FORBIDDEN_KEYWORDS.has(token)) {
      return {
        valid: false,
        reason: `Forbidden SQL keyword detected: ${token}. Only read-only queries are allowed.`,
      };
    }
  }

  return { valid: true, sanitizedSql: withoutTrailingSemicolon };
}

/**
 * Validates PostgreSQL identifiers (schema, table, column names) to prevent injection.
 */
export function isValidIdentifier(identifier: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_$]{0,62}$/.test(identifier);
}
