import { TelegramClient, type TelegramUpdate } from "./telegram.ts";
import { OrcaCLI } from "./orca.ts";
import { StateStore } from "./state.ts";
import { SessionWatcher } from "./session.ts";

export interface BridgeConfig {
  botToken: string;
  allowedChatId: number;
  allowedUserId: number;
  coordinatorHandle?: string;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export class BridgeEngine {
  private telegram: TelegramClient;
  private orca: OrcaCLI;
  private sessionWatcher: SessionWatcher;
  private messageQueue: string[] = [];
  private isProcessing = false;
  private isListening = true;
  private coordinatorHandle: string | null = null;
  private watcherTimer: NodeJS.Timeout | null = null;

  constructor(
    private config: BridgeConfig,
    private stateStore: StateStore
  ) {
    this.telegram = new TelegramClient(config.botToken);
    this.orca = new OrcaCLI();
    this.sessionWatcher = new SessionWatcher();
    const state = this.stateStore.read();
    this.isListening = state.isListening ?? true;
    this.coordinatorHandle = config.coordinatorHandle || state.coordinatorHandle || null;

    // Seed session watcher with whatever message was already in the session so we don't re-send it on startup
    const currentSettled = this.sessionWatcher.getLatestSettledAssistantMessage();
    if (currentSettled) {
      this.sessionWatcher.setLastDelivered(currentSettled.id);
    }
  }

  async init(): Promise<void> {
    const me = await this.telegram.getMe();
    console.log(`[BridgeEngine] Connected as Telegram Bot @${me.username || me.first_name} (id: ${me.id})`);

    await this.ensureCoordinator();
    this.startSettledWatcher();
  }

  private async ensureCoordinator(): Promise<string> {
    if (this.coordinatorHandle) {
      const terminals = await this.orca.listTerminals();
      const exists = terminals.find((t) => t.handle === this.coordinatorHandle);
      if (exists) {
        console.log(`[BridgeEngine] Bound to coordinator: ${this.coordinatorHandle} (${exists.title})`);
        return this.coordinatorHandle;
      }
    }

    const terminals = await this.orca.listTerminals();
    const candidate = terminals.find(
      (t) => t.title.includes("telegram") || t.title.includes("coordinator") || t.title.includes("omp")
    );

    if (candidate) {
      this.coordinatorHandle = candidate.handle;
      this.stateStore.save({ coordinatorHandle: this.coordinatorHandle });
      console.log(`[BridgeEngine] Discovered coordinator terminal: ${candidate.handle} (${candidate.title})`);
      return this.coordinatorHandle;
    }

    console.log("[BridgeEngine] Creating fresh Orca terminal for coordinator...");
    const newHandle = await this.orca.createTerminal("telegram-bridge-coordinator", "echo 'Coordinator Online'");
    if (!newHandle) {
      throw new Error("Failed to create coordinator terminal in Orca");
    }
    this.coordinatorHandle = newHandle;
    this.stateStore.save({ coordinatorHandle: newHandle });
    console.log(`[BridgeEngine] Created coordinator terminal: ${newHandle}`);
    return newHandle;
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
        console.error("[BridgeEngine] Error in polling loop, retrying in 3s:", msg);
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
      console.warn(`[BridgeEngine] Blocked unauthorized message from user ${userId} in chat ${chatId}`);
      await this.telegram.sendMessage(chatId, "⛔ Acesso não autorizado.");
      return;
    }

    const text = msg.text.trim();

    if (text.startsWith("/")) {
      const handled = await this.handleBuiltinCommand(text);
      if (handled) return;
    }

    if (!this.isListening) {
      console.log("[BridgeEngine] Listening is paused. Message ignored.");
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
          `🛠️ **Comandos da Ponte Telegram-Orca**\n\n` +
            `• /status - Ver status da conexão, terminal ativo e fila\n` +
            `• /listen - Começar a ouvir e enviar mensagens para o terminal\n` +
            `• /stop - Pausar a escuta de mensagens do Telegram\n` +
            `• /runs - Listar runs de orquestração do Orca\n` +
            `• /tasks <run_id> - Listar tarefas do run no Orca\n` +
            `• /clear - Limpar fila de mensagens pendentes\n` +
            `• /help - Exibir este guia de comandos`
        );
        return true;

      case "/status":
        const termHandle = this.coordinatorHandle || "Nenhum";
        const stateText = this.isListening ? "🟢 Ativa (Ouvindo)" : "🟡 Pausada";
        const procText = this.isProcessing ? "⏳ Processando instrução" : "💤 Ocioso";
        const queueCount = this.messageQueue.length;

        await this.telegram.sendMessage(
          this.config.allowedChatId,
          `📊 **Status do Telegram Orchestrator**\n\n` +
            `• Escuta: ${stateText}\n` +
            `• Estado: ${procText}\n` +
            `• Terminal Orca: \`${termHandle}\`\n` +
            `• Fila de mensagens: ${queueCount} pendente(s)`
        );
        return true;

      case "/listen":
        this.isListening = true;
        this.stateStore.save({ isListening: true });
        await this.telegram.sendMessage(
          this.config.allowedChatId,
          "👂 Escuta ativada! Mensagens enviadas aqui serão encaminhadas ao orquestrador Orca."
        );
        return true;

      case "/stop":
        this.isListening = false;
        this.stateStore.save({ isListening: false });
        await this.telegram.sendMessage(
          this.config.allowedChatId,
          "🛑 Escuta pausada! Novas mensagens não serão encaminhadas ao terminal até você enviar /listen."
        );
        return true;

      case "/runs":
        const runs = await this.orca.listRuns();
        if (runs.length === 0) {
          await this.telegram.sendMessage(this.config.allowedChatId, "Nenhum run ativo encontrado no Orca.");
        } else {
          const runList = runs
            .map((r) => `• \`${r.id}\`: ${r.objective.slice(0, 80)}${r.objective.length > 80 ? "..." : ""}`)
            .join("\n");
          await this.telegram.sendMessage(this.config.allowedChatId, `📋 **Runs do Orca:**\n\n${runList}`);
        }
        return true;

      case "/tasks":
        const runId = parts[1];
        if (!runId) {
          await this.telegram.sendMessage(this.config.allowedChatId, "Uso: /tasks <run_id>");
          return true;
        }
        const tasks = await this.orca.listTasks(runId);
        if (tasks.length === 0) {
          await this.telegram.sendMessage(this.config.allowedChatId, `Nenhuma tarefa encontrada para o run ${runId}.`);
        } else {
          const taskList = tasks.map((t) => `• [${t.status}] \`${t.id}\`: ${t.task_title}`).join("\n");
          await this.telegram.sendMessage(
            this.config.allowedChatId,
            `📋 **Tarefas do Run \`${runId}\`:**\n\n${taskList}`
          );
        }
        return true;

      case "/clear":
        this.messageQueue = [];
        await this.telegram.sendMessage(this.config.allowedChatId, "🧹 Fila de mensagens pendentes limpa.");
        return true;
    }

