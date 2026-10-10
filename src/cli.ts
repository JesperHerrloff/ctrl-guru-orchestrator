#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { loadConfig, parseConfigObject, PROVIDERS, type Config, type ProviderName } from './config.js';
import { createPlan, describePlan } from './planner.js';
import { ClaudeAdapter } from './providers/claude.js';
import { CodexAdapter } from './providers/codex.js';
import { OpencodeAdapter } from './providers/opencode.js';
import type { AgentAdapter } from './providers/types.js';
import { eventData, formatEvent, runScheduler, type RunSummary } from './scheduler.js';
import { Store, type RunRecord } from './store.js';
import { Worktrees } from './worktrees.js';

const USAGE = `Usage: ctrl-guru <command> [options]

Commands:
  plan <goal>        Let a lead agent split a goal into tasks for you to approve
  run <tasks.yaml>   Start a new run from a task file
  resume             Continue a run: retries failed, blocked and interrupted tasks
  ui                 Open the terminal UI for a run without starting agents
  status             Show the tasks of a run
  logs <task>        Print the event log of a task
  diff <task>        Print what a task changed
  merge <task>       Merge a finished task into the checked-out branch
  clean              Remove the worktrees of a run (branches are kept)

Options:
  --repo <path>      Repository to work in (default: current directory)
  --run <id>         Run to act on (default: the latest run)
  --plain            Print a line-based log instead of the terminal UI

Options for plan:
  --lead <provider>  Provider of the lead agent (default: the default provider)
  --settings <file>  Gates, budgets and providers for the plan (default: ctrl-guru.yaml)
  --out <file>       Where to save the plan (default: .ctrl-guru/plans/)
  --max-tasks <n>    Largest plan the lead agent may propose (default: 6)
  --budget <usd>     Budget for planning (default: 1)
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      run: { type: 'string' },
      plain: { type: 'boolean' },
      lead: { type: 'string' },
      settings: { type: 'string' },
      out: { type: 'string' },
      'max-tasks': { type: 'string', default: '6' },
      budget: { type: 'string', default: '1' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, arg] = positionals;
  if (values.help || !command) {
    console.log(USAGE);
    return command ? 0 : 1;
  }

  const worktrees = await Worktrees.open(resolve(values.repo ?? process.cwd()));
  const store = new Store(join(worktrees.stateDir, 'state.db'));
  const interactive = Boolean(process.stdout.isTTY && process.stdin.isTTY);
  const plain = values.plain || !interactive;
  const startRun = async (config: Config): Promise<number> => {
    const baseSha = await worktrees.resolveSha(config.baseRef ?? 'HEAD');
    const run: RunRecord = { id: newRunId(), createdAt: new Date().toISOString(), baseSha, config };
    store.createRun(run);
    console.log(`Run ${run.id} from ${baseSha.slice(0, 8)}, ${config.tasks.length} tasks`);
    return execute(store, worktrees, run, plain);
  };
  const existingRun = (): RunRecord => {
    const run = values.run ? store.getRun(values.run) : store.latestRun();
    if (!run) throw new Error(values.run ? `Unknown run ${values.run}` : 'No runs yet in this repository');
    return run;
  };

  try {
    switch (command) {
      case 'plan': {
        const goal = positionals.slice(1).join(' ').trim();
        if (!goal) throw new Error('Missing goal. Usage: ctrl-guru plan "<what you want built>"');
        const maxTasks = positiveNumber(values['max-tasks'], '--max-tasks');
        const budgetUsd = positiveNumber(values.budget, '--budget');
        const settings = await loadSettings(values.settings, join(worktrees.repoRoot, 'ctrl-guru.yaml'));
        // Validates the settings before any money is spent on planning.
        const probe = parseConfigObject({ ...settings, tasks: [{ id: 'probe', prompt: 'probe' }] });
        const leadName = (values.lead ?? probe.defaults.provider) as ProviderName;
        if (!PROVIDERS.includes(leadName)) throw new Error(`Unknown provider "${leadName}". Use one of: ${PROVIDERS.join(', ')}`);

        const controller = new AbortController();
        process.once('SIGINT', () => controller.abort());
        console.log(`Planning with the ${leadName} lead agent. It reads the repository and changes nothing.`);
        const plan = await createPlan({
          goal,
          cwd: worktrees.repoRoot,
          adapter: createAdapters(probe)[leadName]!,
          settings,
          maxTasks,
          budgetUsd,
          timeoutMinutes: 15,
          signal: controller.signal,
          onEvent: (event) => {
            if (event.kind === 'session') return;
            const time = new Date().toTimeString().slice(0, 8);
            for (const part of formatEvent(event.kind, eventData(event)).split('\n')) console.log(`${time} lead  ${part}`);
          },
        });

        const out = resolve(values.out ?? join(worktrees.stateDir, 'plans', `${newRunId()}.yaml`));
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, plan.yaml);
        console.log(`\nPlan with ${plan.config.tasks.length} tasks (planning cost $${plan.costUsd.toFixed(2)}):\n`);
        console.log(describePlan(plan));
        console.log(`\nSaved to ${out}`);

        const startHint = `Read or edit the file, then start it with: ctrl-guru run ${out}`;
        if (!interactive) {
          console.log(startHint);
          return 0;
        }
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await prompt.question('Start the run now? [y/N] ');
        prompt.close();
        if (answer.trim().toLowerCase() !== 'y') {
          console.log(startHint);
          return 0;
        }
        return await startRun(plan.config);
      }
      case 'run': {
        if (!arg) throw new Error('Missing task file. Usage: ctrl-guru run <tasks.yaml>');
        return await startRun(await loadConfig(resolve(arg)));
      }
      case 'resume': {
        const run = existingRun();
        for (const task of store.listTasks(run.id)) {
          if (task.status !== 'done') {
            store.updateTask(run.id, task.id, { status: 'pending', attempts: 0, error: null });
          }
        }
        console.log(`Resuming run ${run.id}`);
        return await execute(store, worktrees, run, plain);
      }
      case 'ui': {
        if (plain) throw new Error('The terminal UI needs an interactive terminal');
        const { runTui } = await import('./tui/index.js');
        await runTui(store, worktrees, existingRun());
        return 0;
      }
      case 'diff':
      case 'merge': {
        if (!arg) throw new Error(`Missing task id. Usage: ctrl-guru ${command} <task>`);
        const run = existingRun();
        const task = store.listTasks(run.id).find((item) => item.id === arg);
        if (!task) throw new Error(`Unknown task ${arg}`);
        const branch = worktrees.branchName(run.id, task.id);
        if (command === 'diff') {
          if (!task.baseSha) throw new Error(`Task ${arg} has not produced a branch yet`);
          console.log(await worktrees.diffBranch(task.baseSha, branch));
          return 0;
        }
        if (task.status !== 'done') throw new Error(`Task ${arg} is ${task.status}. Only a finished task can be merged.`);
        await worktrees.mergeIntoCurrent(branch);
        console.log(`Merged ${branch} into ${await worktrees.currentBranch()}`);
        return 0;
      }
      case 'status': {
        printStatus(store, worktrees, existingRun());
        return 0;
      }
      case 'logs': {
        if (!arg) throw new Error('Missing task id. Usage: ctrl-guru logs <task>');
        const run = existingRun();
        if (!run.config.tasks.some((task) => task.id === arg)) throw new Error(`Unknown task ${arg}`);
        for (const event of store.listEvents(run.id, arg)) {
          const time = new Date(event.ts).toTimeString().slice(0, 8);
          console.log(`${time} ${formatEvent(event.kind, event.data)}`);
        }
        return 0;
      }
      case 'clean': {
        const run = existingRun();
        for (const task of run.config.tasks) await worktrees.remove(run.id, task.id);
        console.log(`Removed worktrees of run ${run.id}. Branches ctrl-guru/${run.id}/* are kept.`);
        return 0;
      }
      default:
        throw new Error(`Unknown command "${command}"\n\n${USAGE}`);
    }
  } finally {
    store.close();
  }
}

async function execute(store: Store, worktrees: Worktrees, run: RunRecord, plain: boolean): Promise<number> {
  const schedule = (signal: AbortSignal, log?: (taskId: string, line: string) => void) =>
    runScheduler({ store, worktrees, adapters: createAdapters(run.config), runId: run.id, signal, log });

  let summary: RunSummary;
  let stopped: boolean;
  if (plain) {
    const controller = new AbortController();
    const onSignal = () => {
      if (controller.signal.aborted) process.exit(130);
      console.log('\nStopping agents. Press Ctrl+C again to force quit.');
      controller.abort();
    };
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    summary = await schedule(controller.signal, (taskId, line) => {
      const time = new Date().toTimeString().slice(0, 8);
      for (const part of line.split('\n')) console.log(`${time} ${taskId.padEnd(12)} ${part}`);
    });
    stopped = controller.signal.aborted;
    console.log('');
  } else {
    const { runTui } = await import('./tui/index.js');
    const outcome = await runTui(store, worktrees, run, (signal) => schedule(signal));
    summary = outcome.result!;
    stopped = outcome.stopped;
  }

  printStatus(store, worktrees, run);
  if (summary.budgetExceeded) console.log(`\nRun budget of $${run.config.budgetUsd} reached: no more tasks were started.`);
  if (stopped) console.log(`\nInterrupted. Continue with: ctrl-guru resume --run ${run.id}`);
  return summary.counts.done === run.config.tasks.length ? 0 : 1;
}

// Reads the settings shared by every plan. Only an explicitly named file has to exist.
async function loadSettings(explicit: string | undefined, fallback: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(resolve(explicit ?? fallback), 'utf8');
  } catch (err) {
    if (!explicit && (err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  const value = parseYaml(text) ?? {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('The settings file must be a YAML mapping');
  const { tasks: _tasks, ...settings } = value as Record<string, unknown>;
  return settings;
}

function positiveNumber(text: string, flag: string): number {
  const value = Number(text);
  if (!(value > 0)) throw new Error(`${flag} must be a positive number`);
  return value;
}

function createAdapters(config: Config): Record<string, AgentAdapter> {
  return {
    claude: new ClaudeAdapter(config.providers.claude),
    codex: new CodexAdapter(config.providers.codex),
    opencode: new OpencodeAdapter(config.providers.opencode),
  };
}

function printStatus(store: Store, worktrees: Worktrees, run: RunRecord): void {
  console.log(`Run ${run.id}  base ${run.baseSha.slice(0, 8)}  cost $${store.totalCost(run.id).toFixed(2)}`);
  for (const task of store.listTasks(run.id)) {
    const cost = `$${task.costUsd.toFixed(2)}`.padStart(7);
    const note = task.status === 'done' ? worktrees.branchName(run.id, task.id) : (task.error ?? '');
    console.log(`  ${task.status.padEnd(8)} ${task.id.padEnd(16)} ${cost}  ${note.split('\n')[0]}`);
  }
}

function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  return `${stamp}-${randomBytes(2).toString('hex')}`;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(`ctrl-guru: ${(err as Error).message}`);
    process.exitCode = 1;
  },
);
