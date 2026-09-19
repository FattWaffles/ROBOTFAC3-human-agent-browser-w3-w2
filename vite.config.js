import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  plugins: [tailwindcss(), nodePolyfills({ include: ["buffer", "crypto", "stream", "util"] })],
  server: {
    port: 5173,
    // Browsers get 403 from the public RPC; relay through the dev server (the Rust core does this in the desktop build).
    proxy: {
      "/rpc": {
        target: "https://api.mainnet-beta.solana.com",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/rpc/, ""),
        configure: (proxy) => proxy.on("proxyReq", (req) => { req.removeHeader("origin"); req.removeHeader("referer"); }),
      },
    },
  },
});
