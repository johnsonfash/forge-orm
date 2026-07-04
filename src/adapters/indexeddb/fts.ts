// Full-text search via IDB multiEntry index.
//
// Every `.searchable()` field gets a shadow `_tokens_<field>: string[]`
// column maintained by coerceInbound. Because the shadow field is indexed
// with `multiEntry: true`, IDB stores one entry per array element — so a
// `getAll(IDBKeyRange.only('word'))` on the index returns every row whose
// tokens include 'word'. `search` compiles into intersect(getAllKeys(term))
// across the query's tokens — index-backed AND-of-tokens, not a full-table
// cursor scan.
//
// Tokeniser: lowercase, split on non-word, dedupe. Min length 1 keeps
// single-char CJK / Greek tokens; max 40 caps runaway strings so a
// pathological input can't blow up the index.

export function tokenize(text: string): string[] {
  return Array.from(new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 1 && w.length <= 40),
  ));
}

export function tokensForRow(row: Record<string, unknown>, searchableFields: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of searchableFields) {
    const v = row[f];
    if (typeof v === 'string' && v.length > 0) {
      out[`_tokens_${f}`] = tokenize(v);
    }
  }
  return out;
}

// AND-of-token search: intersects the primary-key sets returned per term.
export async function searchByTokens(
  db: IDBDatabase,
  storeName: string,
  field: string,
  query: string,
): Promise<Set<IDBValidKey>> {
  const terms = tokenize(query);
  if (terms.length === 0) return new Set();
  const tx = db.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const idxName = `_i_tokens_${field}`;
  if (!Array.from(store.indexNames).includes(idxName)) return new Set();
  const index = store.index(idxName);
  const perTerm: Set<string>[] = [];
  await Promise.all(terms.map((term) => new Promise<void>((resolve, reject) => {
    const set = new Set<string>();
    const req = index.openKeyCursor(IDBKeyRange.only(term));
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) { perTerm.push(set); return resolve(); }
      set.add(String(cur.primaryKey));
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  })));
  perTerm.sort((a, b) => a.size - b.size);
  if (perTerm.length === 0) return new Set();
  const [head, ...rest] = perTerm;
  const result = new Set<IDBValidKey>();
  for (const id of head) {
    if (rest.every((s) => s.has(id))) result.add(id);
  }
  return result;
}
