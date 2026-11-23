// A SQL statement splitter that knows where a `;` is NOT a statement end.
//
// Splitting on `;` + newline cut every plpgsql function in half: a trigger
// function body is `$$ … NEW.updated_at := now(); RETURN NEW; END; $$`, and
// each of those semicolons became a statement boundary. The same split broke
// a `;` inside a string literal, a comment, and a quoted identifier.
//
// This is a lexer, not a parser. It tracks exactly the states in which a
// semicolon is text rather than a terminator:
//
//   'single quoted'      '' doubles a quote; E'…' (postgres, duckdb) and
//                        every '…' and "…" on mysql take backslash escapes
//   "double quoted"      "" doubles a quote
//   `backticks`          mysql / sqlite identifiers
//   [brackets]           sqlite / mssql identifiers, ]] doubles a bracket
//   $tag$ … $tag$        postgres / duckdb dollar quotes, any tag
//   -- line comment      to end of line; on mysql only when followed by a
//                        space (`1--1` is arithmetic there); mysql also: #
//   /* block comment */  nested on postgres and mssql, as those servers
//                        nest them; mysql `/*! … */` is code, not a comment
//   BEGIN ATOMIC … END   a SQL-standard function body (postgres 14+)
//   CREATE TRIGGER / PROCEDURE / FUNCTION / EVENT … BEGIN … END
//                        a routine body (mysql, sqlite), whose statements
//                        end in semicolons; CASE … END inside it is counted
//   DELIMITER $$         the mysql client command: until the next
//                        DELIMITER line, `$$` ends a statement and `;`
//                        does not. The DELIMITER lines themselves are not
//                        statements and are dropped.
//   GO                   mssql: a line holding only GO ends a batch, and
//                        `;` does not split. A batch is what SQL Server
//                        takes in one request; CREATE PROCEDURE and
//                        CREATE VIEW must be alone in theirs.

export type SplitDialect = 'postgres' | 'mysql' | 'sqlite' | 'mssql' | 'duckdb' | 'generic';

export interface SplitStatement {
  /** The statement, with leading whitespace and comments removed. */
  sql: string;
  /** 1-based line the statement starts on in the original text. */
  line: number;
  /** mssql: the count after `GO n`, when one was given. */
  repeat?: number;
}

const isIdentChar = (c: string | undefined): boolean =>
  !!c && /[A-Za-z0-9_$\u0080-￿]/.test(c);
const isTagStart = (c: string | undefined): boolean =>
  !!c && /[A-Za-z_\u0080-￿]/.test(c);
const isTagChar = (c: string | undefined): boolean =>
  !!c && /[A-Za-z0-9_\u0080-￿]/.test(c);

const OBJECT_KINDS = new Set([
  'TABLE', 'VIEW', 'INDEX', 'TRIGGER', 'PROCEDURE', 'FUNCTION', 'EVENT', 'SCHEMA',
  'DATABASE', 'SEQUENCE', 'USER', 'ROLE', 'SERVER', 'TABLESPACE', 'TYPE', 'DOMAIN',
]);
const ROUTINE_KINDS = new Set(['TRIGGER', 'PROCEDURE', 'FUNCTION', 'EVENT']);
// `END IF`, `END LOOP`, … close a block that did not open with BEGIN or CASE.
const END_WITHOUT_DEPTH = new Set(['IF', 'LOOP', 'WHILE', 'REPEAT']);

interface Flags {
  pg: boolean;      // postgres-family lexing: dollar quotes, E'' strings
  atomic: boolean;  // BEGIN ATOMIC bodies
  my: boolean;
  lite: boolean;
  ms: boolean;
}

function flagsFor(dialect: SplitDialect): Flags {
  return {
    pg: dialect === 'postgres' || dialect === 'duckdb',
    atomic: dialect === 'postgres',
    my: dialect === 'mysql',
    lite: dialect === 'sqlite',
    ms: dialect === 'mssql',
  };
}

/**
 * Split a SQL script into statements (mssql: batches), honouring quotes,
 * comments, dollar quotes, routine bodies, `DELIMITER` and `GO`.
 * Statements that are only comments or whitespace are dropped.
 *
 * An unterminated quote or comment is not an error here: the remaining text
 * becomes the last statement and the server reports it with its own message
 * and position, which is more useful than anything a lexer could say.
 */
