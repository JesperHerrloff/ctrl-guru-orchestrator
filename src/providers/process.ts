import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface LineProcessOptions {
  cwd: string;
  stdin: string;
  signal: AbortSignal;
  onLine: (line: string) => void;
  onStderr: (text: string) => void;
}

// Runs an agent CLI, feeds it the prompt on stdin and hands back its stdout
// line by line. Resolves with a description of how the process ended.
export function runLineProcess(bin: string, args: string[], options: LineProcessOptions): Promise<{ exit: string; stderrTail: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
    });
    let stderrTail = '';

    createInterface({ input: child.stdout }).on('line', options.onLine);
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
      if (chunk.trim()) options.onStderr(chunk.trimEnd());
    });

    child.on('error', (err) => {
      if (err.name === 'AbortError') return; // 'close' still fires and settles the promise
      reject(new Error(`Could not start ${bin}: ${err.message}`));
    });
    child.on('close', (code, signal) => {
      resolve({ exit: signal ? `killed by ${signal}` : `exited with code ${code}`, stderrTail: stderrTail.trim() });
    });

    child.stdin.on('error', () => {}); // the process may exit before reading the prompt
    child.stdin.end(options.stdin);
  });
}
