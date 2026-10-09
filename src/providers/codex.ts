import { runLineProcess } from './process.js';
import type { AgentAdapter, AgentEvent, AgentResult, AgentRunOptions } from './types.js';

export interface CodexAdapterOptions {
  bin?: string;
  model?: string;
  sandbox?: string;
}

export interface ParsedCodexLine {
  events: AgentEvent[];
  message?: string;
  completed?: boolean;
  error?: string;
}

// Parses one line of `codex exec --json`.
export function parseCodexLine(line: string): ParsedCodexLine {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return { events: [] };
  }
  if (msg === null || typeof msg !== 'object') return { events: [] };

  if (msg.type === 'thread.started' && typeof msg.thread_id === 'string') {
    return { events: [{ kind: 'session', sessionId: msg.thread_id }] };
  }
  if (msg.type === 'turn.completed') {
    const usage = msg.usage ?? {};
    const text = `tokens: ${usage.input_tokens ?? 0} in (${usage.cached_input_tokens ?? 0} cached), ${usage.output_tokens ?? 0} out`;
    return { events: [{ kind: 'text', text }], completed: true };
  }
  if (msg.type === 'turn.failed') {
    return { events: [], error: String(msg.error?.message ?? 'turn failed') };
  }
  if (msg.type === 'error') {
    return { events: [], error: String(msg.message ?? 'unknown error') };
  }

  const item = msg.item;
  if (msg.type === 'item.started' && item?.type === 'command_execution') {
    const command = String(item.command ?? '').replace(/^\S*sh -lc /, '');
    return { events: [{ kind: 'tool', name: 'Shell', detail: command.split('\n')[0]!.slice(0, 120) }] };
  }
  if (msg.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') {
    const text = item.text.trim();
    return text ? { events: [{ kind: 'text', text }], message: text } : { events: [] };
  }
  if (msg.type === 'item.completed' && item?.type === 'file_change' && Array.isArray(item.changes)) {
    const paths = item.changes.map((change: any) => String(change?.path ?? '')).filter(Boolean);
    return { events: [{ kind: 'tool', name: 'Edit', detail: paths.join(', ').slice(0, 120) }] };
  }
  return { events: [] };
}

// Codex reports token usage but no price, so costUsd is always 0 and dollar
// budgets do not limit Codex agents.
export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex';

  constructor(private readonly options: CodexAdapterOptions = {}) {}

  async run(options: AgentRunOptions): Promise<AgentResult> {
    const sandbox = options.readOnly ? 'read-only' : (this.options.sandbox ?? 'workspace-write');
    const args = ['exec', '--json', '--color', 'never', '--sandbox', sandbox];
    const model = options.model ?? this.options.model;
    if (model) args.push('--model', model);
    args.push('-');

    let sessionId: string | undefined;
    let summary = '';
    let completed = false;
    let error: string | undefined;
    const { exit, stderrTail } = await runLineProcess(this.options.bin ?? 'codex', args, {
      cwd: options.cwd,
      stdin: options.prompt,
      signal: options.signal,
      onLine: (line) => {
        const parsed = parseCodexLine(line);
        for (const event of parsed.events) {
          if (event.kind === 'session') sessionId = event.sessionId;
          options.onEvent(event);
        }
        if (parsed.message) summary = parsed.message;
        if (parsed.completed) completed = true;
        if (parsed.error) error = parsed.error;
      },
      onStderr: (text) => options.onEvent({ kind: 'stderr', text }),
    });

    if (completed && !error) return { ok: true, summary, costUsd: 0, sessionId };
    return {
      ok: false,
      summary,
      costUsd: 0,
      sessionId,
      error: error ?? `codex ${exit} without completing${stderrTail ? `: ${stderrTail}` : ''}`,
    };
  }
}
