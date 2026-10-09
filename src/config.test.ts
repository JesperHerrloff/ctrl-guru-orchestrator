import { describe, expect, it } from 'vitest';
import { ownsOverlap, parseConfig } from './config.js';

describe('parseConfig', () => {
  it('applies defaults', () => {
    const config = parseConfig('tasks:\n  - id: a\n    prompt: do it\n');
    expect(config.maxParallel).toBe(3);
    expect(config.defaults).toMatchObject({ provider: 'claude', budgetUsd: 2, maxAttempts: 2 });
    expect(config.providers.claude.permissionMode).toBe('acceptEdits');
    expect(config.tasks[0]).toMatchObject({ dependsOn: [], owns: [] });
  });

  it('rejects unknown dependencies', () => {
    expect(() => parseConfig('tasks:\n  - id: a\n    prompt: x\n    dependsOn: [b]\n')).toThrow(/unknown task "b"/);
  });

  it('rejects duplicate ids', () => {
    expect(() => parseConfig('tasks:\n  - {id: a, prompt: x}\n  - {id: a, prompt: y}\n')).toThrow(/duplicate/);
  });

  it('rejects cycles', () => {
    const yaml = 'tasks:\n  - {id: a, prompt: x, dependsOn: [b]}\n  - {id: b, prompt: y, dependsOn: [a]}\n';
    expect(() => parseConfig(yaml)).toThrow(/cycle a -> b -> a/);
  });

  it('rejects ids that are not safe branch names', () => {
    expect(() => parseConfig('tasks:\n  - {id: "My Task", prompt: x}\n')).toThrow(/Invalid config/);
  });
});

describe('ownsOverlap', () => {
  it('treats a directory and a file inside it as overlapping', () => {
    expect(ownsOverlap(['src/api/'], ['src/api/users.ts'])).toBe(true);
    expect(ownsOverlap(['./package.json'], ['package.json'])).toBe(true);
  });

  it('does not match sibling paths or unowned tasks', () => {
    expect(ownsOverlap(['src/api'], ['src/api-client'])).toBe(false);
    expect(ownsOverlap([], ['src'])).toBe(false);
  });
});
