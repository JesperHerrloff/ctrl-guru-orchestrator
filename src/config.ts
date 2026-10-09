import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const PROVIDERS = ['claude'] as const;

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
  defaults: z
    .object({
      provider: z.enum(PROVIDERS).default('claude'),
      model: z.string().optional(),
      budgetUsd: z.number().positive().default(2),
      timeoutMinutes: z.number().positive().default(30),
      maxAttempts: z.number().int().positive().default(2),
    })
    .prefault({}),
  providers: z
    .object({
      claude: z
        .object({
          permissionMode: z.string().default('acceptEdits'),
          allowedTools: z.array(z.string()).default([]),
        })
        .prefault({}),
    })
    .prefault({}),
  tasks: z.array(taskSchema).min(1),
});

export type Config = z.infer<typeof configSchema>;
export type TaskSpec = Config['tasks'][number];

export function parseConfig(text: string): Config {
  const result = configSchema.safeParse(parseYaml(text));
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
