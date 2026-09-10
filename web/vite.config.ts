import { defineConfig } from "vite";

const API_PORT = process.env.GTFS_GARAGE_API_PORT ?? "8811";

export default defineConfig(({ command }) => ({
  // The Python server mounts the built assets under /static, but the dev server
  // serves them at the root.
  base: command === "build" ? "/static/" : "/",
  build: {
    // Builds into the Python package so the server can serve it as package data.
    outDir: "../src/gtfs_garage/web",
    emptyOutDir: true,
  },
  server: {
    // `yarn dev` serves the interface with hot reload and forwards data
    // requests to the Python API, so neither side needs rebuilding to see a
    // change.
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
}));