export function splitSqlStatements(text: string, dialect: SplitDialect = 'generic'): SplitStatement[] {
  const out: SplitStatement[] = [];
  const fl = flagsFor(dialect);
  const n = text.length;
  let i = 0;
  let start = 0;
  let prevWord = '';
  let atomicDepth = 0;
  // Routine bodies (mysql, sqlite): the first words of the statement decide
  // whether a BEGIN opens one.
  let head: string[] = [];
  let routineDepth = 0;
  let delim = ';';

  const routine = (): boolean => {
    if (head[0] !== 'CREATE') return false;
    const kind = head.slice(1).find((w) => OBJECT_KINDS.has(w));
    if (!kind) return false;
    return fl.lite ? kind === 'TRIGGER' : ROUTINE_KINDS.has(kind);
  };

  const flush = (end: number, resume: number, repeat?: number) => {
    const raw = text.slice(start, end);
    const lead = leadingTrivia(raw, fl);
    const sql = raw.slice(lead).trim();
    if (sql.length > 0) {
      const line = 1 + countNewlines(text, 0, start + lead);
      out.push(repeat != null ? { sql, line, repeat } : { sql, line });
    }
    start = resume;
    prevWord = '';
    atomicDepth = 0;
    head = [];
    routineDepth = 0;
  };

  while (i < n) {
    const c = text[i]!;
    const next = text[i + 1];

    if (fl.my && delim !== ';' && text.startsWith(delim, i)) {
      flush(i, i + delim.length);
      i += delim.length;
      continue;
    }

    if (c === '-' && next === '-' && (!fl.my || isSpaceOrEnd(text[i + 2]))) { i = skipLine(text, i); continue; }
    if (fl.my && c === '#') { i = skipLine(text, i); continue; }
    if (c === '/' && next === '*') { i = skipBlockComment(text, i, fl.pg || fl.ms); continue; }

    if (c === "'") {
      const prev = text[i - 1];
      const escapes = fl.my || (fl.pg && (prev === 'E' || prev === 'e') && !isIdentChar(text[i - 2]));
      i = skipQuoted(text, i, "'", escapes);
      prevWord = '';
      continue;
    }
    if (c === '"') { i = skipQuoted(text, i, '"', fl.my); prevWord = ''; continue; }
    if (c === '`' && !fl.pg && !fl.ms) { i = skipQuoted(text, i, '`', false); prevWord = ''; continue; }
    if (c === '[' && (fl.lite || fl.ms)) { i = skipQuoted(text, i, ']', false); prevWord = ''; continue; }

    if (fl.pg && c === '$' && !isIdentChar(text[i - 1])) {
      const tagEnd = dollarTagEnd(text, i);
      if (tagEnd !== -1) {
        const tag = text.slice(i, tagEnd + 1);
        const close = text.indexOf(tag, tagEnd + 1);
        i = close === -1 ? n : close + tag.length;
        prevWord = '';
        continue;
      }
    }

    if (isTagStart(c) && !isIdentChar(text[i - 1])) {
      let j = i + 1;
      // `END$$` is one word to the identifier rules, and a statement end to
      // DELIMITER $$.
      while (j < n && isIdentChar(text[j]) && !(fl.my && delim !== ';' && text.startsWith(delim, j))) j++;
      const word = text.slice(i, j).toUpperCase();

      if (fl.my && word === 'DELIMITER' && onlyTrivia(text.slice(start, i), fl)) {
        const eol = text.indexOf('\n', j);
        const lineEnd = eol === -1 ? n : eol;
        const token = text.slice(j, lineEnd).trim().split(/\s+/)[0];
        if (token) {
          const resume = lineEnd === n ? n : lineEnd + 1;
          flush(i, resume);
          delim = token;
          i = resume;
          continue;
        }
      }

      if (fl.ms && word === 'GO' && atLineStart(text, i)) {
        const eol = text.indexOf('\n', j);
        const lineEnd = eol === -1 ? n : eol;
        const rest = /^[ \t]*(\d+)?[ \t]*(?:--.*)?\r?$/.exec(text.slice(j, lineEnd));
        if (rest) {
          const lineStart = text.lastIndexOf('\n', i - 1) + 1;
          const resume = lineEnd === n ? n : lineEnd + 1;
          flush(lineStart, resume, rest[1] ? Number(rest[1]) : undefined);
          i = resume;
          continue;
        }
      }

      if (head.length < 12) head.push(word);
      if (fl.atomic) {
        if (word === 'ATOMIC' && prevWord === 'BEGIN') atomicDepth++;
        else if (atomicDepth > 0 && word === 'CASE') atomicDepth++;
        else if (atomicDepth > 0 && word === 'END') atomicDepth--;
      }
      if ((fl.my || fl.lite) && delim === ';') {
        if (word === 'BEGIN' && (routineDepth > 0 || routine())) routineDepth++;
        else if (routineDepth > 0 && word === 'CASE') routineDepth++;
        else if (routineDepth > 0 && word === 'END' && !END_WITHOUT_DEPTH.has(nextWord(text, j))) routineDepth--;
      }
      prevWord = word;
      i = j;
      continue;
    }

    if (c === ';' && !fl.ms && delim === ';' && atomicDepth === 0 && routineDepth === 0) {
      flush(i, i + 1);
      i++;
      continue;
    }
    i++;
  }
  if (start < n) flush(n, n);
  return out;
}

