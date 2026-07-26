import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), tailwindcss()],

  // Vite 8 resolves the "@/*" alias from tsconfig.app.json natively — this
  // replaces the vite-tsconfig-paths plugin.
  resolve: { tsconfigPaths: true },

  // Vite does not read PORT on its own; without this it silently increments
  // past a busy 5173 and any tool that was told which port to expect is wrong.
  server: { port: Number(process.env.PORT) || 5173 },

  build: {
    // Monaco is ~2.6MB and lives in its own lazily-imported chunk, which is
    // the point — it never touches the main bundle. Raised so the warning
    // stays a signal about the chunks we actually control rather than firing
    // on every build for a chunk that is deliberately that size.
    chunkSizeWarningLimit: 3000,
  },

  test: {
    globals: true,
    environment: "jsdom",
    // polyfills must land before anything imports the MSW server.
    setupFiles: ["./src/test/polyfills.ts", "./src/setupTests.ts"],
  },
});
