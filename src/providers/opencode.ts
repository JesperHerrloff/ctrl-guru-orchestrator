import { runLineProcess } from './process.js';
import type { AgentAdapter, AgentEvent, AgentResult, AgentRunOptions } from './types.js';

export interface OpencodeAdapterOptions {
  bin?: string;
  model?: string;
}

export interface ParsedOpencodeLine {
  events: AgentEvent[];
  sessionId?: string;
  message?: string;
  costUsd?: number;
  error?: string;
}

const DETAIL_KEYS = ['path', 'filePath', 'command', 'pattern', 'url', 'description'];

// Parses one line of `opencode run --format json`.
export function parseOpencodeLine(line: string): ParsedOpencodeLine {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return { events: [] };
  }
  if (msg === null || typeof msg !== 'object') return { events: [] };
  const sessionId = typeof msg.sessionID === 'string' ? msg.sessionID : undefined;
  const part = msg.part ?? {};

  if (msg.type === 'error') {
    return { events: [], sessionId, error: String(msg.error?.message ?? msg.error?.type ?? 'unknown error') };
  }
  if (msg.type === 'text' && typeof part.text === 'string') {
    const text = part.text.trim();
    return text ? { events: [{ kind: 'text', text }], sessionId, message: text } : { events: [], sessionId };
  }
  if (msg.type === 'tool_use') {
    const input = part.state?.input ?? {};
    const key = DETAIL_KEYS.find((name) => typeof input[name] === 'string');
    const detail = key ? String(input[key]).split('\n')[0]!.slice(0, 120) : '';
    const failed = part.state?.status === 'error' ? ' (failed)' : '';
    return { events: [{ kind: 'tool', name: String(part.tool ?? 'tool'), detail: detail + failed }], sessionId };
  }
  if (msg.type === 'step_finish') {
    return { events: [], sessionId, costUsd: typeof part.cost === 'number' ? part.cost : 0 };
  }
  return { events: [], sessionId };
}

// Runs models from OpenRouter, or any other provider opencode is logged in to,
// through the opencode CLI. opencode has no sandbox: its agents can run any
// shell command. It also has no budget flag, so the adapter stops the agent
// itself once the reported cost passes the budget.
export class OpencodeAdapter implements AgentAdapter {
  readonly name = 'opencode';

  constructor(private readonly options: OpencodeAdapterOptions = {}) {}

  async run(options: AgentRunOptions): Promise<AgentResult> {
    const model = options.model ?? this.options.model;
    if (!model) {
      throw new Error('opencode needs a model, for example providers.opencode.model: openrouter/~google/gemini-flash-latest');
    }
    // The built-in plan agent refuses to edit files or run commands.
    const args = ['run', '--standalone', '--format', 'json', '--model', model, ...(options.readOnly ? ['--agent', 'plan'] : ['--auto'])];

    const overBudget = new AbortController();
    let sessionId: string | undefined;
    let summary = '';
    let costUsd = 0;
    let error: string | undefined;
    const { exit, stderrTail } = await runLineProcess(this.options.bin ?? 'opencode', args, {
      cwd: options.cwd,
      stdin: options.prompt,
      signal: AbortSignal.any([options.signal, overBudget.signal]),
      onLine: (line) => {
        const parsed = parseOpencodeLine(line);
        if (parsed.sessionId && !sessionId) {
          sessionId = parsed.sessionId;
          options.onEvent({ kind: 'session', sessionId });
        }
        for (const event of parsed.events) options.onEvent(event);
        if (parsed.message) summary = parsed.message;
        if (parsed.error) error = parsed.error;
        if (parsed.costUsd) {
          costUsd += parsed.costUsd;
          if (options.budgetUsd !== undefined && costUsd >= options.budgetUsd) overBudget.abort();
        }
      },
      onStderr: (text) => options.onEvent({ kind: 'stderr', text }),
    });

    if (overBudget.signal.aborted) {
      return { ok: false, summary, costUsd, sessionId, error: `stopped: the budget of $${options.budgetUsd} was reached` };
    }
    if (!error && exit === 'exited with code 0') return { ok: true, summary, costUsd, sessionId };
    return {
      ok: false,
      summary,
      costUsd,
      sessionId,
      error: error ?? `opencode ${exit}${stderrTail ? `: ${stderrTail}` : ''}`,
    };
  }
}
