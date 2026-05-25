/* eslint-disable no-console */
//
// Autocomplete + type-inference probe.
//
// Uses TypeScript's own Language Service API (the same one your IDE plugin
// drives) to ask, programmatically:
//   • "What completions would appear at this cursor position?"
//   • "What's the inferred type at this expression?"
//
// This is the answer to: "can YOU (the AI) know whether forge has real
// autocomplete, or do you have to trust visual inspection?" Yes — by
// asking `ts.LanguageService.getCompletionsAtPosition()` directly.

import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';

const PROJECT_ROOT = __dirname;
const PROBE_FILE_NAME = path.join(PROJECT_ROOT, '__autocomplete_probe.ts');

// The probe file. `/*PROBE:<label>*/` markers are scanned at runtime; the
// language service is queried for completions + quickInfo right at each
// marker's position.

const PROBE_SOURCE = `
import { createDb, forgeSql, ForgeDbNull } from './src';

declare const db: Awaited<ReturnType<typeof createDb>>;

async function probe() {
  // 1. autocomplete on db itself — what models + ops are exposed?
  void db./*PROBE:db_root*/user;

  // 2. autocomplete on a model — what wrapper methods are available?
  void db.user./*PROBE:db_user_methods*/findFirst;

  // 3. autocomplete inside findFirst({ where: { … } }) — which field names?
  await db.user.findFirst({ where: { /*PROBE:where_keys*/ } });

  // 4. inside select — which scalar keys + relation keys?
  await db.user.findFirst({ select: { /*PROBE:select_keys*/ } });

  // 5. inside include — which relation names?
  await db.user.findFirst({ include: { /*PROBE:include_keys*/ } });

  // 6. inside data on create — which fields?
  await db.user.create({ data: { /*PROBE:create_keys*/ } });

  // 7. inside data on update — which fields (with atomic ops)?
  await db.post.update({ where: { id: 'x' }, data: { /*PROBE:update_keys*/ } });

  // 8. inside data.view_count — atomic op autocomplete (increment, set, etc.)?
  await db.post.update({ where: { id: 'x' }, data: { view_count: { /*PROBE:atomic_ops*/ } } });

  // 9. groupBy: which fields can _count accept?
  await db.user.groupBy({ by: ['role'], _count: { /*PROBE:groupby_count*/ } });

  // 10. role enum: what literal strings are accepted?
  type _RoleArg = Parameters<typeof db.user.create>[0]['data']['role']; /*PROBE:role_value*/
  void (null as _RoleArg);

  // 11. orderBy direction value type
  type _OrderDir = NonNullable<Parameters<typeof db.user.findMany>[0]>['orderBy']; /*PROBE:orderby_dir*/
  void (null as unknown as _OrderDir);

  // 12. typed return narrowing — what's on a partial selection?
  const partial = await db.user.findFirst({ select: { email: true } });
  if (partial) partial./*PROBE:select_narrowed*/;
}
void probe;
`;

// ─── Build a LanguageService wired to the real project ──────────────────────

const tsconfigPath = path.join(PROJECT_ROOT, 'tsconfig.json');
const tsconfigRaw = ts.readConfigFile(tsconfigPath, ts.sys.readFile).config;
const parsed = ts.parseJsonConfigFileContent(
  tsconfigRaw,
  ts.sys,
  PROJECT_ROOT,
);
const compilerOptions: ts.CompilerOptions = {
  ...parsed.options,
  // Disable rootDir restriction so the probe file (outside src/) can sit alongside.
  rootDir: undefined,
  noEmit: true,
  strict: true,
};

// File set: every real file in the project's include + our virtual probe.
const realFiles = parsed.fileNames;
const fileNames = [...realFiles, PROBE_FILE_NAME];

const fileVersions = new Map<string, number>();
const fileContents = new Map<string, string>();
fileContents.set(PROBE_FILE_NAME, PROBE_SOURCE);
for (const f of realFiles) {
  fileContents.set(f, fs.readFileSync(f, 'utf8'));
}
for (const f of fileNames) fileVersions.set(f, 1);

const servicesHost: ts.LanguageServiceHost = {
  getScriptFileNames: () => fileNames,
  getScriptVersion: (f) => String(fileVersions.get(f) ?? 0),
  getScriptSnapshot: (f) => {
    if (fileContents.has(f)) return ts.ScriptSnapshot.fromString(fileContents.get(f)!);
    if (fs.existsSync(f)) return ts.ScriptSnapshot.fromString(fs.readFileSync(f, 'utf8'));
    return undefined;
  },
  getCurrentDirectory: () => PROJECT_ROOT,
  getCompilationSettings: () => compilerOptions,
  getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
  fileExists: (f) => fileContents.has(f) || ts.sys.fileExists(f),
  readFile: (f) => fileContents.get(f) ?? ts.sys.readFile(f),
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
};

const service = ts.createLanguageService(servicesHost, ts.createDocumentRegistry());

// ─── Probe loop ─────────────────────────────────────────────────────────────

interface ProbeResult {
  label: string;
  position: number;
  completions: { name: string; kind: string }[];
  quickInfo?: string;
}

function findProbes(source: string): { label: string; position: number }[] {
  const re = /\/\*PROBE:([a-z_]+)\*\//g;
  const probes: { label: string; position: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    // For type-hover probes (role_value, orderby_dir) we want the cursor
    // BEFORE the type alias so getQuickInfoAtPosition lands on the type
    // identifier. For others we want it INSIDE the brace context — right
    // after the marker comment works for both because the cursor sits at
    // the first non-whitespace char on the next syntactic step.
    probes.push({ label: m[1], position: m.index });
  }
  return probes;
}

