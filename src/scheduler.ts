import { ownsOverlap, PROVIDERS, type TaskSpec } from './config.js';
import type { AgentAdapter, AgentEvent } from './providers/types.js';
import { runShell } from './shell.js';
import type { Store, TaskStatus } from './store.js';
import type { Worktrees } from './worktrees.js';

export interface SchedulerOptions {
  store: Store;
  worktrees: Worktrees;
  adapters: Record<string, AgentAdapter>;
  runId: string;
  // Aborting stops running agents and leaves their tasks pending for a resume.
  signal: AbortSignal;
  log?: (taskId: string, line: string) => void;
}

export interface RunSummary {
  counts: Record<TaskStatus, number>;
  costUsd: number;
  budgetExceeded: boolean;
}

const PREAMBLE = `You are one agent in a team. You work alone in an isolated git worktree, which is your current directory.
Complete the task below. Stay inside this directory and do not run git commit or push: your changes are committed for you when you finish.
End with a short summary of what you changed and anything a reviewer should know.

Task:
`;

const RETRY_NOTE = `

Your previous attempt at this task is still in this directory, but it was not accepted. Keep what is good and fix the following:
`;

const MAX_DIFF_CHARS = 60_000;
const MAX_FEEDBACK_CHARS = 4_000;

function reviewPrompt(task: string, diff: string): string {
  const shown =
    diff.length > MAX_DIFF_CHARS
      ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated: read the files for the rest]`
      : diff;
  return `You are reviewing another agent's work. Do not change any files.

The task the agent was given:
${task}

The diff of its changes follows. The full files are in your current directory.

${shown}

