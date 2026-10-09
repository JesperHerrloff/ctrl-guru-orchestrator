import { describe, expect, it } from 'vitest';
import { parseClaudeLine } from './claude.js';

describe('parseClaudeLine', () => {
  it('reads the session id from the init message', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' });
    expect(parseClaudeLine(line).events).toEqual([{ kind: 'session', sessionId: 'abc' }]);
  });

  it('turns assistant content into text and tool events', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: ' Adding the file. ' },
          { type: 'tool_use', name: 'Write', input: { file_path: 'src/a.ts', content: 'x' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test\necho done' } },
        ],
      },
    });
    expect(parseClaudeLine(line).events).toEqual([
      { kind: 'text', text: 'Adding the file.' },
      { kind: 'tool', name: 'Write', detail: 'src/a.ts' },
      { kind: 'tool', name: 'Bash', detail: 'npm test' },
    ]);
  });

  it('reads a successful result', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'Done.',
      total_cost_usd: 0.12,
      session_id: 'abc',
    });
    expect(parseClaudeLine(line).result).toEqual({
      ok: true,
      summary: 'Done.',
      costUsd: 0.12,
      sessionId: 'abc',
      error: undefined,
    });
  });

  it('reports a failed result with its subtype', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 2 });
    expect(parseClaudeLine(line).result).toMatchObject({ ok: false, costUsd: 2, error: 'error_max_budget_usd' });
  });

  it('ignores lines that are not JSON or not understood', () => {
    expect(parseClaudeLine('not json')).toEqual({ events: [] });
    expect(parseClaudeLine('{"type":"user"}')).toEqual({ events: [] });
  });
});
