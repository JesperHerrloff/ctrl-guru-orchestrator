import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseConfig } from '../config.js';
import type { AgentAdapter } from '../providers/types.js';
import { runScheduler } from '../scheduler.js';
import { Store, type RunRecord } from '../store.js';
import { git, Worktrees } from '../worktrees.js';
import { App, diffLines, logLines } from './App.js';

let repo: string;
let worktrees: Worktrees;
let store: Store;
let run: RunRecord;

// Task "a" adds a.txt and succeeds; task "b" fails.
const adapter: AgentAdapter = {
  name: 'fake',
  async run(options) {
    if (options.cwd.endsWith('/b')) return { ok: false, summary: '', costUsd: 0.25, error: 'boom' };
    options.onEvent({ kind: 'text', text: 'writing a.txt' });
    await writeFile(join(options.cwd, 'a.txt'), 'hello\n');
    return { ok: true, summary: 'done', costUsd: 0.5 };
  },
};

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'ctrl-guru-tui-')));
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(join(repo, 'README.md'), 'base\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  worktrees = await Worktrees.open(repo);
  store = new Store(join(worktrees.stateDir, 'state.db'));
  const config = parseConfig('defaults: {maxAttempts: 1}\ntasks:\n  - {id: a, prompt: x}\n  - {id: b, prompt: y, provider: codex}\n');
  run = { id: 'r1', createdAt: new Date().toISOString(), baseSha: await worktrees.resolveSha('HEAD'), config };
  store.createRun(run);
  await runScheduler({ store, worktrees, adapters: { claude: adapter, codex: adapter }, runId: 'r1', signal: new AbortController().signal });
});

afterEach(async () => {
  for (const ui of opened.splice(0)) ui.unmount();
  store.close();
  await rm(repo, { recursive: true, force: true });
});

const opened: ReturnType<typeof render>[] = [];
const open = (active = false, onStop = () => {}) => {
  const ui = render(<App store={store} worktrees={worktrees} run={run} active={active} onStop={onStop} pollMs={10} />);
  opened.push(ui);
  return ui;
};

const frameWith = (ui: ReturnType<typeof render>, text: string) =>
  vi.waitFor(() => expect(ui.lastFrame()).toContain(text), { timeout: 3000 });

describe('App', () => {
  it('lists the tasks with status, provider and cost, and shows the log of the selected task', async () => {
    const ui = open();
    await frameWith(ui, 'writing a.txt');
    const frame = ui.lastFrame()!;
    expect(frame).toContain('run r1 · idle · 1/2 done · 1 failed · $0.75');
    expect(frame).toMatch(/✔ a\s+claude\s+\$0\.50/);
    expect(frame).toMatch(/✘ b\s+codex\s+\$0\.25/);
    expect(frame).toContain('[done]');
  });

  it('follows the selection to another task', async () => {
    const ui = open();
    await frameWith(ui, 'writing a.txt');
    ui.stdin.write('j');
    await frameWith(ui, 'ERROR boom');
    expect(ui.lastFrame()).toContain('log of b');
  });

  it('shows the diff of a task', async () => {
    const ui = open();
    await frameWith(ui, 'writing a.txt');
    ui.stdin.write('d');
    await frameWith(ui, '+hello');
    expect(ui.lastFrame()).toContain('+++ b/a.txt');
  });

  it('merges a finished task after confirmation', async () => {
    const ui = open();
    await frameWith(ui, 'writing a.txt');
    ui.stdin.write('m');
    await frameWith(ui, 'Merge ctrl-guru/r1/a into main? y/n');
    ui.stdin.write('y');
    await frameWith(ui, 'Merged a.');
    expect(await git(repo, ['ls-files'])).toBe('README.md\na.txt');
    await frameWith(ui, '⇄');
  });

  it('does not merge without confirmation or when the task failed', async () => {
    const ui = open();
    await frameWith(ui, 'writing a.txt');
    ui.stdin.write('m');
    await frameWith(ui, 'y/n');
    ui.stdin.write('n');
    await frameWith(ui, 'm merge');
    ui.stdin.write('j');
    await frameWith(ui, 'log of b');
    ui.stdin.write('m');
    await frameWith(ui, 'Only a finished task can be merged.');
    expect(await git(repo, ['ls-files'])).toBe('README.md');
  });

  it('asks to stop the agents instead of quitting while a run is active', async () => {
    const onStop = vi.fn();
    const ui = open(true, onStop);
    await frameWith(ui, 'running');
    ui.stdin.write('q');
    await frameWith(ui, 'stopping agents');
    expect(onStop).toHaveBeenCalledOnce();
  });
});

describe('line formatting', () => {
  it('indents the continuation lines of a multi-line event', () => {
    const lines = logLines([{ ts: new Date().toISOString(), taskId: 'a', kind: 'text', data: 'one\ntwo' }]);
    expect(lines.map((line) => line.text.slice(9))).toEqual(['one', 'two']);
    expect(lines[1]!.text.startsWith(' '.repeat(8))).toBe(true);
  });

  it('colors added and removed diff lines', () => {
    expect(diffLines('@@ -1 +1 @@\n-old\n+new').map((line) => line.color)).toEqual(['cyan', 'red', 'green']);
  });
});
