import { openSync, closeSync, unlinkSync, existsSync, readFileSync, writeFileSync } from "fs";

export class SingleInstanceLock {
  private lockFd: number | null = null;

  constructor(private lockFilePath: string) {}

  acquire(): boolean {
    if (existsSync(this.lockFilePath)) {
      try {
        const pidStr = readFileSync(this.lockFilePath, "utf-8").trim();
        const pid = parseInt(pidStr, 10);
        if (!isNaN(pid)) {
          // Check if process is alive
          process.kill(pid, 0);
          // If no error, process is still running!
          return false;
        }
      } catch {
        // Process is dead, stale lock
      }
    }

    try {
      this.lockFd = openSync(this.lockFilePath, "w");
      writeFileSync(this.lockFilePath, process.pid.toString(), "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  release(): void {
    if (this.lockFd !== null) {
      try {
        closeSync(this.lockFd);
      } catch {}
      this.lockFd = null;
    }
    if (existsSync(this.lockFilePath)) {
      try {
        unlinkSync(this.lockFilePath);
      } catch {}
    }
  }
}
