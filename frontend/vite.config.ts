import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],

  // Vite 8 resolves the "@/*" alias from tsconfig.app.json natively — this
  // replaces the vite-tsconfig-paths plugin.
  resolve: { tsconfigPaths: true },

  test: {
    globals: true,
    environment: "jsdom",
    // polyfills must land before anything imports the MSW server.
    setupFiles: ["./src/test/polyfills.ts", "./src/setupTests.ts"],
  },
});
