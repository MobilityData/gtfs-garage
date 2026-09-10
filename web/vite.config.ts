import { defineConfig } from "vite";

// Builds into the Python package so the server can serve it as package data.
// The output is committed: `pip install` must never require Node.
export default defineConfig({
  base: "/static/",
  build: {
    outDir: "../src/gtfs_garage/web",
    emptyOutDir: true,
  },
});
