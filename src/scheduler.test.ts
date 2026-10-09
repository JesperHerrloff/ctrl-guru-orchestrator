import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import type { AgentAdapter, AgentResult, AgentRunOptions } from './providers/types.js';
import { parseVerdict, runScheduler } from './scheduler.js';
import { Store } from './store.js';
import { git, Worktrees } from './worktrees.js';

type Behavior = (taskId: string, options: AgentRunOptions) => Promise<Partial<AgentResult>>;

// Stands in for an agent CLI. By default it writes <taskId>.txt in its worktree.
class FakeAdapter implements AgentAdapter {
  readonly name = 'fake';
  readonly started: string[] = [];
  active = 0;
  maxActive = 0;

  constructor(private readonly behavior: Behavior = async () => ({})) {}

  async run(options: AgentRunOptions): Promise<AgentResult> {
    const taskId = basename(options.cwd);
    this.started.push(taskId);
    this.maxActive = Math.max(this.maxActive, ++this.active);
    try {
      if (!options.readOnly) await writeFile(join(options.cwd, `${taskId}.txt`), taskId);
      const result = await this.behavior(taskId, options);
      return { ok: true, summary: `${taskId} done`, costUsd: 0.5, ...result };
    } finally {
      this.active--;
    }
  }
}

let repo: string;
let worktrees: Worktrees;
let store: Store;

beforeEach(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), 'ctrl-guru-test-')));
  await git(repo, ['init', '-q', '-b', 'main']);
  await git(repo, ['config', 'user.email', 'test@example.com']);
  await git(repo, ['config', 'user.name', 'Test']);
  await writeFile(join(repo, 'README.md'), 'base\n');
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', 'init']);
  worktrees = await Worktrees.open(repo);
  store = new Store(join(worktrees.stateDir, 'state.db'));
});

afterEach(async () => {
  store.close();
  await rm(repo, { recursive: true, force: true });
});

async function start(
  yaml: string,
  adapter: AgentAdapter,
  signal = new AbortController().signal,
  reviewer: AgentAdapter = adapter,
) {
  const config = parseConfig(yaml);
  const baseSha = await worktrees.resolveSha('HEAD');
  store.createRun({ id: 'r1', createdAt: new Date().toISOString(), baseSha, config });
  return runScheduler({ store, worktrees, adapters: { claude: adapter, codex: reviewer }, runId: 'r1', signal });
}

const statusOf = () => Object.fromEntries(store.listTasks('r1').map((task) => [task.id, task.status]));

