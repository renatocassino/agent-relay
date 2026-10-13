import { readdirSync, statSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface SessionAssistantMessage {
  id: string;
  text: string;
  timestamp: string;
}

export class SessionWatcher {
  private lastDeliveredMessageId: string | null = null;
  private sessionsBaseDir: string;

  constructor() {
    this.sessionsBaseDir = join(homedir(), ".omp", "agent", "sessions");
  }

  setLastDelivered(id: string): void {
    this.lastDeliveredMessageId = id;
  }

  getLatestSettledAssistantMessage(): SessionAssistantMessage | null {
    const sessionFile = this.findLatestSessionFile(this.sessionsBaseDir);
    if (!sessionFile) return null;

    try {
      const content = readFileSync(sessionFile, "utf-8");
      const lines = content.split("\n");
      let latest: SessionAssistantMessage | null = null;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as {
            type?: string;
            id?: string;
            timestamp?: string;
            message?: {
              role?: string;
              stopReason?: string;
              content?: Array<{ type?: string; text?: string }>;
            };
          };

          if (
            entry.type === "message" &&
            entry.message?.role === "assistant" &&
            entry.message?.stopReason === "stop"
          ) {
            const texts = (entry.message.content || [])
              .filter((c) => c.type === "text" && typeof c.text === "string")
              .map((c) => c.text as string);

            if (texts.length > 0 && entry.id) {
              latest = {
                id: entry.id,
                text: texts.join("\n").trim(),
                timestamp: entry.timestamp || "",
              };
            }
          }
        } catch {
          // ignore corrupted or incomplete lines during file write
        }
      }

      if (latest && latest.id !== this.lastDeliveredMessageId) {
        return latest;
      }
      return null;
    } catch {
      return null;
    }
  }

  private findLatestSessionFile(dir: string): string | null {
    let latestPath: string | null = null;
    let latestMtime = 0;

    const walk = (currentDir: string): void => {
      try {
        const entries = readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(currentDir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            const mtime = statSync(fullPath).mtimeMs;
            if (mtime > latestMtime) {
              latestMtime = mtime;
              latestPath = fullPath;
            }
          }
        }
      } catch {}
    };

    walk(dir);
    return latestPath;
  }
}
