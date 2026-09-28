export const DESTRUCTIVE_STATEMENT_KINDS = [
  'DROP_TABLE',
  'DROP_COLUMN',
  'DROP_SCHEMA',
  'DROP_TYPE',
  'DROP_VIEW',
  'RENAME',
  'ALTER_COLUMN_TYPE',
  'SET_NOT_NULL',
  'TRUNCATE',
] as const;

export type DestructiveStatementKind = (typeof DESTRUCTIVE_STATEMENT_KINDS)[number];

export interface DestructiveFinding {
  readonly kind: DestructiveStatementKind;
  readonly excerpt: string;
}

const PATTERNS: readonly { readonly kind: DestructiveStatementKind; readonly pattern: RegExp }[] = [
  { kind: 'DROP_TABLE', pattern: /\bDROP\s+(?:FOREIGN\s+)?TABLE\b/gi },
  { kind: 'DROP_COLUMN', pattern: /\bDROP\s+COLUMN\b/gi },
  { kind: 'DROP_SCHEMA', pattern: /\bDROP\s+SCHEMA\b/gi },
  { kind: 'DROP_TYPE', pattern: /\bDROP\s+(?:TYPE|DOMAIN)\b/gi },
  { kind: 'DROP_VIEW', pattern: /\bDROP\s+(?:MATERIALIZED\s+)?VIEW\b/gi },
  { kind: 'RENAME', pattern: /\bRENAME\s+(?:COLUMN\s+|CONSTRAINT\s+)?(?:TO\b|[\w"]+\s+TO\b)/gi },
  { kind: 'ALTER_COLUMN_TYPE', pattern: /\bALTER\s+COLUMN\s+[\w"]+\s+(?:SET\s+DATA\s+)?TYPE\b/gi },
  { kind: 'SET_NOT_NULL', pattern: /\bSET\s+NOT\s+NULL\b/gi },
  { kind: 'TRUNCATE', pattern: /\bTRUNCATE\b/gi },
];

const DOLLAR_TAG = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/;

export function stripSqlLiteralsAndComments(sqlText: string): string {
  let output = '';
  let index = 0;
  const length = sqlText.length;

  while (index < length) {
    const current = sqlText.charAt(index);
    const next = sqlText.charAt(index + 1);

    if (current === '-' && next === '-') {
      const end = sqlText.indexOf('\n', index);
      index = end === -1 ? length : end;
      continue;
    }

    if (current === '/' && next === '*') {
      let depth = 1;
      index += 2;
      while (index < length && depth > 0) {
        if (sqlText.charAt(index) === '/' && sqlText.charAt(index + 1) === '*') {
          depth += 1;
          index += 2;
        } else if (sqlText.charAt(index) === '*' && sqlText.charAt(index + 1) === '/') {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      output += ' ';
      continue;
    }

    if (current === "'") {
      index += 1;
      while (index < length) {
        if (sqlText.charAt(index) === "'") {
          if (sqlText.charAt(index + 1) === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      output += "''";
      continue;
    }

    if (current === '"') {
      const end = sqlText.indexOf('"', index + 1);
      index = end === -1 ? length : end + 1;
      output += '"_"';
      continue;
    }

    if (current === '$') {
      const tag = DOLLAR_TAG.exec(sqlText.slice(index, index + 64));
      if (tag !== null) {
        const end = sqlText.indexOf(tag[0], index + tag[0].length);
        index = end === -1 ? length : end + tag[0].length;
        output += ' $$ ';
        continue;
      }
    }

    output += current;
    index += 1;
  }

  return output;
}

export function detectDestructiveStatements(sqlText: string): readonly DestructiveFinding[] {
  const code = stripSqlLiteralsAndComments(sqlText);
  const findings: DestructiveFinding[] = [];
  for (const { kind, pattern } of PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      const start = Math.max(0, match.index - 40);
      const end = Math.min(code.length, match.index + match[0].length + 40);
      findings.push({ kind, excerpt: code.slice(start, end).replace(/\s+/g, ' ').trim() });
    }
  }
  return findings;
}