    return false;
  }

  private async enqueueMessage(text: string): Promise<void> {
    if (this.isProcessing) {
      console.log(`[BridgeEngine] Coordinator busy. Queuing message: "${text}"`);
      this.messageQueue.push(text);
      await this.telegram.sendMessage(
        this.config.allowedChatId,
        `⏳ Orquestrador ocupado. Mensagem colocada na fila (${this.messageQueue.length} na frente).`
      );
      return;
    }

    await this.processMessage(text);
  }

  private async processMessage(text: string): Promise<void> {
    this.isProcessing = true;
    try {
      const handle = await this.ensureCoordinator();
      console.log(`[BridgeEngine] Sending prompt to terminal ${handle}: "${text}"`);

      const sent = await this.orca.send(handle, text, true);
      if (!sent) {
        await this.telegram.sendMessage(this.config.allowedChatId, "❌ Falha ao enviar comando para o terminal Orca.");
      }
    } finally {
      setTimeout(() => {
        this.isProcessing = false;
        if (this.messageQueue.length > 0) {
          const next = this.messageQueue.shift();
          if (next) {
            void this.processMessage(next);
          }
        }
      }, 3000);
    }
  }

  private startSettledWatcher(): void {
    if (this.watcherTimer) clearInterval(this.watcherTimer);

    // Poll every 1.5s for completed assistant messages only (stopReason: "stop")
    this.watcherTimer = setInterval(async () => {
      if (!this.isListening) return;

      const settled = this.sessionWatcher.getLatestSettledAssistantMessage();
      if (settled) {
        this.sessionWatcher.setLastDelivered(settled.id);
        console.log(`[BridgeEngine] Delivering settled response (${settled.id}) to Telegram...`);
        await this.telegram.sendMessage(this.config.allowedChatId, settled.text);
      }
    }, 1500);
  }
}
