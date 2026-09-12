import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const envDir = fileURLToPath(new URL("../../", import.meta.url));

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, envDir);
  if (command === "build" && process.env.VERCEL === "1") {
    let apiUrl: URL;
    try {
      apiUrl = new URL(env.VITE_API_URL?.trim() ?? "");
    } catch {
      throw new Error("Set VITE_API_URL in Vercel Environment Variables to your deployed backend HTTPS URL, including /api/v1, then redeploy.");
    }
    if (apiUrl.protocol !== "https:" || /^(localhost|.*\.localhost|127\..*|\[::1\]|0\.0\.0\.0)$/.test(apiUrl.hostname)) {
      throw new Error("VITE_API_URL must point to a deployed HTTPS backend, not localhost. Update it in Vercel Environment Variables and redeploy.");
    }
  }
  return {
    plugins: [react()],
    envDir,
    server: { host: "127.0.0.1", port: 5173 }
  };
});