/**
 * The text with every string, quoted identifier and comment blanked to
 * spaces (newlines kept), so a keyword search over it cannot match inside
 * one. mysql `/*! … *\/` bodies are kept, since the server runs them.
 */
export function maskSqlLiterals(text: string, dialect: SplitDialect = 'generic'): string {
  const fl = flagsFor(dialect);
  const chars = text.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < chars.length; k++) if (chars[k] !== '\n') chars[k] = ' ';
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    const next = text[i + 1];
    let end = -1;
    if (c === '-' && next === '-' && (!fl.my || isSpaceOrEnd(text[i + 2]))) end = skipLine(text, i);
    else if (fl.my && c === '#') end = skipLine(text, i);
    else if (c === '/' && next === '*' && !(fl.my && text[i + 2] === '!')) end = skipBlockComment(text, i, fl.pg || fl.ms);
    else if (c === "'") {
      const prev = text[i - 1];
      end = skipQuoted(text, i, "'", fl.my || (fl.pg && (prev === 'E' || prev === 'e')));
    } else if (c === '"') end = skipQuoted(text, i, '"', fl.my);
    else if (c === '`' && !fl.pg && !fl.ms) end = skipQuoted(text, i, '`', false);
    else if (c === '[' && (fl.lite || fl.ms)) end = skipQuoted(text, i, ']', false);
    else if (fl.pg && c === '$' && !isIdentChar(text[i - 1])) {
      const tagEnd = dollarTagEnd(text, i);
      if (tagEnd !== -1) {
        const tag = text.slice(i, tagEnd + 1);
        const close = text.indexOf(tag, tagEnd + 1);
        end = close === -1 ? n : close + tag.length;
      }
    }
    if (end === -1) { i++; continue; }
    blank(i, end);
    i = end;
  }
  return chars.join('');
}

function isSpaceOrEnd(c: string | undefined): boolean {
  return c === undefined || /\s/.test(c);
}

function atLineStart(text: string, i: number): boolean {
  for (let k = i - 1; k >= 0; k--) {
    const ch = text[k]!;
    if (ch === '\n') return true;
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

function nextWord(text: string, from: number): string {
  let k = from;
  while (k < text.length && /\s/.test(text[k]!)) k++;
  let j = k;
  while (j < text.length && isIdentChar(text[j])) j++;
  return text.slice(k, j).toUpperCase();
}

/** `$tag$` starting at `i` → index of its closing `$`, or -1 if not a tag. */
function dollarTagEnd(text: string, i: number): number {
  const first = text[i + 1];
  if (first === '$') return i + 1;
  if (!isTagStart(first)) return -1;
  let j = i + 2;
  while (j < text.length && isTagChar(text[j])) j++;
  return text[j] === '$' ? j : -1;
}

function skipLine(text: string, i: number): number {
  const nl = text.indexOf('\n', i);
  return nl === -1 ? text.length : nl + 1;
}

function skipBlockComment(text: string, i: number, nested: boolean): number {
  let depth = 1;
  let j = i + 2;
  while (j < text.length) {
    if (nested && text[j] === '/' && text[j + 1] === '*') { depth++; j += 2; continue; }
    if (text[j] === '*' && text[j + 1] === '/') {
      depth--;
      j += 2;
      if (depth === 0 || !nested) return j;
      continue;
    }
    j++;
  }
  return text.length;
}

function skipQuoted(text: string, i: number, q: string, backslash: boolean): number {
  let j = i + 1;
  while (j < text.length) {
    const ch = text[j];
    if (backslash && ch === '\\') { j += 2; continue; }
    if (ch === q) {
      if (text[j + 1] === q) { j += 2; continue; }
      return j + 1;
    }
    j++;
  }
  return text.length;
}

function onlyTrivia(s: string, fl: Flags): boolean {
  return leadingTrivia(s, fl) >= s.length;
}

/** Length of the leading whitespace + comments of a chunk. */
function leadingTrivia(s: string, fl: Flags): number {
  let i = 0;
  for (;;) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (s[i] === '-' && s[i + 1] === '-' && (!fl.my || isSpaceOrEnd(s[i + 2]))) { i = skipLine(s, i); continue; }
    if (fl.my && s[i] === '#') { i = skipLine(s, i); continue; }
    if (s[i] === '/' && s[i + 1] === '*' && !(fl.my && s[i + 2] === '!')) {
      i = skipBlockComment(s, i, fl.pg || fl.ms);
      continue;
    }
    return i;
  }
}

function countNewlines(s: string, from: number, to: number): number {
  let k = 0;
  for (let i = from; i < to; i++) if (s.charCodeAt(i) === 10) k++;
  return k;
}
