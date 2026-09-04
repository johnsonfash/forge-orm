// Build the docs site's pages from the markdown that already exists.
//
// The .md files stay the source of truth — README.md, CHANGELOG.md and
// the 83 files in docs/ are what npm and GitHub render, and nothing here
// edits them. This script copies them into the VitePress source tree and
// rearranges them for the web, which is the part a README cannot do:
//
//   * README.md is 2,987 lines. As one page it is the same endless scroll
//     the site is meant to replace, so it is split at its own `##`
//     headings into one page per section.
//   * Its "Contents" list is dropped: a sidebar does that job better, and
//     keeping both means keeping both in sync.
//   * Its "Deep-dive companions" tables ARE the reference sidebar. Parsing
//     them means the site's navigation cannot drift from the README's own
//     organisation — there is only one list, and it is the one already
//     maintained.
//   * Every relative link is rewritten to a site route, including the
//     `[…](#anchor)` links inside the README, which now often point at a
//     heading on a different page.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const SRC = path.join(HERE, 'src');
const OUT_GUIDE = path.join(SRC, 'guide');
const OUT_REF = path.join(SRC, 'reference');

// ── helpers ───────────────────────────────────────────────────────────

/** GitHub's heading-anchor rules, which is what the existing links use. */
function slug(text) {
  return text
    .replace(/`/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s/g, '-');
}

/** Split markdown into lines tagged with whether they're inside a fence. */
function* scan(md) {
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) {
      yield { line, fence: true };
      fence = !fence;
      continue;
    }
    yield { line, fence };
  }
}

function headings(md, levels = [2, 3]) {
  const out = [];
  for (const { line, fence } of scan(md)) {
    if (fence) continue;
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m && levels.includes(m[1].length)) out.push({ level: m[1].length, text: m[2] });
  }
  return out;
}

const rm = (p) => fs.rmSync(p, { recursive: true, force: true });
const mk = (p) => fs.mkdirSync(p, { recursive: true });

// ── 1. read the sources ───────────────────────────────────────────────

const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
const changelog = fs.readFileSync(path.join(REPO, 'CHANGELOG.md'), 'utf8');
const docFiles = fs
  .readdirSync(path.join(REPO, 'docs'))
  .filter((f) => f.endsWith('.md'))
  .sort();

// ── 2. the reference sidebar, parsed from the README's own tables ─────
//
// The "Deep-dive companions" section is a series of `**Group**` labels
// followed by tables whose second column links to docs/NAME.md. That is
// already a curated, grouped index of all 83 files — so it becomes the
// sidebar rather than a second list to maintain.

function parseCompanions(md) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => /^###\s+Deep-dive companions/.test(l));
  if (start === -1) throw new Error('sync: "Deep-dive companions" section not found in README');
  const groups = [];
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^##\s+/.test(l)) break;                       // next top-level section
    const label = /^\*\*(.+?)\*\*\s*$/.exec(l);
    if (label) {
      current = { text: label[1], items: [] };
      groups.push(current);
      continue;
    }
    // | Topic … | **[docs/NAME.md](docs/NAME.md)** |
    const row = /\|\s*(.+?)\s*\|\s*.*?\(docs\/([A-Z0-9-]+\.md)\)/i.exec(l);
    if (row && current) {
      const file = row[2];
      const topic = row[1].replace(/\*\*/g, '').split('—')[0].trim();
      if (/^topic$/i.test(topic)) continue;            // table header
      current.items.push({ text: topic, file });
    }
  }
  return groups.filter((g) => g.items.length);
}

const companionGroups = parseCompanions(readme);
const referencedFiles = new Set(companionGroups.flatMap((g) => g.items.map((i) => i.file)));

// Anything in docs/ the README never listed still gets a page and a home,
// rather than existing on disk and nowhere in the navigation.
const orphans = docFiles.filter((f) => !referencedFiles.has(f));
if (orphans.length) {
  companionGroups.push({
    text: 'Also in docs/',
    items: orphans.map((f) => ({ text: f.replace(/\.md$/, ''), file: f })),
  });
}

// ── 3. split the README into one page per `##` section ───────────────

const SKIP_SECTIONS = new Set(['contents']);           // the sidebar is this

function splitReadme(md) {
  const lines = [...scan(md)];
  const sections = [];
  let intro = [];
  let cur = null;
  for (const { line, fence } of lines) {
    const m = !fence && /^##\s+(.*)$/.exec(line);
    if (m) {
      if (cur) sections.push(cur);
      cur = { title: m[1], body: [] };
      continue;
    }
    (cur ? cur.body : intro).push(line);
  }
  if (cur) sections.push(cur);
  return { intro: intro.join('\n'), sections };
}

const { intro, sections } = splitReadme(readme);
const guidePages = sections
  .filter((s) => !SKIP_SECTIONS.has(slug(s.title)))
  .map((s) => ({ ...s, slug: slug(s.title) }));

// ── 4. where every anchor ended up ───────────────────────────────────
//
// README links like `[x](#defining-a-schema)` used to be same-page jumps.
// After the split the target usually lives on a different page, so each
// heading's slug is mapped to the route that now contains it.

const anchorHome = new Map();
for (const p of guidePages) {
  anchorHome.set(p.slug, `/guide/${p.slug}`);
  for (const h of headings(p.body.join('\n'), [3, 4])) {
    if (!anchorHome.has(slug(h.text))) anchorHome.set(slug(h.text), `/guide/${p.slug}`);
  }
}

// ── 4b. angle brackets ───────────────────────────────────────────────
//
// VitePress compiles markdown as a Vue template, so a bare `<something>`
// in prose is parsed as an HTML element — and `_<table>` or `Promise<void>`
// opens a tag that never closes, which fails the whole build with a
// position pointing at some unrelated line further down.
//
// Real HTML in the markdown has to survive (the README centres its badge
// block in a <div>), so the rule is: keep it only when it looks like
// markup — a known element name, at a line start or after whitespace.
// Everything else is a placeholder and gets escaped.

const HTML_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'details', 'div', 'em', 'h1', 'h2',
  'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'kbd', 'li', 'ol', 'p', 'picture',
  'pre', 'small', 'source', 'span', 'strong', 'sub', 'summary', 'sup', 'table',
  'tbody', 'td', 'th', 'thead', 'tr', 'ul', 'video',
]);

