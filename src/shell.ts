import { execFile } from 'node:child_process';

export interface ShellResult {
  ok: boolean;
  output: string;
}

// Runs a shell command and captures its combined output. A failing command is
// a normal result; only an aborted signal throws.
export function runShell(command: string, cwd: string, signal: AbortSignal, timeoutMs: number): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    execFile('sh', ['-c', command], { cwd, signal, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      if (!err) return resolve({ ok: true, output });
      if (signal.aborted) return reject(err);
      if (err.killed) return resolve({ ok: false, output: `${output}\n(timed out after ${Math.round(timeoutMs / 1000)}s)`.trim() });
      resolve({ ok: false, output: output || err.message });
    });
  });
}
