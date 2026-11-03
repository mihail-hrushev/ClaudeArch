import { defineConfig } from "vite";

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 2000, // Babylon core is large; expected
  },
});
