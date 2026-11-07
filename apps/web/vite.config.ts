import { defineConfig } from "vite";

export default defineConfig({
  // Relative paths, so the build works under the GitHub Pages sub-folder.
  base: "./",
  build: { target: "es2022" },
  server: { port: 5183, strictPort: true },
});
