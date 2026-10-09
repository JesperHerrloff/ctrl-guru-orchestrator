import { stringify as stringifyYaml } from 'yaml';
import { ownsOverlap, parseConfigObject, PROVIDERS, type Config } from './config.js';
import type { AgentAdapter, AgentEvent } from './providers/types.js';

export interface PlanOptions {
  goal: string;
  // The repository checkout the lead agent reads.
  cwd: string;
  adapter: AgentAdapter;
  // Everything a task file holds except the tasks: gates, budgets, providers.
  settings: Record<string, unknown>;
  maxTasks: number;
  budgetUsd: number;
  timeoutMinutes: number;
  maxAttempts?: number;
  signal: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
}

export interface Plan {
  config: Config;
  yaml: string;
  notes: string;
  costUsd: number;
}

const TASK_FIELDS = ['id', 'title', 'prompt', 'dependsOn', 'owns', 'provider'] as const;

function leadPrompt(goal: string, maxTasks: number): string {
  return `You are the lead of a team of AI coding agents. Split the goal below into tasks for the team. Do not change any files and do not do the work yourself.

Read the repository in your current directory first, so the plan fits the code that exists.

How the team works:
- Each task is done by one agent, alone, in its own git worktree on its own branch.
- An agent sees only its own task prompt. It does not see the goal, this conversation or the other tasks. Every prompt must be complete on its own: name the files, the behavior and how to check the result.
- A task starts from the repository as it is now, plus the finished work of the tasks listed in its dependsOn.
- Tasks without a dependency between them run in parallel and are merged afterwards, so they must not edit the same files.

Rules for the plan:
- At most ${maxTasks} tasks. Use fewer when the goal is small: one task is a valid plan.
- Every task lists in "owns" the files or directories it will create or change, relative to the repository root.
- If the owned paths of two tasks overlap, one of them must depend on the other, directly or through other tasks.
- "id" uses lowercase letters, digits and dashes.
- "provider" is optional and is one of: ${PROVIDERS.join(', ')}. Leave it out unless a task clearly suits one of them.

End your reply with the plan as one JSON object in a \`\`\`json code block, in this shape:
{
  "notes": "risks or assumptions the person approving the plan should know",
  "tasks": [
    { "id": "example", "title": "Short title", "prompt": "Full instructions", "dependsOn": [], "owns": ["src/example/"] }
  ]
}

Goal:
${goal}
`;
}

// Finds the plan in the lead agent's reply: the last fenced JSON block, or the
// whole reply if it is bare JSON.
export function extractJson(text: string): unknown {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((match) => match[1]!);
  for (const candidate of [...blocks.reverse(), text]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  throw new Error('the reply did not contain a JSON plan');
}

// Problems that would make the tasks of a plan collide when they are merged.
export function checkPlan(config: Config, maxTasks: number): string[] {
  const problems: string[] = [];
  const { tasks } = config;
  if (tasks.length > maxTasks) problems.push(`the plan has ${tasks.length} tasks but at most ${maxTasks} are allowed`);

  const deps = new Map(tasks.map((task) => [task.id, task.dependsOn]));
  const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
    for (const dep of deps.get(id) ?? []) {
      if (!seen.has(dep)) ancestors(dep, seen.add(dep));
    }
    return seen;
  };

  for (const [index, task] of tasks.entries()) {
    if (task.owns.length === 0) problems.push(`task "${task.id}" does not list the paths it owns`);
    for (const other of tasks.slice(index + 1)) {
      if (!ownsOverlap(task.owns, other.owns)) continue;
      if (ancestors(task.id).has(other.id) || ancestors(other.id).has(task.id)) continue;
      problems.push(`tasks "${task.id}" and "${other.id}" own overlapping paths but neither depends on the other`);
    }
  }
  return problems;
}

function buildPlan(reply: string, settings: Record<string, unknown>, maxTasks: number): { config: Config; notes: string } {
  const raw = extractJson(reply) as { notes?: unknown; tasks?: unknown };
  if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.tasks)) {
    throw new Error('the JSON plan has no "tasks" array');
  }
  // The lead agent decides the tasks, never the budgets or permissions.
  const tasks = raw.tasks.map((task: any) =>
    Object.fromEntries(TASK_FIELDS.filter((field) => task?.[field] !== undefined).map((field) => [field, task[field]])),
  );
  const config = parseConfigObject({ ...settings, tasks });
  const problems = checkPlan(config, maxTasks);
  if (problems.length > 0) throw new Error(problems.join('\n'));
  return { config, notes: typeof raw.notes === 'string' ? raw.notes.trim() : '' };
}

export async function createPlan(options: PlanOptions): Promise<Plan> {
  const maxAttempts = options.maxAttempts ?? 3;
  const base = leadPrompt(options.goal, options.maxTasks);
  let prompt = base;
  let costUsd = 0;
  let problem = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (costUsd >= options.budgetUsd) throw new Error(`Planning budget of $${options.budgetUsd} is used up. Last problem: ${problem}`);
    const timeout = AbortSignal.timeout(options.timeoutMinutes * 60_000);
    const result = await options.adapter.run({
      cwd: options.cwd,
      prompt,
      budgetUsd: options.budgetUsd - costUsd,
      readOnly: true,
      signal: AbortSignal.any([options.signal, timeout]),
      onEvent: options.onEvent ?? (() => {}),
    });
    costUsd += result.costUsd;
    options.signal.throwIfAborted();
    if (timeout.aborted) throw new Error(`The lead agent timed out after ${options.timeoutMinutes} minutes`);
    if (!result.ok) throw new Error(`The lead agent failed: ${result.error ?? 'unknown error'}`);

    try {
      const { config, notes } = buildPlan(result.summary, options.settings, options.maxTasks);
      const header = `# Plan by the ${options.adapter.name} lead agent for:\n${options.goal.replace(/^/gm, '#   ')}\n`;
      const yaml = `${header}\n${stringifyYaml({ ...options.settings, tasks: config.tasks.map(cleanTask) }, { lineWidth: 100 })}`;
      return { config, yaml, notes, costUsd };
    } catch (err) {
      problem = (err as Error).message;
      prompt = `${base}\nYour previous reply was not accepted:\n${problem}\n\nYour previous reply ended like this:\n${result.summary.slice(-6000)}\n\nSend a corrected plan.\n`;
    }
  }
  throw new Error(`The lead agent did not produce a valid plan in ${maxAttempts} attempts. Last problem:\n${problem}`);
}

function cleanTask(task: Config['tasks'][number]): Record<string, unknown> {
  const entries = Object.entries(task).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0));
  return Object.fromEntries(entries);
}

export function describePlan(plan: Plan): string {
  const lines: string[] = [];
  for (const [index, task] of plan.config.tasks.entries()) {
    const provider = task.provider ?? plan.config.defaults.provider;
    lines.push(`${index + 1}. ${task.id} [${provider}]${task.title ? `  ${task.title}` : ''}`);
    lines.push(`   owns:  ${task.owns.join(', ')}`);
    if (task.dependsOn.length) lines.push(`   after: ${task.dependsOn.join(', ')}`);
  }
  if (plan.notes) lines.push('', `Notes from the lead agent: ${plan.notes}`);
  return lines.join('\n');
}
