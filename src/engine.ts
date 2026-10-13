import { TelegramClient, type TelegramUpdate } from "./telegram.ts";
import { StateStore } from "./state.ts";
import { UniversalAgentWatcher } from "./backends/agents.ts";
import { OrcaBackend, TmuxBackend, CmuxBackend } from "./backends/terminals.ts";
import type { TerminalBackend } from "./backends/types.ts";
import { OrcaCLI } from "./orca.ts";

export interface BridgeConfig {
  botToken: string;
  allowedChatId: number;
  allowedUserId: number;
  terminalBackend?: "orca" | "tmux" | "cmux";
  targetId?: string;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export class BridgeEngine {
  private telegram: TelegramClient;
  private backend: TerminalBackend;
  private orcaCli = new OrcaCLI();
  private agentWatcher: UniversalAgentWatcher;
  private messageQueue: string[] = [];
  private isProcessing = false;
  private isListening = true;
  private targetId: string | null = null;
  private watcherTimer: NodeJS.Timeout | null = null;
  private lastDeliveredId: string | null = null;

  constructor(
    private config: BridgeConfig,
    private stateStore: StateStore
  ) {
    this.telegram = new TelegramClient(config.botToken);
    this.agentWatcher = new UniversalAgentWatcher();

    const backendType = config.terminalBackend || "orca";
    if (backendType === "tmux") {
      this.backend = new TmuxBackend();
    } else if (backendType === "cmux") {
      this.backend = new CmuxBackend();
    } else {
      this.backend = new OrcaBackend();
    }

    const state = this.stateStore.read();
    this.isListening = state.isListening ?? true;
    this.targetId = config.targetId || state.coordinatorHandle || null;

    const initial = this.agentWatcher.getLatestSettled();
    if (initial) {
      this.lastDeliveredId = initial.id;
    }
  }

  async init(): Promise<void> {
    const me = await this.telegram.getMe();
    console.log(`[BridgeEngine] Connected as @${me.username || me.first_name} (id: ${me.id})`);
    console.log(`[BridgeEngine] Active backend: ${this.backend.name}`);

    await this.ensureTarget();
    this.startSettledWatcher();
  }

  private async ensureTarget(): Promise<string> {
    if (this.targetId) {
      const list = await this.backend.listTargets();
      if (list.some((t) => t.id === this.targetId)) {
        return this.targetId;
      }
    }

    const resolved = await this.backend.resolveDefaultTarget();
    if (!resolved) {
      throw new Error(`Failed to find target on backend ${this.backend.name}`);
    }
    this.targetId = resolved;
    this.stateStore.save({ coordinatorHandle: resolved });
    console.log(`[BridgeEngine] Bound target on ${this.backend.name}: ${resolved}`);
    return resolved;
  }

  async startPolling(): Promise<void> {
    console.log("[BridgeEngine] Starting Telegram long polling loop...");
    let offset = this.stateStore.read().lastUpdateId;

    while (true) {
      try {
        const updates = await this.telegram.getUpdates(offset);
        for (const update of updates) {
          offset = update.update_id + 1;
          this.stateStore.save({ lastUpdateId: offset });
          await this.handleUpdate(update);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error("[BridgeEngine] Polling error, retrying:", msg);
        await delay(3000);
      }
    }
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const msg = update.message;
    if (!msg || !msg.text) return;

    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (chatId !== this.config.allowedChatId || userId !== this.config.allowedUserId) {
      console.warn(`[BridgeEngine] Blocked unauthorized message from user ${userId}`);
      await this.telegram.sendMessage(chatId, "⛔ Acesso não autorizado.");
      return;
    }

    const text = msg.text.trim();

    if (text.startsWith("/")) {
      const handled = await this.handleBuiltinCommand(text);
      if (handled) return;
    }

    if (!this.isListening) {
      await this.telegram.sendMessage(
        this.config.allowedChatId,
        "⏸️ A escuta de mensagens está pausada. Use /listen para reativar."
      );
      return;
    }

    await this.enqueueMessage(text);
  }

  private async handleBuiltinCommand(cmd: string): Promise<boolean> {
    const parts = cmd.split(" ");
    const command = parts[0].toLowerCase();

    switch (command) {
      case "/help":
        await this.telegram.sendMessage(
          this.config.allowedChatId,
          `🛠️ **Comandos da Ponte Universal**\n\n` +
            `• /status - Ver backend ativo, target e fila\n` +
            `• /listen - Ativar envio de mensagens ao terminal\n` +
            `• /stop - Pausar envio de mensagens\n` +
            `• /backend <orca|tmux|cmux> - Alternar backend de terminal\n` +
            `• /targets - Listar targets/janelas disponíveis\n` +
            `• /runs - Listar runs (quando no Orca)\n` +
            `• /tasks <run_id> - Listar tarefas do run no Orca\n` +
            `• /clear - Limpar fila de mensagens\n` +
            `• /help - Guia de comandos`
        );
        return true;

      case "/status":
        const target = this.targetId || "Nenhum";
        const stateText = this.isListening ? "🟢 Ativa (Ouvindo)" : "🟡 Pausada";
        const procText = this.isProcessing ? "⏳ Processando" : "💤 Ocioso";
        const queueCount = this.messageQueue.length;

        await this.telegram.sendMessage(
          this.config.allowedChatId,
          `📊 **Status da Ponte**\n\n` +
            `• Backend: \`${this.backend.name}\`\n` +
            `• Alvo: \`${target}\`\n` +
            `• Escuta: ${stateText}\n` +
            `• Estado: ${procText}\n` +
            `• Fila: ${queueCount} mensagem(ns)`
        );
        return true;

      case "/backend":
        const newBackend = parts[1]?.toLowerCase();
        if (newBackend === "tmux") {
          this.backend = new TmuxBackend();
        } else if (newBackend === "cmux") {
          this.backend = new CmuxBackend();
        } else if (newBackend === "orca") {
          this.backend = new OrcaBackend();
        } else {
          await this.telegram.sendMessage(this.config.allowedChatId, "Uso: /backend <orca|tmux|cmux>");
          return true;
        }
        this.targetId = null;
        await this.ensureTarget();
        await this.telegram.sendMessage(
          this.config.allowedChatId,
          `🔄 Backend alterado para \`${this.backend.name}\`. Novo alvo: \`${this.targetId}\``
        );
        return true;

      case "/targets":
        const list = await this.backend.listTargets();
        if (list.length === 0) {
          await this.telegram.sendMessage(this.config.allowedChatId, "Nenhum alvo encontrado no backend ativo.");
        } else {
          const formatted = list.map((t) => `• \`${t.id}\`: ${t.name}`).join("\n");
          await this.telegram.sendMessage(
            this.config.allowedChatId,
            `🎯 **Alvos no ${this.backend.name}:**\n\n${formatted}`
          );
        }
        return true;

      case "/listen":
        this.isListening = true;
        this.stateStore.save({ isListening: true });
        await this.telegram.sendMessage(this.config.allowedChatId, "👂 Escuta ativada!");
        return true;

      case "/stop":
        this.isListening = false;
        this.stateStore.save({ isListening: false });
        await this.telegram.sendMessage(this.config.allowedChatId, "🛑 Escuta pausada!");
        return true;

      case "/runs":
        const runs = await this.orcaCli.listRuns();
        if (runs.length === 0) {
          await this.telegram.sendMessage(this.config.allowedChatId, "Nenhum run ativo encontrado no Orca.");
        } else {
          const runList = runs.map((r) => `• \`${r.id}\`: ${r.objective.slice(0, 80)}`).join("\n");
          await this.telegram.sendMessage(this.config.allowedChatId, `📋 **Runs Orca:**\n\n${runList}`);
        }
        return true;

      case "/tasks":
        const runId = parts[1];
        if (!runId) {
          await this.telegram.sendMessage(this.config.allowedChatId, "Uso: /tasks <run_id>");
          return true;
        }
        const tasks = await this.orcaCli.listTasks(runId);
        if (tasks.length === 0) {
          await this.telegram.sendMessage(this.config.allowedChatId, `Nenhuma tarefa para o run ${runId}.`);
        } else {
          const taskList = tasks.map((t) => `• [${t.status}] \`${t.id}\`: ${t.task_title}`).join("\n");
          await this.telegram.sendMessage(this.config.allowedChatId, `📋 **Tarefas \`${runId}\`:**\n\n${taskList}`);
        }
        return true;

      case "/clear":
        this.messageQueue = [];
        await this.telegram.sendMessage(this.config.allowedChatId, "🧹 Fila limpa.");
        return true;
    }

    return false;
  }

  private async enqueueMessage(text: string): Promise<void> {
    if (this.isProcessing) {
      this.messageQueue.push(text);
      await this.telegram.sendMessage(
        this.config.allowedChatId,
        `⏳ Orquestrador ocupado. Mensagem enfileirada (${this.messageQueue.length} na frente).`
      );
      return;
    }

    await this.processMessage(text);
  }

  private async processMessage(text: string): Promise<void> {
    this.isProcessing = true;
    try {
      const handle = await this.ensureTarget();
      console.log(`[BridgeEngine] Dispatching to ${this.backend.name} [${handle}]: "${text}"`);
      const sent = await this.backend.send(handle, text);
      if (!sent) {
        await this.telegram.sendMessage(this.config.allowedChatId, `❌ Falha ao enviar para ${this.backend.name}.`);
      }
    } finally {
      setTimeout(() => {
        this.isProcessing = false;
        if (this.messageQueue.length > 0) {
          const next = this.messageQueue.shift();
          if (next) void this.processMessage(next);
        }
      }, 3000);
    }
  }

  private startSettledWatcher(): void {
    if (this.watcherTimer) clearInterval(this.watcherTimer);

    this.watcherTimer = setInterval(async () => {
      if (!this.isListening) return;

      const settled = this.agentWatcher.getLatestSettled();
      if (settled && settled.id !== this.lastDeliveredId) {
        this.lastDeliveredId = settled.id;
        console.log(`[BridgeEngine] Delivering ${settled.source} response to Telegram...`);
        await this.telegram.sendMessage(this.config.allowedChatId, settled.text);
      }
    }, 1500);
  }
}
