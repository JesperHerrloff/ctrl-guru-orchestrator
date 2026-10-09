import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentAdapter, AgentEvent, AgentResult, AgentRunOptions } from './types.js';

export interface ClaudeAdapterOptions {
  bin?: string;
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

export class ClaudeAdapter implements AgentAdapter {
  readonly name = 'claude';

  constructor(private readonly options: ClaudeAdapterOptions = {}) {}

  run(options: AgentRunOptions): Promise<AgentResult> {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      this.options.permissionMode ?? 'acceptEdits',
    ];
    if (options.model) args.push('--model', options.model);
    if (options.budgetUsd !== undefined) args.push('--max-budget-usd', String(options.budgetUsd));
    if (this.options.allowedTools?.length) args.push('--allowedTools', ...this.options.allowedTools);

    return new Promise((resolve, reject) => {
      const child = spawn(this.options.bin ?? 'claude', args, {
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: options.signal,
      });

      let result: AgentResult | undefined;
      let sessionId: string | undefined;
      let stderrTail = '';

      createInterface({ input: child.stdout }).on('line', (line) => {
        const parsed = parseClaudeLine(line);
        for (const event of parsed.events) {
          if (event.kind === 'session') sessionId = event.sessionId;
          options.onEvent(event);
        }
        if (parsed.result) result = parsed.result;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-2000);
        options.onEvent({ kind: 'stderr', text: chunk.trimEnd() });
      });

      child.on('error', (err) => {
        if (err.name === 'AbortError') return; // 'close' still fires and settles the promise
        reject(new Error(`Could not start claude: ${err.message}`));
      });
      child.on('close', (code, signal) => {
        if (result) return resolve({ ...result, sessionId: result.sessionId ?? sessionId });
        const reason = signal ? `killed by ${signal}` : `exited with code ${code}`;
        resolve({
          ok: false,
          summary: '',
          costUsd: 0,
          sessionId,
          error: `claude ${reason} without a result${stderrTail ? `: ${stderrTail.trim()}` : ''}`,
        });
      });

      child.stdin.on('error', () => {}); // the process may exit before reading the prompt
      child.stdin.end(options.prompt);
    });
  }
}
