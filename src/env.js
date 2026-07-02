import fs from "node:fs";
import path from "node:path";

export function loadEnv(cwd = process.cwd()) {
  const envPath = path.join(cwd, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;

    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

export function getConfig() {
  return {
    simplefinCreateUrl:
      process.env.SIMPLEFIN_CREATE_URL ||
      "https://beta-bridge.simplefin.org/simplefin/create",
    simplefinDays: Number(process.env.SIMPLEFIN_DAYS || 30),
    simplefinPending: (process.env.SIMPLEFIN_PENDING || "true") === "true",
    port: Number(process.env.PORT || 8000),
  };
}
