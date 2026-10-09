import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { checkPlan, createPlan, describePlan, extractJson } from './planner.js';
import type { AgentAdapter, AgentRunOptions } from './providers/types.js';

const reply = (plan: unknown) => `I read the repository.\n\n\`\`\`json\n${JSON.stringify(plan, null, 2)}\n\`\`\`\n`;

// A lead agent that answers with the given replies in order.
function lead(...replies: string[]) {
  const calls: AgentRunOptions[] = [];
  const adapter: AgentAdapter = {
    name: 'claude',
    async run(options) {
      calls.push(options);
      return { ok: true, summary: replies[calls.length - 1] ?? replies.at(-1)!, costUsd: 0.1 };
    },
  };
  return { adapter, calls };
}

const plan = (adapter: AgentAdapter, settings: Record<string, unknown> = {}) =>
  createPlan({
    goal: 'Add a health endpoint',
    cwd: '/repo',
    adapter,
    settings,
    maxTasks: 3,
    budgetUsd: 1,
    timeoutMinutes: 1,
    signal: new AbortController().signal,
  });

const api = { id: 'api', title: 'Add endpoint', prompt: 'Add GET /health in src/api.js', owns: ['src/api.js'] };
const docs = { id: 'docs', prompt: 'Document /health in README.md', owns: ['README.md'], dependsOn: ['api'] };

describe('createPlan', () => {
  it('turns the reply of the lead agent into a task file that parses back to the same plan', async () => {
    const { adapter, calls } = lead(reply({ notes: 'Assumes Express.', tasks: [api, docs] }));
    const result = await plan(adapter, { verify: ['npm test'], review: {} });

    expect(calls[0]).toMatchObject({ cwd: '/repo', readOnly: true });
    expect(calls[0]!.prompt).toContain('Add a health endpoint');
    expect(result.notes).toBe('Assumes Express.');
    expect(result.costUsd).toBe(0.1);
    expect(result.yaml).toContain('#   Add a health endpoint');
    const parsed = parseConfig(result.yaml);
    expect(parsed).toEqual(result.config);
    expect(parsed.verify).toEqual(['npm test']);
    expect(parsed.tasks.map((task) => task.id)).toEqual(['api', 'docs']);
  });

  it('does not let the lead agent set budgets or other task settings', async () => {
    const { adapter } = lead(reply({ tasks: [{ ...api, budgetUsd: 500, maxAttempts: 99, model: 'big' }] }));
    const result = await plan(adapter);
    expect(result.config.tasks[0]).not.toHaveProperty('budgetUsd');
    expect(result.yaml).not.toMatch(/budgetUsd|maxAttempts|model/);
  });

  it('sends an invalid plan back with the problem and accepts the correction', async () => {
    const colliding = { id: 'more', prompt: 'Also edit the api', owns: ['src/'] };
    const { adapter, calls } = lead(reply({ tasks: [api, colliding] }), reply({ tasks: [api, { ...colliding, dependsOn: ['api'] }] }));
    const result = await plan(adapter);

    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain('tasks "api" and "more" own overlapping paths but neither depends on the other');
    expect(result.costUsd).toBeCloseTo(0.2);
    expect(result.config.tasks[1]!.dependsOn).toEqual(['api']);
  });

  it('gives up after repeated invalid plans', async () => {
    const { adapter, calls } = lead('I could not decide.');
    await expect(plan(adapter)).rejects.toThrow(/did not produce a valid plan in 3 attempts[\s\S]*did not contain a JSON plan/);
    expect(calls).toHaveLength(3);
  });

  it('reports a failing lead agent', async () => {
    const adapter: AgentAdapter = { name: 'claude', run: async () => ({ ok: false, summary: '', costUsd: 0, error: 'not logged in' }) };
    await expect(plan(adapter)).rejects.toThrow('The lead agent failed: not logged in');
  });
});

describe('checkPlan', () => {
  const check = (yaml: string, maxTasks = 5) => checkPlan(parseConfig(yaml), maxTasks);

  it('accepts overlapping paths when one task depends on the other through a third', () => {
    const yaml =
      'tasks:\n  - {id: a, prompt: x, owns: [src/]}\n  - {id: b, prompt: x, owns: [docs/], dependsOn: [a]}\n  - {id: c, prompt: x, owns: [src/x.ts], dependsOn: [b]}\n';
    expect(check(yaml)).toEqual([]);
  });

  it('rejects tasks without owned paths and plans that are too large', () => {
    expect(check('tasks:\n  - {id: a, prompt: x}\n  - {id: b, prompt: x, owns: [b]}\n', 1)).toEqual([
      'the plan has 2 tasks but at most 1 are allowed',
      'task "a" does not list the paths it owns',
    ]);
  });
});

describe('extractJson', () => {
  it('uses the last fenced block, or bare JSON', () => {
    expect(extractJson('```json\n{"a":1}\n```\nrevised:\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('{"tasks":[]}')).toEqual({ tasks: [] });
    expect(() => extractJson('no plan')).toThrow(/did not contain/);
  });
});

describe('describePlan', () => {
  it('lists tasks with provider, owned paths and order', async () => {
    const { adapter } = lead(reply({ notes: 'Check the port.', tasks: [api, { ...docs, provider: 'codex' }] }));
    expect(describePlan(await plan(adapter))).toBe(
      [
        '1. api [claude]  Add endpoint',
        '   owns:  src/api.js',
        '2. docs [codex]',
        '   owns:  README.md',
        '   after: api',
        '',
        'Notes from the lead agent: Check the port.',
      ].join('\n'),
    );
  });
});
