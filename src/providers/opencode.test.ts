import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpencodeAdapter, parseOpencodeLine } from './opencode.js';
import type { AgentEvent } from './types.js';

// Lines captured from opencode v2.0.26, shortened.
const STEP_START = '{"type":"step_start","timestamp":1791589712455,"sessionID":"ses_1","part":{"id":"prt_1","sessionID":"ses_1","type":"step-start"}}';
const WRITE = '{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"write","state":{"status":"completed","input":{"content":"ok\\n","path":"b.txt"},"output":"Created file successfully: b.txt"}}}';
const SHELL = '{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"shell","state":{"status":"completed","input":{"command":"cat b.txt"},"output":"ok\\n"}}}';
const STEP_FINISH = '{"type":"step_finish","sessionID":"ses_1","part":{"type":"step-finish","reason":"tool-calls","cost":0.00537675,"tokens":{"input":6684,"output":23}}}';
const TEXT = '{"type":"text","sessionID":"ses_1","part":{"type":"text","text":"I have created `b.txt`."}}';
const ERROR = '{"type":"error","sessionID":"ses_1","error":{"type":"provider.no-route","message":"Model unavailable: openrouter/does-not/exist"}}';

describe('parseOpencodeLine', () => {
  it('reads the session id from any event', () => {
    expect(parseOpencodeLine(STEP_START)).toEqual({ events: [], sessionId: 'ses_1' });
  });

  it('reports tool calls with their main argument', () => {
    expect(parseOpencodeLine(WRITE).events).toEqual([{ kind: 'tool', name: 'write', detail: 'b.txt' }]);
    expect(parseOpencodeLine(SHELL).events).toEqual([{ kind: 'tool', name: 'shell', detail: 'cat b.txt' }]);
  });

  it('marks a failed tool call', () => {
    const failed = SHELL.replace('"status":"completed"', '"status":"error"');
    expect(parseOpencodeLine(failed).events).toEqual([{ kind: 'tool', name: 'shell', detail: 'cat b.txt (failed)' }]);
  });

  it('reads the cost of a finished step', () => {
    expect(parseOpencodeLine(STEP_FINISH).costUsd).toBe(0.00537675);
  });

  it('keeps text as an event and as the candidate summary', () => {
    expect(parseOpencodeLine(TEXT)).toMatchObject({
      events: [{ kind: 'text', text: 'I have created `b.txt`.' }],
      message: 'I have created `b.txt`.',
    });
  });

  it('reports errors', () => {
    expect(parseOpencodeLine(ERROR).error).toBe('Model unavailable: openrouter/does-not/exist');
  });

  it('ignores lines that are not JSON', () => {
    expect(parseOpencodeLine('nope')).toEqual({ events: [] });
  });
});

describe('OpencodeAdapter', () => {
  let dir: string;
  let bin: string;

  // A stand-in for the opencode binary: records its arguments and stdin, prints
  // the given lines, then exits with the given code.
  const fake = async (lines: string[], exitCode = 0, hang = false) => {
    const script = [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > "${dir}/args"`,
      `printf '%s' "$PWD" > "${dir}/pwd"`,
      `cat > "${dir}/stdin"`,
      ...lines.map((line) => `printf '%s\\n' '${line.replaceAll("'", `'\\''`)}'`),
      hang ? 'sleep 30' : `exit ${exitCode}`,
    ].join('\n');
    await writeFile(bin, script);
    await chmod(bin, 0o755);
  };

  const run = (extra: { readOnly?: boolean; budgetUsd?: number } = {}, adapterOptions: { model?: string } = { model: 'openrouter/test' }) => {
    const events: AgentEvent[] = [];
    const result = new OpencodeAdapter({ bin, ...adapterOptions }).run({
      cwd: dir,
      prompt: 'do the task',
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
      ...extra,
    });
    return { result, events };
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ctrl-guru-opencode-'));
    bin = join(dir, 'opencode');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('sums step costs and returns the last text as the summary', async () => {
    await fake([STEP_START, WRITE, STEP_FINISH, SHELL, STEP_FINISH, TEXT]);
    const { result, events } = run();

    expect(await result).toEqual({ ok: true, summary: 'I have created `b.txt`.', costUsd: 0.0107535, sessionId: 'ses_1' });
    expect(events[0]).toEqual({ kind: 'session', sessionId: 'ses_1' });
    expect(events.filter((event) => event.kind === 'tool')).toHaveLength(2);
  });

  it('auto-approves when working and uses the plan agent when read-only', async () => {
    const { readFile } = await import('node:fs/promises');
    await fake([TEXT]);
    await run().result;
    expect((await readFile(join(dir, 'args'), 'utf8')).trim().split('\n')).toEqual(
      ['run', '--standalone', '--format', 'json', '--model', 'openrouter/test', '--auto'],
    );
    expect(await readFile(join(dir, 'stdin'), 'utf8')).toBe('do the task');
    expect(await readFile(join(dir, 'pwd'), 'utf8')).toBe(dir);

    await run({ readOnly: true }).result;
    const args = (await readFile(join(dir, 'args'), 'utf8')).trim().split('\n');
    expect(args.slice(-2)).toEqual(['--agent', 'plan']);
    expect(args).not.toContain('--auto');
  });

  it('fails on an error event', async () => {
    await fake([ERROR], 1);
    expect(await run().result).toMatchObject({ ok: false, error: 'Model unavailable: openrouter/does-not/exist' });
  });

  it('stops the agent when the reported cost reaches the budget', async () => {
    await fake([STEP_START, STEP_FINISH, STEP_FINISH], 0, true);
    const started = Date.now();
    const outcome = await run({ budgetUsd: 0.01 }).result;

    expect(outcome).toMatchObject({ ok: false, costUsd: 0.0107535, error: 'stopped: the budget of $0.01 was reached' });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('refuses to run without a model', async () => {
    await fake([TEXT]);
    await expect(run({}, {}).result).rejects.toThrow(/opencode needs a model/);
  });
});
