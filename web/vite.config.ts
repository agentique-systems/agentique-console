import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  server: {
    proxy: {
      "/api": process.env["CONSOLE_SERVER_URL"] ?? "http://127.0.0.1:4400",
    },
  },
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        // shadcn-style primitives carry "use client" directives that mean nothing to Rollup.
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        warn(warning);
      },
    },
  },
});
