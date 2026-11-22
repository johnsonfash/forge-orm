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
//   'single quoted'      '' doubles a quote; E'…' (postgres) and every
//                        '…' on mysql also take backslash escapes
//   "double quoted"      "" doubles a quote (an identifier on postgres)
//   `backticks`          mysql / sqlite identifiers
//   $tag$ … $tag$        postgres dollar quotes, any tag, including $$
//   -- line comment      to end of line (mysql also: #)
//   /* block comment */  nested on postgres, as the server nests them
//   BEGIN ATOMIC … END   a SQL-standard function body (postgres 14+), whose
//                        statements end in unquoted semicolons; CASE … END
//                        inside it is counted so its END does not close it

export type SplitDialect = 'postgres' | 'mysql' | 'sqlite' | 'generic';

export interface SplitStatement {
  /** The statement, with leading whitespace and comments removed. */
  sql: string;
  /** 1-based line the statement starts on in the original text. */
  line: number;
}

const isIdentChar = (c: string | undefined): boolean =>
  !!c && /[A-Za-z0-9_$\u0080-￿]/.test(c);
const isTagStart = (c: string | undefined): boolean =>
  !!c && /[A-Za-z_\u0080-￿]/.test(c);
const isTagChar = (c: string | undefined): boolean =>
  !!c && /[A-Za-z0-9_\u0080-￿]/.test(c);

/**
 * Split a SQL script into statements, honouring quotes, comments, dollar
 * quotes and `BEGIN ATOMIC` bodies. Statements that are only comments or
 * whitespace are dropped.
 *
 * An unterminated quote or comment is not an error here: the remaining text
 * becomes the last statement and the server reports it with its own message
 * and position, which is more useful than anything a lexer could say.
 */
export function splitSqlStatements(text: string, dialect: SplitDialect = 'generic'): SplitStatement[] {
  const out: SplitStatement[] = [];
  const pg = dialect === 'postgres';
  const my = dialect === 'mysql';
  const n = text.length;
  let i = 0;
  let start = 0;
  // Tokens of the current statement, upper-cased, outside quotes/comments —
  // only the last two are needed to see `BEGIN ATOMIC`, and CASE/END inside.
  let prevWord = '';
  let atomicDepth = 0;

  const flush = (end: number) => {
    const raw = text.slice(start, end);
    const lead = leadingTrivia(raw, dialect);
    const sql = raw.slice(lead).trim();
    if (sql.length > 0) {
      const line = 1 + countNewlines(text, 0, start + lead);
      out.push({ sql, line });
    }
    start = end + 1;
    prevWord = '';
    atomicDepth = 0;
  };

  while (i < n) {
    const c = text[i]!;
    const next = text[i + 1];

    if (c === '-' && next === '-') { i = skipLine(text, i); continue; }
    if (my && c === '#') { i = skipLine(text, i); continue; }
    if (c === '/' && next === '*') { i = skipBlockComment(text, i, pg); continue; }

    if (c === "'") {
      const prev = text[i - 1];
      const escapes = my || (pg && (prev === 'E' || prev === 'e') && !isIdentChar(text[i - 2]));
      i = skipQuoted(text, i, "'", escapes);
      prevWord = '';
      continue;
    }
    if (c === '"') { i = skipQuoted(text, i, '"', my); prevWord = ''; continue; }
    if (c === '`' && !pg) { i = skipQuoted(text, i, '`', false); prevWord = ''; continue; }

    if (pg && c === '$' && !isIdentChar(text[i - 1])) {
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
      while (j < n && isIdentChar(text[j])) j++;
      const word = text.slice(i, j).toUpperCase();
      if (pg) {
        if (word === 'ATOMIC' && prevWord === 'BEGIN') atomicDepth++;
        else if (atomicDepth > 0 && word === 'CASE') atomicDepth++;
        else if (atomicDepth > 0 && word === 'END') atomicDepth--;
      }
      prevWord = word;
      i = j;
      continue;
    }

    if (c === ';' && atomicDepth === 0) { flush(i); i++; continue; }
    i++;
  }
  if (start < n) flush(n);
  return out;
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

/** Length of the leading whitespace + comments of a chunk. */
function leadingTrivia(s: string, dialect: SplitDialect): number {
  let i = 0;
  for (;;) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (s[i] === '-' && s[i + 1] === '-') { i = skipLine(s, i); continue; }
    if (dialect === 'mysql' && s[i] === '#') { i = skipLine(s, i); continue; }
    if (s[i] === '/' && s[i + 1] === '*') { i = skipBlockComment(s, i, dialect === 'postgres'); continue; }
    return i;
  }
}

function countNewlines(s: string, from: number, to: number): number {
  let k = 0;
  for (let i = from; i < to; i++) if (s.charCodeAt(i) === 10) k++;
  return k;
}
