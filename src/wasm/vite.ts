// Vite plugin — wires sqlite-wasm + the forge worker into a Vite app with
// zero per-project config. Handles:
//   • Cross-origin isolation headers (COOP/COEP) on the dev server so the
//     wasm build can use SharedArrayBuffer if it wants to.
//   • optimizeDeps.exclude for @sqlite.org/sqlite-wasm (it ships its own .wasm
//     binary; Vite's pre-bundler shouldn't touch it).
//   • A serve-static rule so the .wasm asset is reachable from the worker.
//
// Usage in vite.config.ts:
//   import { forgeWasm } from 'forge-orm/wasm/vite';
//   export default defineConfig({
//     plugins: [forgeWasm()],
//   });

export interface ForgeWasmViteOptions {
  // Enable Cross-Origin-Opener-Policy/Embedder-Policy headers on dev server.
  // Required only when using SharedArrayBuffer (e.g. threads). Default: true.
  coopCoep?: boolean;
  // Exclude @sqlite.org/sqlite-wasm from Vite's dep optimizer. Default: true.
  excludeSqliteWasm?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type VitePlugin = any;

export function forgeWasm(opts: ForgeWasmViteOptions = {}): VitePlugin {
  const coopCoep = opts.coopCoep ?? true;
  const excludeSqliteWasm = opts.excludeSqliteWasm ?? true;

  return {
    name: 'forge-orm-wasm',
    config: () => ({
      optimizeDeps: excludeSqliteWasm
        ? { exclude: ['@sqlite.org/sqlite-wasm'] }
        : {},
      worker: { format: 'es' },
    }),
    configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) {
      if (!coopCoep) return;
      server.middlewares.use((_req, res, next) => {
        // Required for SharedArrayBuffer-backed builds of sqlite-wasm. Harmless
        // on stock builds. Set on every response so the worker can boot.
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        next();
      });
    },
  };
}
