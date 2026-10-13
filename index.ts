import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { BridgeEngine, type BridgeConfig } from "./src/engine.ts";
import { StateStore } from "./src/state.ts";
import { SingleInstanceLock } from "./src/lock.ts";

function loadEnv(): Record<string, string> {
  const envPath = join(process.cwd(), ".env");
  if (!existsSync(envPath)) return {};
  const content = readFileSync(envPath, "utf-8");
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      result[key] = val;
    }
  }
  return result;
}

async function main(): Promise<void> {
  console.log("🚀 Starting AgentRelay Bridge...");

  const env = loadEnv();
  const botToken = process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
  const allowedChatIdRaw = process.env.ALLOWED_CHAT_ID || env.ALLOWED_CHAT_ID;
  const allowedUserIdRaw = process.env.ALLOWED_USER_ID || env.ALLOWED_USER_ID;
  const coordinatorHandle = process.env.ORCA_COORDINATOR_HANDLE || env.ORCA_COORDINATOR_HANDLE;

  if (!botToken || !allowedChatIdRaw || !allowedUserIdRaw) {
    console.error("❌ ERROR: Missing required configuration in .env or environment variables:");
    console.error("   - TELEGRAM_BOT_TOKEN");
    console.error("   - ALLOWED_CHAT_ID");
    console.error("   - ALLOWED_USER_ID");
    console.error("Copy .env.sample to .env and fill in credentials before starting.");
    process.exit(1);
  }

  const allowedChatId = parseInt(allowedChatIdRaw, 10);
  const allowedUserId = parseInt(allowedUserIdRaw, 10);

  if (isNaN(allowedChatId) || isNaN(allowedUserId)) {
    console.error("❌ ERROR: ALLOWED_CHAT_ID and ALLOWED_USER_ID must be valid integers.");
    process.exit(1);
  }

  // Prevent dual instances running against same bot
  const lock = new SingleInstanceLock(join(process.cwd(), ".bridge.lock"));
  if (!lock.acquire()) {
    console.error("❌ Another instance of AgentRelay is already running in this directory!");
    process.exit(1);
  }

  const cleanup = () => {
    console.log("\n🛑 Shutting down AgentRelay Bridge...");
    lock.release();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const stateStore = new StateStore(join(process.cwd(), "state.json"));
  const config: BridgeConfig = {
    botToken,
    allowedChatId,
    allowedUserId,
    coordinatorHandle,
  };

  const engine = new BridgeEngine(config, stateStore);
  await engine.init();
  await engine.startPolling();
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("💥 Fatal error:", msg);
  process.exit(1);
});