/**
 * Split a line into alternating prose / inline-code segments.
 *
 * CommonMark's rule, not a regex: a code span opens with a run of N
 * backticks and closes at the next run of exactly N. A single-backtick
 * regex gets ``a `b` c`` wrong — it reads the inner pair as the span and
 * hands the rest back as prose, which is how `<sql>` reached the HTML raw
 * and how it later got double-escaped.
 */
function splitInlineCode(line) {
  const runs = [...line.matchAll(/`+/g)].map((m) => ({ at: m.index, len: m[0].length }));
  const out = [];
  let pos = 0;
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i];
    if (open.at < pos) continue;
    const close = runs.slice(i + 1).find((r) => r.len === open.len);
    if (!close) break;
    if (open.at > pos) out.push({ code: false, text: line.slice(pos, open.at) });
    out.push({ code: true, text: line.slice(open.at, close.at + close.len) });
    pos = close.at + close.len;
    i = runs.indexOf(close);
  }
  if (pos < line.length) out.push({ code: false, text: line.slice(pos) });
  return out;
}

/**
 * Break markdown into fenced-code blocks and prose blocks.
 *
 * Prose blocks are paragraph-scoped, because markdown parses inline
 * constructs per block: a code span can wrap across a line break but never
 * across a blank line. A line that *begins* with a tag-like token is
 * joined to the line above first — block rules run before inline ones, so
 * such a line would otherwise start an HTML block and cut the paragraph in
 * half, leaving the placeholder inside it unprotected.
 *
 * Both the escaper and the guard read this, so they cannot disagree about
 * what counts as prose — which is how every bug in this file's history
 * started.
 */
function blocks(md) {
  const out = [];
  let buf = [];
  let fence = false;
  const flush = () => { if (buf.length) { out.push({ code: false, text: buf.join('\n') }); buf = []; } };

  for (const line of md.split('\n')) {
    if (/^\s*```/.test(line)) { flush(); fence = !fence; out.push({ code: true, text: line }); continue; }
    if (fence) { out.push({ code: true, text: line }); continue; }
    if (line.trim() === '') { flush(); out.push({ code: true, text: line }); continue; }
    const startsTag = /^\s*<\/?([A-Za-z][\w-]*)/.exec(line);
    if (startsTag && !HTML_TAGS.has(startsTag[1].toLowerCase()) && buf.length) {
      buf[buf.length - 1] += ' ' + line.trim();
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

function escapeAngles(md) {
  return blocks(md)
    .map((b) =>
      b.code
        ? b.text
        : splitInlineCode(b.text)
            .map((seg) => (seg.code ? seg.text : escapeProse(seg.text)))
            .join(''),
    )
    .join('\n');
}

/**
 * Escape only what markdown-it would pass through as raw HTML: text shaped
 * like a tag that is not one of ours.
 *
 * A bare `<` before a space or digit — `SQLite < 3.35` — is deliberately
 * left alone. markdown-it escapes it already, and escaping it here too
 * produces `&amp;lt;`, which renders as the literal characters "&lt;".
 */
function escapeProse(text) {
  return text.replace(/<(\/?)([A-Za-z][\w-]*)((?:[^<>]|\n)*?)>/g, (whole, close, tag, rest, offset) => {
    const prev = offset === 0 ? '' : text[offset - 1];
    const atBoundary = offset === 0 || /\s|>/.test(prev);
    if (atBoundary && HTML_TAGS.has(tag.toLowerCase())) return whole;
    return `&lt;${close}${tag}${rest}&gt;`;
  });
}

// ── 5. link rewriting ────────────────────────────────────────────────

const refRoute = (file) => `/reference/${file.replace(/\.md$/, '').toLowerCase()}`;

function rewrite(md, { self } = {}) {
  let s = md;

  // docs/NAME.md and ./NAME.md → /reference/name
  s = s.replace(/\]\((?:\.\/)?docs\/([A-Z0-9-]+)\.md(#[^)]*)?\)/gi,
    (_, n, a) => `](${refRoute(n)}${a ?? ''})`);
  s = s.replace(/\]\(\.\/([A-Z0-9-]+)\.md(#[^)]*)?\)/g,
    (_, n, a) => `](${refRoute(n)}${a ?? ''})`);

  // ../README.md#anchor → wherever that section now lives
  s = s.replace(/\]\((?:\.\.\/)?README\.md(#([^)]*))?\)/g, (_, __, anchor) =>
    `](${anchor ? (anchorHome.get(anchor) ?? '/guide/') + '#' + anchor : '/guide/'})`);

  // CHANGELOG.md → /changelog
  s = s.replace(/\]\((?:\.\.\/|\.\/)?CHANGELOG\.md(#[^)]*)?\)/g, (_, a) => `](/changelog${a ?? ''})`);

  // Bare `#anchor` links: keep them when the target is on this page,
  // otherwise point at the page that now owns it.
  s = s.replace(/\]\(#([^)]+)\)/g, (whole, anchor) => {
    const home = anchorHome.get(anchor);
    if (!home) return whole;                            // unknown — leave alone
    if (self && home === self) return whole;            // same page, still a jump
    return `](${home}#${anchor})`;
  });

  return escapeAngles(s);
}

// ── 6. write ─────────────────────────────────────────────────────────

rm(OUT_GUIDE); rm(OUT_REF);
mk(OUT_GUIDE); mk(OUT_REF);

// The intro paragraphs above the first `##` — badges, the one-line pitch.
const introBody = rewrite(intro, { self: '/guide/introduction' })
  .replace(/^#\s+.*$/m, '')                             // the H1 is the page title
  .trim();
fs.writeFileSync(
  path.join(OUT_GUIDE, 'introduction.md'),
  `---\ntitle: Introduction\n---\n\n# Introduction\n\n${introBody}\n`,
);

for (const p of guidePages) {
  const body = rewrite(p.body.join('\n'), { self: `/guide/${p.slug}` }).trim();
  fs.writeFileSync(
    path.join(OUT_GUIDE, `${p.slug}.md`),
    `---\ntitle: ${JSON.stringify(p.title.replace(/`/g, ''))}\n---\n\n## ${p.title}\n\n${body}\n`,
  );
}

for (const f of docFiles) {
  const md = fs.readFileSync(path.join(REPO, 'docs', f), 'utf8');
  fs.writeFileSync(
    path.join(OUT_REF, `${f.replace(/\.md$/, '').toLowerCase()}.md`),
    rewrite(md, { self: refRoute(f) }),
  );
}

fs.writeFileSync(path.join(SRC, 'changelog.md'), rewrite(changelog));

// The examples listing, if it came across with the folder.
const exReadme = path.join(REPO, 'examples', 'README.md');
if (fs.existsSync(exReadme)) {
  fs.writeFileSync(path.join(SRC, 'examples.md'), rewrite(fs.readFileSync(exReadme, 'utf8')));
}

// ── 7. the sidebar ───────────────────────────────────────────────────

const sidebar = {
  '/guide/': [
    {
      text: 'Guide',
      items: [
        { text: 'Introduction', link: '/guide/introduction' },
        ...guidePages.map((p) => ({ text: p.title.replace(/`/g, ''), link: `/guide/${p.slug}` })),
      ],
    },
  ],
  '/reference/': companionGroups.map((g) => ({
    text: g.text,
    collapsed: true,
    items: g.items.map((i) => ({ text: i.text, link: refRoute(i.file) })),
  })),
};

fs.writeFileSync(
  path.join(SRC, '.vitepress', 'sidebar.json'),
  JSON.stringify(sidebar, null, 2) + '\n',
);

// ── 8. guard ─────────────────────────────────────────────────────────
//
// Every failure in this file's history looked the same from the build:
// "Element is missing end tag" at a line number with nothing wrong on it,
// because Vue reports where it noticed, not where the tag opened. Checking
// the generated markdown here turns that into a message naming the file.

function unclosedTags(md) {
  const VOID = new Set(['br', 'img', 'hr', 'input', 'meta', 'link', 'source', 'col', 'wbr']);
  const stack = [];
  for (const b of blocks(md)) {
    if (b.code) continue;
    for (const seg of splitInlineCode(b.text)) {
      if (seg.code) continue;
      for (const m of seg.text.matchAll(/<(\/?)([A-Za-z][\w-]*)([^>]*)>/g)) {
        const [, close, tag, rest] = m;
        if (VOID.has(tag.toLowerCase()) || /\/\s*$/.test(rest)) continue;
        if (!close) stack.push(tag);
        else { const k = stack.lastIndexOf(tag); if (k >= 0) stack.splice(k, 1); }
      }
    }
  }
  return stack;
}

const offenders = [];
for (const dir of [OUT_GUIDE, OUT_REF]) {
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const bad = unclosedTags(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (bad.length) offenders.push(`${path.basename(dir)}/${f}: <${[...new Set(bad)].join('>, <')}>`);
  }
}
if (offenders.length) {
  console.error(
    'sync: markdown that Vue will reject — a placeholder like <name> is being\n' +
    'read as an HTML tag. Wrap it in backticks in the source .md, or add the\n' +
    'tag to HTML_TAGS if it really is markup.\n  ' + offenders.join('\n  '),
  );
  process.exit(1);
}

console.log(
  `sync: ${guidePages.length + 1} guide pages, ${docFiles.length} reference pages, ` +
  `${companionGroups.length} sidebar groups, changelog${orphans.length ? `, ${orphans.length} unlisted docs adopted` : ''}`,
);
