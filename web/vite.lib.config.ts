/**
 * The library build, for hosts embedding the viewer.
 *
 * Separate from vite.config.ts, which builds the standalone application into
 * the Python package. The two have opposite requirements: the application
 * bundles everything and is served from /static, while the library externalises
 * its peers and is imported by someone else's bundler.
 */

import { defineConfig } from "vite";

// No React plugin: its only job is Fast Refresh, which a library build has no
// use for. esbuild transforms the one .tsx file using tsconfig's `jsx` setting.
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: {
        mount: "src/mount.ts",
        map: "src/map-part.ts",
        parquet: "src/sources/parquet.ts",
        react: "src/react.tsx",
      },
      formats: ["es"],
    },
    rollupOptions: {
      // Peers, not bundles. Two copies of React break hooks, and two copies of
      // MapLibre would mean two WebGL contexts for one map.
      external: ["react", "react-dom", "react/jsx-runtime", "maplibre-gl", "@duckdb/duckdb-wasm"],
    },
  },
});
