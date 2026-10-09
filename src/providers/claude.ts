import { runLineProcess } from './process.js';
import type { AgentAdapter, AgentEvent, AgentResult, AgentRunOptions } from './types.js';

export interface ClaudeAdapterOptions {
  bin?: string;
  model?: string;
  permissionMode?: string;
  allowedTools?: string[];
}

export interface ParsedClaudeLine {
  events: AgentEvent[];
  result?: AgentResult;
}

const DETAIL_KEYS = ['file_path', 'command', 'pattern', 'path', 'url', 'description'];

// Parses one line of `claude -p --output-format stream-json`.
export function parseClaudeLine(line: string): ParsedClaudeLine {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return { events: [] };
  }
  if (msg === null || typeof msg !== 'object') return { events: [] };

  if (msg.type === 'system' && msg.subtype === 'init' && typeof msg.session_id === 'string') {
    return { events: [{ kind: 'session', sessionId: msg.session_id }] };
  }
  if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
    const events: AgentEvent[] = [];
    for (const block of msg.message.content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        events.push({ kind: 'text', text: block.text.trim() });
      } else if (block?.type === 'tool_use') {
        const key = DETAIL_KEYS.find((k) => typeof block.input?.[k] === 'string');
        const detail = key ? String(block.input[key]).split('\n')[0]!.slice(0, 120) : '';
        events.push({ kind: 'tool', name: String(block.name), detail });
      }
    }
    return { events };
  }
  if (msg.type === 'result') {
    const ok = msg.subtype === 'success' && msg.is_error !== true;
    const summary = typeof msg.result === 'string' ? msg.result : '';
    return {
      events: [],
      result: {
        ok,
        summary,
        costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : 0,
        sessionId: typeof msg.session_id === 'string' ? msg.session_id : undefined,
        error: ok ? undefined : summary || String(msg.subtype ?? 'unknown error'),
      },
    };
  }
  return { events: [] };
}

const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'Bash'];

export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'claude';

  constructor(private readonly options: ClaudeAdapterOptions = {}) {}

  async run(options: AgentRunOptions): Promise<AgentResult> {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    const model = options.model ?? this.options.model;
    if (model) args.push('--model', model);
    if (options.budgetUsd !== undefined) args.push('--max-budget-usd', String(options.budgetUsd));
    if (options.readOnly) {
      args.push('--disallowedTools', ...WRITE_TOOLS);
    } else {
      args.push('--permission-mode', this.options.permissionMode ?? 'acceptEdits');
      if (this.options.allowedTools?.length) args.push('--allowedTools', ...this.options.allowedTools);
    }

    let result: AgentResult | undefined;
    let sessionId: string | undefined;
    const { exit, stderrTail } = await runLineProcess(this.options.bin ?? 'claude', args, {
      cwd: options.cwd,
      stdin: options.prompt,
      signal: options.signal,
      onLine: (line) => {
        const parsed = parseClaudeLine(line);
        for (const event of parsed.events) {
          if (event.kind === 'session') sessionId = event.sessionId;
          options.onEvent(event);
        }
        if (parsed.result) result = parsed.result;
      },
      onStderr: (text) => options.onEvent({ kind: 'stderr', text }),
    });

    if (result) return { ...result, sessionId: result.sessionId ?? sessionId };
    return {
      ok: false,
      summary: '',
      costUsd: 0,
      sessionId,
      error: `claude ${exit} without a result${stderrTail ? `: ${stderrTail}` : ''}`,
    };
  }
}
