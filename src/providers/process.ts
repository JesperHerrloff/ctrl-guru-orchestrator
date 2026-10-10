import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const TERM_REPEAT_MS = 250;
const KILL_GRACE_MS = 5000;

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
    // Its own process group, so that stopping the agent also stops whatever it started.
    // PWD has to follow cwd: opencode takes its working directory from it.
    const child = spawn(bin, args, {
      cwd: options.cwd,
      env: { ...process.env, PWD: options.cwd },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    let stderrTail = '';

    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, signal);
      } catch {
        // Signalling the group can fail while a member is exiting; reach the agent itself at least.
        child.kill(signal);
      }
    };
    const timers: NodeJS.Timeout[] = [];
    const stop = () => {
      signalGroup('SIGTERM');
      // A process forked at the moment of the first signal can be missed, so ask again.
      timers.push(setTimeout(() => signalGroup('SIGTERM'), TERM_REPEAT_MS));
      timers.push(setTimeout(() => signalGroup('SIGKILL'), KILL_GRACE_MS));
    };
    if (options.signal.aborted) stop();
    else options.signal.addEventListener('abort', stop, { once: true });

    createInterface({ input: child.stdout }).on('line', options.onLine);
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
      if (chunk.trim()) options.onStderr(chunk.trimEnd());
    });

    child.on('error', (err) => reject(new Error(`Could not start ${bin}: ${err.message}`)));
    child.on('close', (code, signal) => {
      options.signal.removeEventListener('abort', stop);
      for (const timer of timers) clearTimeout(timer);
      resolve({ exit: signal ? `killed by ${signal}` : `exited with code ${code}`, stderrTail: stderrTail.trim() });
    });

    child.stdin.on('error', () => {}); // the process may exit before reading the prompt
    child.stdin.end(options.stdin);
  });
}
