# ctrl-guru

Orchestrates a team of AI coding agents that work in parallel, each in its own git worktree.

Status: phase 1. Tasks are written by hand in a YAML file and run by Claude Code. Codex, OpenRouter, review across providers, a TUI and a lead agent come later.

## Requirements

- macOS or Linux
- Node.js 22.13 or later
- git
- [Claude Code](https://claude.com/claude-code) installed and logged in (`claude` on your PATH)

## Usage

```bash
npm install
npm run build
node dist/cli.js run examples/tasks.yaml --repo /path/to/your/repo
```

| Command | What it does |
|---|---|
| `run <tasks.yaml>` | Starts a new run from a task file |
| `resume` | Continues a run: retries failed, blocked and interrupted tasks |
| `status` | Shows the tasks of a run |
| `logs <task>` | Prints the event log of a task |
| `clean` | Removes the worktrees of a run and keeps its branches |

`--repo <path>` picks the repository (default: current directory) and `--run <id>` picks the run (default: the latest).

## How a run works

1. The run is pinned to a base commit (`baseRef` in the task file, otherwise `HEAD`).
2. Each task gets a branch `ctrl-guru/<run>/<task>` and a worktree under `.ctrl-guru/worktrees/`. The branches of its dependencies are merged in first.
3. The agent works in that worktree. When it finishes, ctrl-guru commits whatever it changed.
4. A failed or timed-out task is retried in a fresh worktree up to `maxAttempts`. If it still fails, every task that depends on it is marked `blocked`.
5. You review and merge the task branches yourself.

Your own checkout is never touched. State lives in `.ctrl-guru/state.db`, and `.ctrl-guru/` is added to `.git/info/exclude`.

## Task file

See [examples/tasks.yaml](examples/tasks.yaml).

- `dependsOn` orders tasks and gives a task the changes of the tasks it depends on.
- `owns` lists the files or directories a task is expected to change. Two tasks with overlapping paths never run at the same time. It is not enforced on what the agent actually edits.
- `budgetUsd` at the top level caps the whole run: no new task starts once it is reached. Under `defaults` or on a task it caps that task across its attempts.
- `providers.claude.allowedTools` lists the shell commands agents may run. Everything else that would need approval is denied, so an agent cannot run your tests unless you allow the command.

## Development

```bash
npm test
npm run typecheck
npm run dev -- status
```
