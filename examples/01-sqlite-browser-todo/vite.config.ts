import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { forgeWasm } from "forge-orm/wasm/vite"

// The forge-orm Vite plugin wires up the sqlite-wasm worker + correct
// headers (CORS-isolated headers needed for SharedArrayBuffer/OPFS).
export default defineConfig({
  plugins: [react(), forgeWasm()],
})
