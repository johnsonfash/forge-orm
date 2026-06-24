// Next.js helper — wraps next.config.js to enable the sqlite-wasm + forge
// worker pipeline. Sets:
//   • COOP/COEP headers for the chosen routes (default: all routes).
//   • webpack 5 worker config (asyncWebAssembly + topLevelAwait).
//   • Externals so the @sqlite.org/sqlite-wasm package isn't re-bundled.
//
// Usage in next.config.js / next.config.mjs:
//   import { withForgeWasm } from 'forge-orm/wasm/next';
//   export default withForgeWasm({
//     // ...your existing Next config
//   });

export interface ForgeWasmNextOptions {
  // Matcher for COOP/COEP headers. Default: '/(.*)' (everything).
  // Set to a more specific pattern (e.g. '/app/(.*)') if your marketing pages
  // embed third-party scripts that don't tolerate COEP: require-corp.
  coopCoepMatcher?: string;
  // Skip emitting COOP/COEP headers entirely. Default: false.
  noHeaders?: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NextConfig = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WebpackConfig = any;

export function withForgeWasm(
  nextConfig: NextConfig = {},
  opts: ForgeWasmNextOptions = {},
): NextConfig {
  const matcher = opts.coopCoepMatcher ?? '/(.*)';
  const includeHeaders = !opts.noHeaders;
  const prevHeaders = nextConfig.headers;
  const prevWebpack = nextConfig.webpack;

  return {
    ...nextConfig,
    experimental: { ...(nextConfig.experimental ?? {}), esmExternals: 'loose' },

    webpack: (config: WebpackConfig, ctx: { isServer: boolean; dev: boolean }) => {
      if (!ctx.isServer) {
        config.experiments = {
          ...(config.experiments ?? {}),
          asyncWebAssembly: true,
          topLevelAwait: true,
        };
        // The sqlite-wasm package ships .wasm + .mjs that webpack should pass
        // through as assets rather than parse.
        config.module ??= {};
        config.module.rules ??= [];
        config.module.rules.push({
          test: /\.wasm$/,
          type: 'asset/resource',
        });
        // Workers via new Worker(new URL(...)) — webpack 5 handles natively.
      }
      return prevWebpack ? prevWebpack(config, ctx) : config;
    },

    async headers() {
      const own = includeHeaders
        ? [{
            source: matcher,
            headers: [
              { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
              { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
            ],
          }]
        : [];
      const inherited = prevHeaders ? await prevHeaders() : [];
      return [...own, ...inherited];
    },
  };
}
