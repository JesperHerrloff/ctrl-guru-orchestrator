export type AgentEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'stderr'; text: string };

export interface AgentRunOptions {
  cwd: string;
  prompt: string;
  model?: string;
  budgetUsd?: number;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
}

export interface AgentResult {
  ok: boolean;
  summary: string;
  costUsd: number;
  sessionId?: string;
  error?: string;
}

// One adapter per agent CLI. Adapters translate the CLI's own output into
// AgentEvents and never touch git: the orchestrator owns worktrees and commits.
export interface AgentAdapter {
  readonly name: string;
  run(options: AgentRunOptions): Promise<AgentResult>;
}