describe('runScheduler', () => {
  it('commits each task on its own branch and leaves the main checkout alone', async () => {
    const summary = await start('tasks:\n  - {id: a, prompt: x}\n  - {id: b, prompt: y}\n', new FakeAdapter());

    expect(summary.counts.done).toBe(2);
    expect(summary.costUsd).toBe(1);
    expect(await git(repo, ['ls-tree', '--name-only', 'ctrl-guru/r1/a'])).toBe('README.md\na.txt');
    expect(await git(repo, ['ls-tree', '--name-only', 'ctrl-guru/r1/b'])).toBe('README.md\nb.txt');
    expect(await git(repo, ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(repo, 'a.txt'))).toBe(false);
  });

  it('runs dependents after their dependencies, with the dependency changes merged in', async () => {
    const seen: Record<string, boolean> = {};
    const adapter = new FakeAdapter(async (taskId, options) => {
      if (taskId === 'b') seen.aInB = existsSync(join(options.cwd, 'a.txt'));
      return {};
    });
    await start('tasks:\n  - {id: b, prompt: y, dependsOn: [a]}\n  - {id: a, prompt: x}\n', adapter);

    expect(adapter.started).toEqual(['a', 'b']);
    expect(seen.aInB).toBe(true);
    expect(await git(repo, ['ls-tree', '--name-only', 'ctrl-guru/r1/b'])).toBe('README.md\na.txt\nb.txt');
  });

  it('retries a failing task, then marks it failed and blocks its dependents', async () => {
    const adapter = new FakeAdapter(async (taskId) => (taskId === 'a' ? { ok: false, error: 'boom' } : {}));
    const summary = await start(
      'tasks:\n  - {id: a, prompt: x}\n  - {id: b, prompt: y, dependsOn: [a]}\n  - {id: c, prompt: z, dependsOn: [b]}\n  - {id: d, prompt: w}\n',
      adapter,
    );

    expect(statusOf()).toEqual({ a: 'failed', b: 'blocked', c: 'blocked', d: 'done' });
    expect(adapter.started.filter((id) => id === 'a')).toHaveLength(2);
    expect(store.listTasks('r1')[0]).toMatchObject({ attempts: 2, error: 'boom', costUsd: 1 });
    expect(summary.counts).toMatchObject({ failed: 1, blocked: 2, done: 1 });
  });

  it('succeeds on a retry with a clean worktree', async () => {
    let calls = 0;
    const leftovers: boolean[] = [];
    const adapter = new FakeAdapter(async (_taskId, options) => {
      leftovers.push(existsSync(join(options.cwd, 'junk.txt')));
      await writeFile(join(options.cwd, 'junk.txt'), 'junk');
      return ++calls === 1 ? { ok: false, error: 'flaky' } : {};
    });
    await start('tasks:\n  - {id: a, prompt: x}\n', adapter);

    expect(statusOf()).toEqual({ a: 'done' });
    expect(leftovers).toEqual([false, false]);
  });

  it('respects maxParallel', async () => {
    const adapter = new FakeAdapter(() => new Promise((resolve) => setTimeout(() => resolve({}), 30)));
    await start('maxParallel: 2\ntasks:\n  - {id: a, prompt: x}\n  - {id: b, prompt: x}\n  - {id: c, prompt: x}\n', adapter);

    expect(adapter.maxActive).toBe(2);
    expect(statusOf()).toEqual({ a: 'done', b: 'done', c: 'done' });
  });

  it('never runs tasks with overlapping owned paths at the same time', async () => {
    const adapter = new FakeAdapter(() => new Promise((resolve) => setTimeout(() => resolve({}), 30)));
    await start(
      'tasks:\n  - {id: a, prompt: x, owns: [src/api/]}\n  - {id: b, prompt: x, owns: [src/api/users.ts]}\n',
      adapter,
    );

    expect(adapter.maxActive).toBe(1);
    expect(statusOf()).toEqual({ a: 'done', b: 'done' });
  });

  it('stops starting tasks when the run budget is reached', async () => {
    const summary = await start(
      'maxParallel: 1\nbudgetUsd: 1\ntasks:\n  - {id: a, prompt: x}\n  - {id: b, prompt: x}\n  - {id: c, prompt: x}\n',
      new FakeAdapter(),
    );

    expect(summary.budgetExceeded).toBe(true);
    expect(statusOf()).toEqual({ a: 'done', b: 'done', c: 'pending' });
  });

  it('fails a task that exceeds its timeout', async () => {
    const adapter = new FakeAdapter(
      (_taskId, options) =>
        new Promise((resolve) => options.signal.addEventListener('abort', () => resolve({ ok: false, error: 'killed' }))),
    );
    await start('defaults: {timeoutMinutes: 0.001, maxAttempts: 1}\ntasks:\n  - {id: a, prompt: x}\n', adapter);

    expect(store.listTasks('r1')[0]).toMatchObject({ status: 'failed', error: 'timed out after 0.001 minutes' });
  });

  it('leaves interrupted tasks pending so the run can be resumed', async () => {
    const controller = new AbortController();
    const adapter = new FakeAdapter((_taskId, options) => {
      controller.abort();
      return new Promise((resolve) =>
        options.signal.aborted ? resolve({ ok: false }) : options.signal.addEventListener('abort', () => resolve({ ok: false })),
      );
    });
    await start('maxParallel: 1\ntasks:\n  - {id: a, prompt: x}\n  - {id: b, prompt: x}\n', adapter, controller.signal);
    expect(statusOf()).toEqual({ a: 'pending', b: 'pending' });

    const resumed = new FakeAdapter();
    const summary = await runScheduler({
      store,
      worktrees,
      adapters: { claude: resumed },
      runId: 'r1',
      signal: new AbortController().signal,
    });
    expect(summary.counts.done).toBe(2);
  });

  it('runs setup commands in a fresh worktree before the agent', async () => {
    let sawSetup = false;
    const adapter = new FakeAdapter(async (_taskId, options) => {
      sawSetup = existsSync(join(options.cwd, 'node_modules/ready'));
      return {};
    });
    await start(
      'setup: ["mkdir node_modules && touch node_modules/ready"]\ntasks:\n  - {id: a, prompt: x}\n',
      adapter,
    );

    expect(sawSetup).toBe(true);
    expect(statusOf()).toEqual({ a: 'done' });
  });

  it('sends a task back with the output of a failing verify command and keeps its work', async () => {
    const prompts: string[] = [];
    const adapter = new FakeAdapter(async (_taskId, options) => {
      prompts.push(options.prompt);
      if (prompts.length === 2) await writeFile(join(options.cwd, 'fixed.txt'), 'ok');
      return {};
    });
    await start('verify: ["test -f a.txt", "test -f fixed.txt || (echo missing fixed.txt; exit 1)"]\ntasks:\n  - {id: a, prompt: x}\n', adapter);

    expect(statusOf()).toEqual({ a: 'done' });
    expect(prompts[0]).not.toContain('not accepted');
    expect(prompts[1]).toContain('not accepted');
    expect(prompts[1]).toContain('missing fixed.txt');
    expect(await git(repo, ['ls-tree', '--name-only', 'ctrl-guru/r1/a'])).toBe('README.md\na.txt\nfixed.txt');
  });

  it('fails a task that never passes verify and commits nothing', async () => {
    await start('verify: ["false"]\ntasks:\n  - {id: a, prompt: x}\n', new FakeAdapter());

    expect(store.listTasks('r1')[0]).toMatchObject({ status: 'failed', attempts: 2, error: 'verify `false` failed:' });
    expect(await git(repo, ['ls-tree', '--name-only', 'ctrl-guru/r1/a'])).toBe('README.md');
  });

  it('has another provider review the diff read-only and discards anything the reviewer writes', async () => {
    const reviews: AgentRunOptions[] = [];
    const reviewer = new FakeAdapter(async (_taskId, options) => {
      reviews.push(options);
      await writeFile(join(options.cwd, 'stray.txt'), 'oops');
      return { summary: 'Looks right.\nVERDICT: APPROVE', costUsd: 0.25 };
    });
    const summary = await start('review: {}\ntasks:\n  - {id: a, prompt: add a file}\n', new FakeAdapter(), undefined, reviewer);

    expect(statusOf()).toEqual({ a: 'done' });
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.readOnly).toBe(true);
    expect(reviews[0]!.prompt).toContain('add a file');
    expect(reviews[0]!.prompt).toContain('+++ b/a.txt');
    expect(summary.costUsd).toBe(0.75);
    expect(await git(repo, ['ls-tree', '--name-only', 'ctrl-guru/r1/a'])).toBe('README.md\na.txt');
    expect(existsSync(join(worktrees.pathFor('r1', 'a'), 'stray.txt'))).toBe(false);
  });

  it('sends a rejected task back to the agent with the review feedback', async () => {
    const prompts: string[] = [];
    const adapter = new FakeAdapter(async (_taskId, options) => {
      prompts.push(options.prompt);
      if (prompts.length === 2) await writeFile(join(options.cwd, 'a.txt'), 'handles empty input');
      return {};
    });
    let round = 0;
    const reviewer = new FakeAdapter(async () =>
      ++round === 1
        ? { summary: 'It does not handle empty input.\nVERDICT: REJECT' }
        : { summary: 'Fixed.\nVERDICT: APPROVE' },
    );
    await start('review: {}\ntasks:\n  - {id: a, prompt: x}\n', adapter, undefined, reviewer);

    expect(statusOf()).toEqual({ a: 'done' });
    expect(prompts[1]).toContain('It does not handle empty input.');
    expect(await git(repo, ['show', 'ctrl-guru/r1/a:a.txt'])).toBe('handles empty input');
  });

  it('fails a task when the review never approves or gives no verdict', async () => {
    const rejecting = new FakeAdapter(async () => ({ summary: 'VERDICT: REJECT' }));
    await start('review: {}\ntasks:\n  - {id: a, prompt: x}\n  - {id: b, prompt: y, dependsOn: [a]}\n', new FakeAdapter(), undefined, rejecting);
    expect(statusOf()).toEqual({ a: 'failed', b: 'blocked' });
    expect(store.listTasks('r1')[0]!.error).toBe('rejected in review by codex');
  });

  it('skips the review when the task changed nothing', async () => {
    const reviewer = new FakeAdapter();
    const adapter = new FakeAdapter(async (_taskId, options) => {
      await rm(join(options.cwd, 'a.txt'));
      return {};
    });
    await start('review: {}\ntasks:\n  - {id: a, prompt: x}\n', adapter, undefined, reviewer);

    expect(statusOf()).toEqual({ a: 'done' });
    expect(reviewer.started).toEqual([]);
  });
});

describe('parseVerdict', () => {
  it('uses the last verdict line', () => {
    expect(parseVerdict('VERDICT: REJECT\nactually fine\nverdict: approve')).toBe('approve');
    expect(parseVerdict('Problems found.\nVERDICT: REJECT\n')).toBe('reject');
    expect(parseVerdict('no verdict here')).toBeUndefined();
  });
});
