import React from "react"
import { openDb } from "./db"

type Cafe = {
  id: string
  name: string
  city: string
  location: { lng: number; lat: number }
  embedding: number[]
  _distanceMeters?: number
  _distance?: number
}
type Db = Awaited<ReturnType<typeof openDb>>

export function App() {
  const [db, setDb] = React.useState<Db | null>(null)
  const [cafes, setCafes] = React.useState<Cafe[]>([])

  React.useEffect(() => { openDb().then(setDb) }, [])

  async function refresh() {
    if (!db) return
    setCafes(await db.cafe.findMany({ orderBy: { name: "asc" } }) as Cafe[])
  }
  React.useEffect(() => { if (db) refresh() }, [db])

  if (!db) return <p style={{ padding: 40 }}>Opening IndexedDB...</p>

  return (
    <main style={S.main}>
      <h1>forge-orm on IndexedDB</h1>
      <p style={S.sub}>Click the buttons. Every action hits real IndexedDB.</p>

      <CreateSection db={db} onDone={refresh} />
      <ListSection cafes={cafes} db={db} onDone={refresh} />
      <PaginationSection db={db} />
      <GeoSection db={db} />
      <VectorSection db={db} />
    </main>
  )
}

// -------- CREATE --------
function CreateSection({ db, onDone }: { db: Db; onDone: () => void }) {
  const [name, setName] = React.useState("")
  const [city, setCity] = React.useState("")

  async function create() {
    if (!name || !city) return
    // Scatter the point inside a ~50 km box around central London so the
    // geo section actually has spread to sort by.
    const jitter = () => (Math.random() - 0.5) * 0.6
    await db.cafe.create({
      data: {
        name, city,
        location:  { lng: -0.1276 + jitter(), lat: 51.5074 + jitter() },
        embedding: [Math.random(), Math.random(), Math.random(), Math.random()],
      } as any,
    })
    setName(""); setCity(""); onDone()
  }

  return (
    <section style={S.section}>
      <h2>1. Create</h2>
      <div style={S.row}>
        <input placeholder="name (e.g. Prufrock)" value={name} onChange={(e) => setName(e.target.value)} style={S.input} />
        <input placeholder="city (e.g. London)"   value={city} onChange={(e) => setCity(e.target.value)} style={S.input} />
        <button onClick={create} style={S.btn}>Add cafe</button>
      </div>
      <code style={S.code}>db.cafe.create({"{ data: { name, city, location, embedding } }"})</code>
    </section>
  )
}

// -------- LIST + DELETE --------
function ListSection({ cafes, db, onDone }: { cafes: Cafe[]; db: Db; onDone: () => void }) {
  async function del(id: string) {
    await db.cafe.delete({ where: { id } })
    onDone()
  }

  return (
    <section style={S.section}>
      <h2>2. All cafes ({cafes.length})</h2>
      {cafes.length === 0 && <p style={S.empty}>Nothing yet. Add one above.</p>}
      <ul style={S.list}>
        {cafes.map((c) => (
          <li key={c.id} style={S.li}>
            <span><b>{c.name}</b> — {c.city}</span>
            <button onClick={() => del(c.id)} style={S.delBtn}>delete</button>
          </li>
        ))}
      </ul>
      <code style={S.code}>db.cafe.findMany({"{ orderBy: { name: 'asc' } }"}) / db.cafe.delete({"{ where: { id } }"})</code>
    </section>
  )
}

// -------- PAGINATION --------
function PaginationSection({ db }: { db: Db }) {
  const [rows, setRows] = React.useState<Cafe[]>([])
  const [skip, setSkip] = React.useState(0)
  const TAKE = 2

  async function load(newSkip: number) {
    const clamped = Math.max(0, newSkip)
    setSkip(clamped)
    setRows(await db.cafe.findMany({ take: TAKE, skip: clamped, orderBy: { name: "asc" } }) as Cafe[])
  }
  React.useEffect(() => { void load(0) }, [])

  return (
    <section style={S.section}>
      <h2>3. Pagination</h2>
      <div style={S.row}>
        <button onClick={() => load(Math.max(0, skip - TAKE))} style={S.btn}>◀ prev</button>
        <span style={{ padding: "0 8px" }}>skip: {skip}, take: {TAKE}</span>
        <button onClick={() => load(skip + TAKE)}              style={S.btn}>next ▶</button>
      </div>
      <ul style={S.list}>
        {rows.map((c) => <li key={c.id} style={S.li}>{c.name} — {c.city}</li>)}
      </ul>
      <code style={S.code}>db.cafe.findMany({"{ take, skip, orderBy: { name: 'asc' } }"})</code>
    </section>
  )
}

