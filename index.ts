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
  console.log("🚀 Iniciando Telegram Orchestrator Bridge...");

  const env = loadEnv();
  const botToken = process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
  const allowedChatIdRaw = process.env.ALLOWED_CHAT_ID || env.ALLOWED_CHAT_ID;
  const allowedUserIdRaw = process.env.ALLOWED_USER_ID || env.ALLOWED_USER_ID;
  const coordinatorHandle = process.env.ORCA_COORDINATOR_HANDLE || env.ORCA_COORDINATOR_HANDLE;

  if (!botToken || !allowedChatIdRaw || !allowedUserIdRaw) {
    console.error("❌ ERRO: Configurações obrigatórias ausentes no arquivo .env ou variáveis de ambiente:");
    console.error("   - TELEGRAM_BOT_TOKEN");
    console.error("   - ALLOWED_CHAT_ID");
    console.error("   - ALLOWED_USER_ID");
    console.error("Copie .env.sample para .env e preencha os valores antes de iniciar.");
    process.exit(1);
  }

  const allowedChatId = parseInt(allowedChatIdRaw, 10);
  const allowedUserId = parseInt(allowedUserIdRaw, 10);

  if (isNaN(allowedChatId) || isNaN(allowedUserId)) {
    console.error("❌ ERRO: ALLOWED_CHAT_ID e ALLOWED_USER_ID devem ser números inteiros válidos.");
    process.exit(1);
  }

  // Prevent dual instances running against same bot
  const lock = new SingleInstanceLock(join(process.cwd(), ".bridge.lock"));
  if (!lock.acquire()) {
    console.error("❌ Outra instância do Telegram Orchestrator já está em execução neste diretório!");
    process.exit(1);
  }

  const cleanup = () => {
    console.log("\n🛑 Encerrando Telegram Orchestrator Bridge...");
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
  console.error("💥 Erro fatal:", msg);
  process.exit(1);
});
