# ctrl-guru

Orchestrates a team of AI coding agents that work in parallel, each in its own git worktree.

Status: phase 2. Tasks are written by hand in a YAML file and run by Claude Code or Codex. Each task can be gated by your test commands and by a review from the other provider. OpenRouter, a TUI and a lead agent come later.

## Requirements

- macOS or Linux
- Node.js 22.13 or later
- git
- [Claude Code](https://claude.com/claude-code) installed and logged in (`claude` on your PATH)
- [Codex CLI](https://github.com/openai/codex) installed and logged in (`codex` on your PATH), if you use Codex as a worker or reviewer

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
2. Each task gets a branch `ctrl-guru/<run>/<task>` and a worktree under `.ctrl-guru/worktrees/`. The branches of its dependencies are merged in first, then the `setup` commands run.
3. The agent works in that worktree.
4. The `verify` commands run in the worktree. All must succeed.
5. ctrl-guru commits the changes. If `review` is set, an agent from another provider reviews the diff read-only and ends with an approve or reject verdict.
6. If verify fails or the reviewer rejects, the same agent gets another attempt in the same worktree, with the command output or the review as feedback. If the agent itself fails or times out, the next attempt starts in a fresh worktree.
7. After `maxAttempts` the task is marked `failed`, and every task that depends on it is marked `blocked`.
8. You review and merge the branches of the finished tasks yourself.

Your own checkout is never touched. State lives in `.ctrl-guru/state.db`, and `.ctrl-guru/` is added to `.git/info/exclude`.

## Task file

See [examples/tasks.yaml](examples/tasks.yaml).

- `dependsOn` orders tasks and gives a task the changes of the tasks it depends on.
- `owns` lists the files or directories a task is expected to change. Two tasks with overlapping paths never run at the same time. It is not enforced on what the agent actually edits.
- `provider` on a task, or under `defaults`, picks `claude` or `codex`.
- `setup` lists shell commands run in every fresh worktree, such as `npm ci`. A worktree has no installed dependencies until you install them.
- `verify` lists shell commands that must succeed before a task is done, such as `npm test`.
- `review` turns on review. By default the reviewer is the other provider than the one that did the work; `review.provider` pins it.
- `budgetUsd` at the top level caps the whole run: no new task starts once it is reached. Under `defaults` or on a task it caps that task across its attempts.
- `providers.claude.allowedTools` lists the shell commands Claude agents may run. Everything else that would need approval is denied. `verify` runs outside the agent and is not affected.

## Limitations

- Codex reports token usage but no price. Codex work is counted as $0, so dollar budgets only limit Claude agents.
- A failed reviewer run (error, timeout or no verdict) fails the attempt, and the next attempt redoes the task from a fresh worktree.
- Claude reviewers cannot run shell commands, so they review by reading. Codex reviewers run in a read-only sandbox and can run tests.

## Development

```bash
npm test
npm run typecheck
npm run dev -- status
```
