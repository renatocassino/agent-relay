import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface SettledResponse {
  id: string;
  source: string;
  text: string;
}

export interface AgentWatcher {
  readonly name: string;
  getLatestSettled(): SettledResponse | null;
}

function findLatestMtimeFile(dir: string, patternSuffix: string): string | null {
  if (!existsSync(dir)) return null;
  let latestPath: string | null = null;
  let latestMtime = 0;

  const walk = (current: string): void => {
    try {
      const entries = readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith(patternSuffix)) {
          const mtime = statSync(full).mtimeMs;
          if (mtime > latestMtime) {
            latestMtime = mtime;
            latestPath = full;
          }
        }
      }
    } catch {}
  };

  walk(dir);
  return latestPath;
}

export class OmpSessionWatcher implements AgentWatcher {
  readonly name = "omp";
  private baseDir = join(homedir(), ".omp", "agent", "sessions");

  getLatestSettled(): SettledResponse | null {
    const file = findLatestMtimeFile(this.baseDir, ".jsonl");
    if (!file) return null;

    try {
      const lines = readFileSync(file, "utf-8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (!line) continue;
        try {
          const row = JSON.parse(line) as {
            type?: string;
            id?: string;
            message?: { role?: string; stopReason?: string; content?: Array<{ type?: string; text?: string }> };
          };
          if (row.type === "message" && row.message?.role === "assistant" && row.message?.stopReason === "stop") {
            const texts = (row.message.content || []).filter((c) => c.type === "text").map((c) => c.text || "");
            if (texts.length > 0 && row.id) {
              return { id: `omp_${row.id}`, source: "omp", text: texts.join("\n").trim() };
            }
          }
        } catch {}
      }
    } catch {}
    return null;
  }
}

export class ClaudeSessionWatcher implements AgentWatcher {
  readonly name = "claude";
  private baseDir = join(homedir(), ".claude", "projects");

  getLatestSettled(): SettledResponse | null {
    const file = findLatestMtimeFile(this.baseDir, ".jsonl");
    if (!file) return null;

    try {
      const lines = readFileSync(file, "utf-8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (!line) continue;
        try {
          const row = JSON.parse(line) as {
            type?: string;
            uuid?: string;
            message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
          };
          if (row.type === "assistant" || row.message?.role === "assistant") {
            const contents = row.message?.content || [];
            const texts = contents.filter((c) => c.type === "text").map((c) => c.text || "");
            if (texts.length > 0) {
              return {
                id: `claude_${row.uuid || i}`,
                source: "claude",
                text: texts.join("\n").trim(),
              };
            }
          }
        } catch {}
      }
    } catch {}
    return null;
  }
}

export class CodexSessionWatcher implements AgentWatcher {
  readonly name = "codex";
  private baseDir = join(homedir(), ".codex", "sessions");

  getLatestSettled(): SettledResponse | null {
    const file = findLatestMtimeFile(this.baseDir, ".jsonl");
    if (!file) return null;

    try {
      const lines = readFileSync(file, "utf-8").split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim();
        if (!line) continue;
        try {
          const row = JSON.parse(line) as {
            type?: string;
            ordinal?: number;
            payload?: { type?: string; role?: string; content?: Array<{ type?: string; text?: string }> };
          };
          if (row.type === "response_item" && row.payload?.type === "message" && row.payload?.role === "assistant") {
            const texts = (row.payload.content || []).map((c) => c.text || "");
            if (texts.length > 0) {
              return {
                id: `codex_${row.ordinal || i}`,
                source: "codex",
                text: texts.join("\n").trim(),
              };
            }
          }
        } catch {}
      }
    } catch {}
    return null;
  }
}

export class UniversalAgentWatcher {
  private watchers: AgentWatcher[] = [
    new OmpSessionWatcher(),
    new ClaudeSessionWatcher(),
    new CodexSessionWatcher(),
  ];

  getLatestSettled(): SettledResponse | null {
    for (const w of this.watchers) {
      const res = w.getLatestSettled();
      if (res && res.text) return res;
    }
    return null;
  }
}
