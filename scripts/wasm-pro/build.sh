#!/usr/bin/env bash
# build-sqlite-wasm-pro.sh
#
# Builds a custom sqlite-wasm bundle for forge-orm with the rtree extension
# AND sqlite-vec compiled in. The stock @sqlite.org/sqlite-wasm package
# includes FTS5 + json1 but NOT rtree or sqlite-vec, so geo (f.geoPoint() +
# near / withinPolygon) and vector (f.vector() + near / nearTo) run in
# fallback mode there. This build unlocks native paths for both.
#
# Inputs:
#   SQLITE_VERSION   — e.g. 3.46.1 (defaults to the env var or 3.46.1)
#   SQLITE_VEC_VERSION — e.g. v0.1.6 (defaults to v0.1.6)
#   OUT              — output directory (defaults to dist/wasm-pro/)
#
# Prerequisites:
#   • emsdk installed and activated:
#       git clone https://github.com/emscripten-core/emsdk
#       cd emsdk && ./emsdk install latest && ./emsdk activate latest
#       source ./emsdk_env.sh
#   • Standard build tools: make, gcc, wget, unzip
#
# Output artifacts written to $OUT:
#   sqlite3.wasm       — compiled binary
#   sqlite3.mjs        — ESM loader
#   sqlite3.d.ts       — type definitions (matches @sqlite.org/sqlite-wasm)
#
# Once built, point the worker at the local artifact instead of the stock
# package — see README "Custom wasm build" chapter for the bundler hookup.

set -euo pipefail

SQLITE_VERSION="${SQLITE_VERSION:-3.46.1}"
SQLITE_VEC_VERSION="${SQLITE_VEC_VERSION:-v0.1.6}"
OUT="${OUT:-dist/wasm-pro}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "[forge-orm wasm-pro] working in $WORK"
echo "[forge-orm wasm-pro] sqlite ${SQLITE_VERSION}, sqlite-vec ${SQLITE_VEC_VERSION}"

if ! command -v emcc >/dev/null 2>&1; then
  echo "error: emcc (Emscripten) not in PATH. See https://emscripten.org/docs/getting_started/downloads.html"
  exit 1
fi

# 1) Fetch SQLite amalgamation source.
SQLITE_YEAR="2024"
SQLITE_BUILD="$(echo "${SQLITE_VERSION}" | awk -F. '{ printf "%d%02d%02d00", $1, $2, $3 }')"
SQLITE_URL="https://www.sqlite.org/${SQLITE_YEAR}/sqlite-amalgamation-${SQLITE_BUILD}.zip"
echo "[forge-orm wasm-pro] fetching $SQLITE_URL"
wget -q "$SQLITE_URL" -O "$WORK/sqlite.zip"
unzip -q "$WORK/sqlite.zip" -d "$WORK"
SQLITE_SRC="$WORK/sqlite-amalgamation-${SQLITE_BUILD}"

# 2) Fetch sqlite-vec source.
echo "[forge-orm wasm-pro] fetching sqlite-vec ${SQLITE_VEC_VERSION}"
git clone --depth 1 --branch "${SQLITE_VEC_VERSION}" \
  https://github.com/asg017/sqlite-vec.git "$WORK/sqlite-vec"

# 3) Compile sqlite3.c with rtree + FTS5 + json1 enabled, plus sqlite-vec.
mkdir -p "$OUT"
cd "$WORK"

emcc -O3 \
  -DSQLITE_ENABLE_FTS5 \
  -DSQLITE_ENABLE_JSON1 \
  -DSQLITE_ENABLE_RTREE \
  -DSQLITE_ENABLE_GEOPOLY \
  -DSQLITE_ENABLE_DBSTAT_VTAB \
  -DSQLITE_OMIT_LOAD_EXTENSION=0 \
  -DSQLITE_THREADSAFE=0 \
  -I "$SQLITE_SRC" \
  -I "$WORK/sqlite-vec" \
  "$SQLITE_SRC/sqlite3.c" \
  "$WORK/sqlite-vec/sqlite-vec.c" \
  -s WASM=1 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=33554432 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME='sqlite3InitModule' \
  -s ENVIRONMENT='web,worker' \
  -s EXPORTED_FUNCTIONS='["_sqlite3_vec_init", "_malloc", "_free"]' \
  -s EXPORTED_RUNTIME_METHODS='["ccall", "cwrap", "stringToUTF8", "UTF8ToString"]' \
  -o "$OUT/sqlite3.mjs"

echo "[forge-orm wasm-pro] built $OUT/sqlite3.wasm + $OUT/sqlite3.mjs"
echo ""
echo "Next: point the worker at this build instead of @sqlite.org/sqlite-wasm."
echo "See README 'Custom wasm build (vec0 + R-Tree)' chapter."
