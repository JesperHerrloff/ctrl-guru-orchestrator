import { render } from 'ink';
import type { RunRecord, Store } from '../store.js';
import type { Worktrees } from '../worktrees.js';
import { App } from './App.js';

// Shows the terminal UI for a run. `work`, when given, runs the agents: it
// receives a signal that is aborted when the user asks to stop. The UI stays
// open after the work finishes, unless the user stopped it.
export async function runTui<T>(
  store: Store,
  worktrees: Worktrees,
  run: RunRecord,
  work?: (signal: AbortSignal) => Promise<T>,
): Promise<{ result?: T; stopped: boolean }> {
  const controller = new AbortController();
  const props = { store, worktrees, run, onStop: () => controller.abort() };

  const app = render(<App {...props} active={work !== undefined} />, { exitOnCtrlC: false, alternateScreen: true });
  try {
    let result: T | undefined;
    if (work) {
      result = await work(controller.signal);
      if (controller.signal.aborted) return { result, stopped: true };
      app.rerender(<App {...props} active={false} />);
    }
    await app.waitUntilExit();
    return { result, stopped: false };
  } finally {
    app.unmount();
  }
}
