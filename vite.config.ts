import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    emptyOutDir: true,
  },
  plugins: [cloudflare()],
});
