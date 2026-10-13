export interface TerminalTarget {
  id: string;
  name: string;
}

export interface TerminalBackend {
  readonly name: string;
  send(targetId: string, text: string): Promise<boolean>;
  listTargets(): Promise<TerminalTarget[]>;
  resolveDefaultTarget(): Promise<string | null>;
}