Check that the change does what the task asks, is correct and does not break anything else. Do not reject over style preferences.
If you reject, list the specific problems that must be fixed.
End your reply with exactly one of these lines:
VERDICT: APPROVE
VERDICT: REJECT
`;
}

export function parseVerdict(text: string): 'approve' | 'reject' | undefined {
  const matches = [...text.matchAll(/VERDICT:\s*(APPROVE|REJECT)/gi)];
  return matches.at(-1)?.[1]?.toLowerCase() as 'approve' | 'reject' | undefined;
}

// An attempt whose work should be kept and improved, not thrown away.
class Rejected extends Error {
  constructor(
    message: string,
    readonly feedback: string,
  ) {
    super(message);
  }
}

export async function runScheduler(options: SchedulerOptions): Promise<RunSummary> {
  const { store, worktrees, adapters, runId, signal } = options;
  const run = store.getRun(runId);
  if (!run) throw new Error(`Unknown run ${runId}`);
  const { config } = run;
  const specs = new Map(config.tasks.map((task) => [task.id, task]));
  const running = new Map<string, Promise<void>>();
  const commandTimeoutMs = config.commandTimeoutMinutes * 60_000;
  let budgetExceeded = false;

  const emit = (taskId: string, kind: string, data: string) => {
    store.addEvent(runId, taskId, kind, data);
    options.log?.(taskId, formatEvent(kind, data));
  };

  const adapterFor = (provider: string): AgentAdapter => {
    const adapter = adapters[provider];
    if (!adapter) throw new Error(`No adapter for provider "${provider}"`);
    return adapter;
  };

  const executeTask = async (spec: TaskSpec): Promise<void> => {
    const provider = spec.provider ?? config.defaults.provider;
    const budget = spec.budgetUsd ?? config.defaults.budgetUsd;
    const timeoutMinutes = spec.timeoutMinutes ?? config.defaults.timeoutMinutes;
    const maxAttempts = spec.maxAttempts ?? config.defaults.maxAttempts;
    const depBranches = spec.dependsOn.map((dep) => worktrees.branchName(runId, dep));
    let cost = store.listTasks(runId).find((task) => task.id === spec.id)?.costUsd ?? 0;
    let lastError = '';
    // Set while a rejected attempt's worktree is kept for the next attempt.
    let kept: { path: string; baseSha: string; feedback: string } | undefined;

    const interrupted = () => {
      if (!signal.aborted) return false;
      store.updateTask(runId, spec.id, { status: 'pending' });
      emit(spec.id, 'status', 'interrupted');
      return true;
    };

    const addCost = (amount: number) => {
      cost += amount;
      store.updateTask(runId, spec.id, { costUsd: cost });
    };

    const runCommands = async (label: string, commands: string[], path: string): Promise<string | undefined> => {
      for (const command of commands) {
        emit(spec.id, 'status', `${label}: ${command}`);
        const result = await runShell(command, path, signal, commandTimeoutMs);
        if (!result.ok) return `\`${command}\` failed:\n${result.output.slice(-MAX_FEEDBACK_CHARS)}`;
      }
      return undefined;
    };

    const review = async (path: string, diff: string): Promise<void> => {
      const settings = config.review!;
      const reviewer = settings.provider ?? PROVIDERS.find((name) => name !== provider)!;
      emit(spec.id, 'status', `review by ${reviewer} started`);
      const timeout = AbortSignal.timeout(settings.timeoutMinutes * 60_000);
      const result = await adapterFor(reviewer).run({
        cwd: path,
        prompt: reviewPrompt(spec.prompt, diff),
        model: settings.model,
        budgetUsd: settings.budgetUsd,
        readOnly: true,
        signal: AbortSignal.any([signal, timeout]),
        onEvent: (event) => {
          if (event.kind !== 'session') emit(spec.id, 'review', eventData(event));
        },
      });
      addCost(result.costUsd);
      if (signal.aborted) return;
      await worktrees.discardChanges(path); // a reviewer must not leave anything behind
      if (timeout.aborted) throw new Error(`review timed out after ${settings.timeoutMinutes} minutes`);
      if (!result.ok) throw new Error(`review failed: ${result.error ?? 'unknown error'}`);
      const verdict = parseVerdict(result.summary);
      if (!verdict) throw new Error('review failed: the reviewer gave no verdict');
      if (verdict === 'reject') {
        throw new Rejected(`rejected in review by ${reviewer}`, result.summary.slice(-MAX_FEEDBACK_CHARS));
      }
      emit(spec.id, 'status', `approved by ${reviewer}`);
    };

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (interrupted()) return;
      store.updateTask(runId, spec.id, {
        status: 'running',
        attempts: attempt,
        error: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
      });
      emit(spec.id, 'status', `attempt ${attempt}/${maxAttempts} started`);
      try {
        const adapter = adapterFor(provider);
        if (cost >= budget) throw new Error(`task budget of $${budget} is used up`);

        const previous = kept;
        kept = undefined;
        let path: string;
        let baseSha: string;
        if (previous) {
          ({ path, baseSha } = previous);
        } else {
          path = await worktrees.create(runId, spec.id, run.baseSha, depBranches);
          baseSha = await worktrees.head(path);
          const setupFailure = await runCommands('setup', config.setup, path);
          if (setupFailure) throw new Error(`setup ${setupFailure}`);
        }

        const timeout = AbortSignal.timeout(timeoutMinutes * 60_000);
        const result = await adapter.run({
          cwd: path,
          prompt: PREAMBLE + spec.prompt + (previous ? RETRY_NOTE + previous.feedback : ''),
          model: spec.model,
          budgetUsd: budget - cost,
          signal: AbortSignal.any([signal, timeout]),
          onEvent: (event) => emit(spec.id, event.kind, eventData(event)),
        });
        addCost(result.costUsd);
        store.updateTask(runId, spec.id, { sessionId: result.sessionId ?? null });

        if (interrupted()) return;
        if (timeout.aborted) throw new Error(`timed out after ${timeoutMinutes} minutes`);
        if (!result.ok) throw new Error(result.error ?? 'agent failed');

        try {
          const verifyFailure = await runCommands('verify', config.verify, path);
          if (verifyFailure) throw new Rejected(`verify ${verifyFailure.split('\n')[0]}`, verifyFailure);

          await worktrees.commitAll(path, `${spec.id}: ${spec.title ?? 'agent changes'}`);
          const diff = await worktrees.diffSince(path, baseSha);
          if (config.review && diff) await review(path, diff);
          if (interrupted()) return;

          store.updateTask(runId, spec.id, {
            status: 'done',
            summary: result.summary,
            finishedAt: new Date().toISOString(),
          });
          emit(spec.id, 'status', diff ? 'done' : 'done (no file changes)');
          return;
        } catch (err) {
          if (err instanceof Rejected) kept = { path, baseSha, feedback: err.feedback };
          throw err;
        }
      } catch (err) {
        if (interrupted()) return;
        lastError = (err as Error).message;
        emit(spec.id, 'error', lastError);
      }
    }
    store.updateTask(runId, spec.id, {
      status: 'failed',
      error: lastError,
      finishedAt: new Date().toISOString(),
    });
    emit(spec.id, 'status', 'failed');
  };

  for (;;) {
    const status = new Map(store.listTasks(runId).map((task) => [task.id, task.status]));

    // A task can never run once something it depends on has failed.
    for (let changed = true; changed; ) {
      changed = false;
      for (const spec of config.tasks) {
        if (status.get(spec.id) !== 'pending') continue;
        const cause = spec.dependsOn.find((dep) => ['failed', 'blocked'].includes(status.get(dep)!));
        if (!cause) continue;
        status.set(spec.id, 'blocked');
        store.updateTask(runId, spec.id, { status: 'blocked', error: `dependency "${cause}" did not finish` });
        emit(spec.id, 'status', `blocked by ${cause}`);
        changed = true;
      }
    }

    budgetExceeded = config.budgetUsd !== undefined && store.totalCost(runId) >= config.budgetUsd;
    if (!signal.aborted && !budgetExceeded) {
      for (const spec of config.tasks) {
        if (running.size >= config.maxParallel) break;
        if (status.get(spec.id) !== 'pending' || running.has(spec.id)) continue;
        if (!spec.dependsOn.every((dep) => status.get(dep) === 'done')) continue;
        if ([...running.keys()].some((id) => ownsOverlap(spec.owns, specs.get(id)!.owns))) continue;
        running.set(
          spec.id,
          executeTask(spec).finally(() => running.delete(spec.id)),
        );
      }
    }

    if (running.size === 0) break;
    await Promise.race(running.values());
  }

  const counts: Record<TaskStatus, number> = { pending: 0, running: 0, done: 0, failed: 0, blocked: 0 };
  for (const task of store.listTasks(runId)) counts[task.status]++;
  return { counts, costUsd: store.totalCost(runId), budgetExceeded };
}

function eventData(event: AgentEvent): string {
  switch (event.kind) {
    case 'session':
      return event.sessionId;
    case 'tool':
      return event.detail ? `${event.name} ${event.detail}` : event.name;
    default:
      return event.text;
  }
}

export function formatEvent(kind: string, data: string): string {
  switch (kind) {
    case 'tool':
      return `> ${data}`;
    case 'review':
      return `review| ${data}`;
    case 'error':
      return `ERROR ${data}`;
    case 'status':
      return `[${data}]`;
    case 'session':
      return `[session ${data}]`;
    default:
      return data;
  }
}
