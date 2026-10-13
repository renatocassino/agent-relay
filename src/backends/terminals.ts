import { exec } from "child_process";
import { promisify } from "util";
import type { TerminalBackend, TerminalTarget } from "./types.ts";
import { OrcaCLI } from "../orca.ts";

const execAsync = promisify(exec);

export class OrcaBackend implements TerminalBackend {
  readonly name = "orca";
  private cli = new OrcaCLI();

  async send(targetId: string, text: string): Promise<boolean> {
    return this.cli.send(targetId, text, true);
  }

  async listTargets(): Promise<TerminalTarget[]> {
    const list = await this.cli.listTerminals();
    return list.map((t) => ({ id: t.handle, name: t.title }));
  }

  async resolveDefaultTarget(): Promise<string | null> {
    const list = await this.cli.listTerminals();
    const candidate = list.find(
      (t) => t.title.includes("telegram") || t.title.includes("coordinator") || t.title.includes("omp")
    );
    if (candidate) return candidate.handle;
    if (list.length > 0 && list[0]) return list[0].handle;
    return this.cli.createTerminal("telegram-coordinator", "echo 'Coordinator Ready'");
  }
}

export class TmuxBackend implements TerminalBackend {
  readonly name = "tmux";

  async send(targetId: string, text: string): Promise<boolean> {
    try {
      const escaped = text.replace(/"/g, '\\"');
      await execAsync(`tmux send-keys -t "${targetId}" "${escaped}" Enter`);
      return true;
    } catch {
      return false;
    }
  }

  async listTargets(): Promise<TerminalTarget[]> {
    try {
      const { stdout } = await execAsync(`tmux list-panes -a -F "#{session_name}:#{window_index}.#{pane_index}"`);
      return stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((id) => ({ id, name: `tmux pane ${id}` }));
    } catch {
      return [];
    }
  }

  async resolveDefaultTarget(): Promise<string | null> {
    const targets = await this.listTargets();
    return targets[0]?.id || null;
  }
}

export class CmuxBackend implements TerminalBackend {
  readonly name = "cmux";

  async send(targetId: string, text: string): Promise<boolean> {
    try {
      const escaped = text.replace(/"/g, '\\"');
      await execAsync(`cmux send -t "${targetId}" "${escaped}"`);
      return true;
    } catch {
      return false;
    }
  }

  async listTargets(): Promise<TerminalTarget[]> {
    try {
      const { stdout } = await execAsync("cmux list --json 2>/dev/null || cmux list 2>/dev/null");
      return stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const id = line.split(" ")[0] || line;
          return { id, name: line };
        });
    } catch {
      return [];
    }
  }

  async resolveDefaultTarget(): Promise<string | null> {
    const targets = await this.listTargets();
    return targets[0]?.id || null;
  }
}
