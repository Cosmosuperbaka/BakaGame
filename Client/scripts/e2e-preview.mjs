import path from "node:path";
import { fileURLToPath } from "node:url";
import { preview } from "vite";

const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Static dist only: never load the dev proxy, .env files, or source-generation plugins.
const server = await preview({
  root: clientDir,
  configFile: false,
  envDir: false,
  mode: "production",
  preview: { host: "127.0.0.1", port: 5173, strictPort: true, proxy: {} },
});
server.printUrls();