// -------- GEO --------
function GeoSection({ db }: { db: Db }) {
  const [lng, setLng] = React.useState("-0.1276")
  const [lat, setLat] = React.useState("51.5074")
  const [km, setKm]   = React.useState("500")
  const [rows, setRows] = React.useState<Cafe[]>([])

  async function search() {
    const me = { lng: +lng, lat: +lat }
    setRows(await db.cafe.findMany({
      where:   { location: { near: { ...me, withinMeters: +km * 1000 } } } as any,
      orderBy: { location: { direction: "asc", nearTo: me } } as any,
    }) as Cafe[])
  }

  return (
    <section style={S.section}>
      <h2>4. Geo — nearest cafes</h2>
      <div style={S.row}>
        <input value={lng} onChange={(e) => setLng(e.target.value)} placeholder="lng" style={S.input} />
        <input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="lat" style={S.input} />
        <input value={km}  onChange={(e) => setKm(e.target.value)}  placeholder="km"  style={{ ...S.input, maxWidth: 80 }} />
        <button onClick={search} style={S.btn}>search</button>
      </div>
      <ul style={S.list}>
        {rows.map((c) => (
          <li key={c.id} style={S.li}>
            <b>{c.name}</b> — {(c._distanceMeters! / 1000).toFixed(1)} km
          </li>
        ))}
      </ul>
      <code style={S.code}>where: {"{ location: { near: { lng, lat, withinMeters } } }"}</code>
    </section>
  )
}

// -------- VECTOR --------
function VectorSection({ db }: { db: Db }) {
  const [q, setQ] = React.useState([0.5, 0.5, 0.5, 0.5])
  const [rows, setRows] = React.useState<Cafe[]>([])

  async function search() {
    setRows(await db.cafe.findMany({
      orderBy: { embedding: { direction: "asc", nearTo: q } } as any,
      take: 5,
    }) as Cafe[])
  }

  return (
    <section style={S.section}>
      <h2>5. Vector — most similar</h2>
      <div style={S.row}>
        {q.map((v, i) => (
          <input key={i} type="number" step="0.1" min="0" max="1" value={v}
            onChange={(e) => setQ(q.map((x, j) => j === i ? +e.target.value : x))}
            style={{ ...S.input, maxWidth: 70 }} />
        ))}
        <button onClick={search} style={S.btn}>search</button>
      </div>
      <ul style={S.list}>
        {rows.map((c) => (
          <li key={c.id} style={S.li}>
            <b>{c.name}</b> — cosine distance {c._distance?.toFixed(3)}
          </li>
        ))}
      </ul>
      <code style={S.code}>orderBy: {"{ embedding: { nearTo: [0.5, 0.5, 0.5, 0.5] } }"}</code>
    </section>
  )
}

// -------- styles (inline so the file stays self-contained) --------
const S = {
  main:    { maxWidth: 640, margin: "40px auto", padding: "0 20px", fontFamily: "system-ui" } as const,
  sub:     { color: "#666", marginTop: -8 } as const,
  section: { marginTop: 32, paddingTop: 20, borderTop: "1px solid #eee" } as const,
  row:     { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 } as const,
  input:   { padding: "6px 10px", fontSize: 14, border: "1px solid #ccc", borderRadius: 4, minWidth: 0, flex: "1 1 100px" } as const,
  btn:     { padding: "6px 14px", fontSize: 14, background: "#111", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" } as const,
  delBtn:  { padding: "2px 8px",  fontSize: 12, background: "#fff", color: "#c00", border: "1px solid #eee", borderRadius: 3, cursor: "pointer" } as const,
  list:    { listStyle: "none", padding: 0, margin: "8px 0" } as const,
  li:      { display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #f5f5f5", fontSize: 14 } as const,
  empty:   { color: "#999", fontSize: 13, fontStyle: "italic" } as const,
  code:    { display: "block", background: "#f5f5f5", padding: 8, fontSize: 12, borderRadius: 4, color: "#444", marginTop: 8, whiteSpace: "pre-wrap" as const },
}
