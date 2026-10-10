import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const PROVIDERS = ['claude', 'codex', 'opencode'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

const taskSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'use lowercase letters, digits and dashes'),
  title: z.string().optional(),
  prompt: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  // Paths (files or directories) this task is expected to change. Tasks whose
  // paths overlap never run at the same time.
  owns: z.array(z.string()).default([]),
  provider: z.enum(PROVIDERS).optional(),
  model: z.string().optional(),
  budgetUsd: z.number().positive().optional(),
  timeoutMinutes: z.number().positive().optional(),
  maxAttempts: z.number().int().positive().optional(),
});

const configSchema = z.object({
  baseRef: z.string().optional(),
  maxParallel: z.number().int().positive().default(3),
  // Cap for the whole run. No new task starts once it is reached.
  budgetUsd: z.number().positive().optional(),
  // Shell commands run in every fresh worktree before the agent starts,
  // for example to install dependencies.
  setup: z.array(z.string()).default([]),
  // Shell commands that must all succeed in the worktree before a task counts
  // as done, for example the test suite.
  verify: z.array(z.string()).default([]),
  commandTimeoutMinutes: z.number().positive().default(10),
  // When present, another agent reviews each task's diff. The reviewer defaults
  // to a different provider than the one that did the work.
  review: z
    .object({
      provider: z.enum(PROVIDERS).optional(),
      model: z.string().optional(),
      budgetUsd: z.number().positive().default(1),
      timeoutMinutes: z.number().positive().default(10),
    })
    .optional(),
  defaults: z
    .object({
      provider: z.enum(PROVIDERS).default('claude'),
      budgetUsd: z.number().positive().default(2),
      timeoutMinutes: z.number().positive().default(30),
      maxAttempts: z.number().int().positive().default(2),
    })
    .prefault({}),
  providers: z
    .object({
      claude: z
        .object({
          model: z.string().optional(),
          permissionMode: z.string().default('acceptEdits'),
          allowedTools: z.array(z.string()).default([]),
        })
        .prefault({}),
      codex: z
        .object({
          model: z.string().optional(),
          sandbox: z.enum(['workspace-write', 'danger-full-access']).default('workspace-write'),
        })
        .prefault({}),
      opencode: z
        .object({
          // In opencode's provider/model format, for example openrouter/~google/gemini-flash-latest.
          model: z.string().optional(),
        })
        .prefault({}),
    })
    .prefault({}),
  tasks: z.array(taskSchema).min(1),
});

export type Config = z.infer<typeof configSchema>;
export type TaskSpec = Config['tasks'][number];

export function parseConfig(text: string): Config {
  return parseConfigObject(parseYaml(text));
}

export function parseConfigObject(value: unknown): Config {
  const result = configSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid config:\n${z.prettifyError(result.error)}`);
  }
  const config = result.data;
  const ids = new Set<string>();
  for (const task of config.tasks) {
    if (ids.has(task.id)) throw new Error(`Invalid config: duplicate task id "${task.id}"`);
    ids.add(task.id);
  }
  for (const task of config.tasks) {
    for (const dep of task.dependsOn) {
      if (!ids.has(dep)) {
        throw new Error(`Invalid config: task "${task.id}" depends on unknown task "${dep}"`);
      }
    }
  }
  assertAcyclic(config.tasks);

  // opencode has no default model, unlike the other CLIs.
  const fallbackModel = config.providers.opencode.model;
  for (const task of config.tasks) {
    if ((task.provider ?? config.defaults.provider) === 'opencode' && !(task.model ?? fallbackModel)) {
      throw new Error(`Invalid config: task "${task.id}" uses opencode but no model is set. Set providers.opencode.model or the task's model.`);
    }
  }
  if (config.review?.provider === 'opencode' && !(config.review.model ?? fallbackModel)) {
    throw new Error('Invalid config: review uses opencode but no model is set. Set providers.opencode.model or review.model.');
  }
  return config;
}

export async function loadConfig(path: string): Promise<Config> {
  return parseConfig(await readFile(path, 'utf8'));
}

function assertAcyclic(tasks: TaskSpec[]): void {
  const deps = new Map(tasks.map((t) => [t.id, t.dependsOn]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, trail: string[]): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      throw new Error(`Invalid config: dependency cycle ${[...trail, id].join(' -> ')}`);
    }
    state.set(id, 'visiting');
    for (const dep of deps.get(id) ?? []) visit(dep, [...trail, id]);
    state.set(id, 'done');
  };
  for (const task of tasks) visit(task.id, []);
}

export function ownsOverlap(a: string[], b: string[]): boolean {
  const norm = (p: string) => p.replace(/^\.\//, '').replace(/\/+$/, '');
  return a.some((x) =>
    b.some((y) => {
      const [p, q] = [norm(x), norm(y)];
      return p === q || p.startsWith(`${q}/`) || q.startsWith(`${p}/`);
    }),
  );
}
