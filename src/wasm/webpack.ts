// Webpack 5 helper — apply to a webpack config (CRA-ejected, custom webpack,
// Rsbuild) to enable the sqlite-wasm + forge worker pipeline.
//
// Usage:
//   const { forgeWasmWebpack } = require('forge-orm/wasm/webpack');
//   module.exports = forgeWasmWebpack({
//     // ...your existing webpack config
//   });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WebpackConfig = any;

export interface ForgeWasmWebpackOptions {
  // Skip the assetModule rule for .wasm. Default: false.
  noWasmAssetRule?: boolean;
}

export function forgeWasmWebpack(
  config: WebpackConfig,
  opts: ForgeWasmWebpackOptions = {},
): WebpackConfig {
  config.experiments = {
    ...(config.experiments ?? {}),
    asyncWebAssembly: true,
    topLevelAwait: true,
    syncWebAssembly: false,
  };
  config.output ??= {};
  config.output.assetModuleFilename ??= 'static/wasm/[name].[hash][ext]';

  if (!opts.noWasmAssetRule) {
    config.module ??= {};
    config.module.rules ??= [];
    config.module.rules.push({
      test: /\.wasm$/,
      type: 'asset/resource',
    });
  }
  return config;
}
