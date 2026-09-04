import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { forgeWasm } from "forge-orm/wasm/vite"

export default defineConfig({ plugins: [react(), forgeWasm()] })
