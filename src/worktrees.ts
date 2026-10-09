import { execFile } from 'node:child_process';
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
    return stdout.trim();
  } catch (err: any) {
    const detail = String(err.stderr || err.stdout || err.message).trim();
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
}

export const STATE_DIR = '.ctrl-guru';

export class Worktrees {
  private constructor(readonly repoRoot: string) {}

  static async open(cwd: string): Promise<Worktrees> {
    const root = await git(cwd, ['rev-parse', '--show-toplevel']).catch(() => {
      throw new Error(`${cwd} is not inside a git repository`);
    });
    await git(root, ['rev-parse', '--verify', 'HEAD']).catch(() => {
      throw new Error('The repository has no commits yet. Create an initial commit first.');
    });
    const worktrees = new Worktrees(root);
    await mkdir(worktrees.stateDir, { recursive: true });
    await worktrees.excludeStateDir();
    return worktrees;
  }

  get stateDir(): string {
    return join(this.repoRoot, STATE_DIR);
  }

  branchName(runId: string, taskId: string): string {
    return `ctrl-guru/${runId}/${taskId}`;
  }

  pathFor(runId: string, taskId: string): string {
    return join(this.stateDir, 'worktrees', runId, taskId);
  }

  resolveSha(ref: string): Promise<string> {
    return git(this.repoRoot, ['rev-parse', '--verify', `${ref}^{commit}`]);
  }

  // Creates a fresh worktree for the task on its own branch, starting from
  // baseSha with the branches of its dependencies merged in.
  async create(runId: string, taskId: string, baseSha: string, depBranches: string[]): Promise<string> {
    const path = this.pathFor(runId, taskId);
    await this.remove(runId, taskId);
    await git(this.repoRoot, ['worktree', 'add', '-B', this.branchName(runId, taskId), path, baseSha]);
    for (const branch of depBranches) {
      try {
        await git(path, ['merge', '--no-edit', branch]);
      } catch (err) {
        await git(path, ['merge', '--abort']).catch(() => {});
        throw new Error(`Could not merge dependency branch ${branch}: ${(err as Error).message}`);
      }
    }
    return path;
  }

  // Commits everything the agent left in the worktree. Returns false if there
  // was nothing to commit.
  async commitAll(path: string, message: string): Promise<boolean> {
    await git(path, ['add', '-A']);
    if (!(await git(path, ['status', '--porcelain']))) return false;
    await git(path, ['commit', '-m', message]);
    return true;
  }

  head(path: string): Promise<string> {
    return git(path, ['rev-parse', 'HEAD']);
  }

  // Committed changes of the task since the given commit.
  diffSince(path: string, sha: string): Promise<string> {
    return git(path, ['diff', sha, 'HEAD']);
  }

  // Throws away uncommitted changes. Ignored files, such as installed
  // dependencies, are kept.
  async discardChanges(path: string): Promise<void> {
    await git(path, ['reset', '--hard', '-q', 'HEAD']);
    await git(path, ['clean', '-fdq']);
  }

  // What a task branch changed since the given commit.
  diffBranch(fromSha: string, branch: string): Promise<string> {
    return git(this.repoRoot, ['diff', fromSha, branch]);
  }

  currentBranch(): Promise<string> {
    return git(this.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  }

  isMerged(branch: string): Promise<boolean> {
    return git(this.repoRoot, ['merge-base', '--is-ancestor', branch, 'HEAD']).then(
      () => true,
      () => false,
    );
  }

  // Merges a task branch into the branch checked out in the main checkout.
  // A conflicting merge is aborted, so the checkout is left as it was.
  async mergeIntoCurrent(branch: string): Promise<void> {
    if (await git(this.repoRoot, ['status', '--porcelain', '--untracked-files=no'])) {
      throw new Error('The checkout has uncommitted changes. Commit or stash them before merging.');
    }
    try {
      await git(this.repoRoot, ['merge', '--no-ff', '--no-edit', branch]);
    } catch (err) {
      await git(this.repoRoot, ['merge', '--abort']).catch(() => {});
      throw new Error(`Could not merge ${branch}: ${(err as Error).message}`);
    }
  }

  async remove(runId: string, taskId: string): Promise<void> {
    const path = this.pathFor(runId, taskId);
    await git(this.repoRoot, ['worktree', 'remove', '--force', path]).catch(() => {});
    await rm(path, { recursive: true, force: true });
    await git(this.repoRoot, ['worktree', 'prune']);
  }

  private async excludeStateDir(): Promise<void> {
    const commonDir = resolve(this.repoRoot, await git(this.repoRoot, ['rev-parse', '--git-common-dir']));
    const excludeFile = join(commonDir, 'info', 'exclude');
    const current = await readFile(excludeFile, 'utf8').catch(() => '');
    if (current.split('\n').some((line) => line.trim() === `${STATE_DIR}/`)) return;
    await mkdir(join(commonDir, 'info'), { recursive: true });
    await appendFile(excludeFile, `${current && !current.endsWith('\n') ? '\n' : ''}${STATE_DIR}/\n`);
  }
}