// For hover probes we want the TYPE ALIAS identifier on the same line.
// Adjust by scanning backwards from the marker to find an identifier.
function adjustPositionForHover(label: string, source: string, p: number): number {
  // Hover probes ask "what is the inferred type" at a type identifier.
  if (!['role_value', 'orderby_dir'].includes(label)) return p;
  const targets: Record<string, string> = {
    role_value: '_RoleArg',
    orderby_dir: '_OrderDir',
  };
  const t = targets[label];
  if (!t) return p;
  const idx = source.lastIndexOf(t, p);
  if (idx < 0) return p;
  return idx + t.length;
}

const probes = findProbes(PROBE_SOURCE);
const results: ProbeResult[] = [];

for (const p of probes) {
  // Position the cursor BEFORE the marker comment so it sits right after the
  // preceding character (dot, open-brace, etc.) — the way an IDE caret would
  // be when typing.
  const completionPos = p.position;
  const completions = service.getCompletionsAtPosition(PROBE_FILE_NAME, completionPos, {
    includeCompletionsForModuleExports: false,
    includeCompletionsWithInsertText: false,
  });
  const hoverPos = adjustPositionForHover(p.label, PROBE_SOURCE, p.position);
  const quickInfo = service.getQuickInfoAtPosition(PROBE_FILE_NAME, hoverPos);
  results.push({
    label: p.label,
    position: p.position,
    completions: completions
      ? completions.entries.map((e) => ({ name: e.name, kind: e.kind }))
      : [],
    quickInfo: quickInfo
      ? ts.displayPartsToString(quickInfo.displayParts)
      : undefined,
  });
}

// ─── Report ─────────────────────────────────────────────────────────────────

function fmt(items: { name: string; kind: string }[], filter?: (e: { name: string; kind: string }) => boolean, max = 20): string {
  const filtered = filter ? items.filter(filter) : items;
  const shown = filtered.slice(0, max);
  const truncated = filtered.length > max ? `, +${filtered.length - max} more` : '';
  return shown.map((e) => e.name).join(', ') + truncated;
}

const byLabel = new Map(results.map((r) => [r.label, r]));

console.log('\n╔═══════════════════════════════════════════════════════════════════════╗');
console.log('║  Forge — autocomplete probe via ts.LanguageService                    ║');
console.log('╚═══════════════════════════════════════════════════════════════════════╝\n');

function show(label: string, description: string, filter?: (e: any) => boolean, max?: number) {
  const r = byLabel.get(label);
  if (!r) { console.log(`  ${label}: NOT FOUND`); return; }
  const list = fmt(r.completions, filter, max);
  const count = r.completions.length;
  console.log(`▸ ${description}`);
  console.log(`  ${list || '(no completions)'}`);
  console.log(`  total: ${count} entries\n`);
}

// Filter out built-in JS properties that show in every position.
const noise = new Set([
  'constructor', 'toString', 'valueOf', 'hasOwnProperty',
  'isPrototypeOf', 'propertyIsEnumerable', 'toLocaleString',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
  '__proto__', 'then', 'catch', 'finally',
]);
const interesting = (e: { name: string; kind: string }) => !noise.has(e.name);

show('db_root',         '1. db.[CURSOR]                                          — top-level model + meta keys', interesting);
show('db_user_methods', '2. db.user.[CURSOR]                                     — wrapper methods exposed', interesting);
show('where_keys',      '3. db.user.findFirst({ where: { [CURSOR] } })           — User field names + logical ops', interesting);
show('select_keys',     '4. db.user.findFirst({ select: { [CURSOR] } })          — scalar + relation keys', interesting);
show('include_keys',    '5. db.user.findFirst({ include: { [CURSOR] } })         — relation names only', interesting);
show('create_keys',     '6. db.user.create({ data: { [CURSOR] } })               — fields available on create', interesting);
show('update_keys',     '7. db.post.update({ data: { [CURSOR] } })               — fields available on update', interesting);
show('atomic_ops',      '8. db.post.update({ data: { view_count: { [CURSOR] } } })  — atomic op names on a numeric field', interesting);
show('groupby_count',   '9. db.user.groupBy({ _count: { [CURSOR] } })            — fields valid for COUNT', interesting);

// For 10 + 11, we want the QuickInfo (hover type) not completions.
const role = byLabel.get('role_value');
if (role) {
  console.log(`▸ 10. role-field value type (hover)`);
  console.log(`  ${role.quickInfo ?? '(no info)'}\n`);
}
const dir = byLabel.get('orderby_dir');
if (dir) {
  console.log(`▸ 11. orderBy direction value type (hover)`);
  console.log(`  ${dir.quickInfo ?? '(no info)'}\n`);
}

show('select_narrowed', '12. select-narrowed result — partial.[CURSOR]           — should show ONLY selected fields', interesting);

// ─── Diagnostics: any TS errors in the probe file? ──────────────────────────

const diags = [
  ...service.getSemanticDiagnostics(PROBE_FILE_NAME),
  ...service.getSyntacticDiagnostics(PROBE_FILE_NAME),
];
console.log('\n─── Diagnostics in the probe file ───');
if (diags.length === 0) {
  console.log('  ✓ none — every call site type-checks cleanly\n');
} else {
  for (const d of diags) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    const { line, character } = d.file
      ? d.file.getLineAndCharacterOfPosition(d.start ?? 0)
      : { line: 0, character: 0 };
    console.log(`  ✗ ${PROBE_FILE_NAME.split('/').pop()}:${line + 1}:${character + 1}  ${msg}`);
  }
}
