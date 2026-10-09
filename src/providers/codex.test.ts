import { describe, expect, it } from 'vitest';
import { parseCodexLine } from './codex.js';

const line = (value: unknown) => JSON.stringify(value);

describe('parseCodexLine', () => {
  it('reads the thread id as the session', () => {
    expect(parseCodexLine(line({ type: 'thread.started', thread_id: 't1' })).events).toEqual([
      { kind: 'session', sessionId: 't1' },
    ]);
  });

  it('reports a started command without its shell wrapper', () => {
    const parsed = parseCodexLine(
      line({ type: 'item.started', item: { type: 'command_execution', command: '/bin/zsh -lc "npm test"' } }),
    );
    expect(parsed.events).toEqual([{ kind: 'tool', name: 'Shell', detail: '"npm test"' }]);
  });

  it('keeps agent messages as text and as the candidate summary', () => {
    const parsed = parseCodexLine(line({ type: 'item.completed', item: { type: 'agent_message', text: 'Created b.txt.\n' } }));
    expect(parsed).toEqual({ events: [{ kind: 'text', text: 'Created b.txt.' }], message: 'Created b.txt.' });
  });

  it('lists the paths of a file change', () => {
    const parsed = parseCodexLine(
      line({ type: 'item.completed', item: { type: 'file_change', changes: [{ path: 'a.ts', kind: 'add' }, { path: 'b.ts', kind: 'update' }] } }),
    );
    expect(parsed.events).toEqual([{ kind: 'tool', name: 'Edit', detail: 'a.ts, b.ts' }]);
  });

  it('marks the turn completed and reports token usage', () => {
    const parsed = parseCodexLine(
      line({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } }),
    );
    expect(parsed.completed).toBe(true);
    expect(parsed.events).toEqual([{ kind: 'text', text: 'tokens: 100 in (40 cached), 7 out' }]);
  });

  it('reports failures', () => {
    expect(parseCodexLine(line({ type: 'turn.failed', error: { message: 'quota' } })).error).toBe('quota');
    expect(parseCodexLine(line({ type: 'error', message: 'bad model' })).error).toBe('bad model');
  });

  it('ignores lines that are not JSON or not understood', () => {
    expect(parseCodexLine('nope')).toEqual({ events: [] });
    expect(parseCodexLine(line({ type: 'turn.started' }))).toEqual({ events: [] });
  });
});
