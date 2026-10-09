import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { formatEvent } from '../scheduler.js';
import type { EventRecord, RunRecord, Store, TaskRecord, TaskStatus } from '../store.js';
import type { Worktrees } from '../worktrees.js';

export interface AppProps {
  store: Store;
  worktrees: Worktrees;
  run: RunRecord;
  // True while agents are running in this process.
  active: boolean;
  onStop: () => void;
  pollMs?: number;
}

type View = 'log' | 'diff';

interface Line {
  text: string;
  color?: string;
  dim?: boolean;
}

const STATUS: Record<TaskStatus, { icon: string; color?: string }> = {
  pending: { icon: '·' },
  running: { icon: '●', color: 'yellow' },
  done: { icon: '✔', color: 'green' },
  failed: { icon: '✘', color: 'red' },
  blocked: { icon: '⊘', color: 'gray' },
};

const LIST_WIDTH = 36;
const MAX_LOG_EVENTS = 2000;

export function logLines(events: EventRecord[]): Line[] {
  return events.flatMap((event) => {
    const time = new Date(event.ts).toTimeString().slice(0, 8);
    const style: Omit<Line, 'text'> =
      event.kind === 'error' || event.kind === 'stderr'
        ? { color: 'red' }
        : event.kind === 'status'
          ? { color: 'cyan' }
          : event.kind === 'review'
            ? { color: 'magenta' }
            : event.kind === 'tool' || event.kind === 'session'
              ? { dim: true }
              : {};
    return formatEvent(event.kind, event.data)
      .split('\n')
      .map((text, index) => ({ text: `${index === 0 ? time : ' '.repeat(8)} ${text}`, ...style }));
  });
}

export function diffLines(diff: string): Line[] {
  return diff.split('\n').map((raw) => {
    const text = raw.replaceAll('\t', '  ');
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff ')) return { text, color: 'white' };
    if (raw.startsWith('@@')) return { text, color: 'cyan' };
    if (raw.startsWith('+')) return { text, color: 'green' };
    if (raw.startsWith('-')) return { text, color: 'red' };
    return { text, dim: true };
  });
}

export function App({ store, worktrees, run, active, onStop, pollMs = 300 }: AppProps) {
  const { exit } = useApp();
  const size = useWindowSize();
  const [tasks, setTasks] = useState<TaskRecord[]>(() => store.listTasks(run.id));
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [selected, setSelected] = useState(0);
  const [view, setView] = useState<View>('log');
  // Lines scrolled up from the end of the log, or down from the top of the diff.
  const [scroll, setScroll] = useState(0);
  const [diff, setDiff] = useState<Line[]>([]);
  const [merged, setMerged] = useState<Set<string>>(new Set());
  const [mergeTick, setMergeTick] = useState(0);
  const [confirm, setConfirm] = useState<{ taskId: string; target: string } | undefined>();
  const [message, setMessage] = useState('');
  const [stopping, setStopping] = useState(false);

  const task = tasks[selected];
  const taskId = task?.id;
  const specs = useMemo(() => new Map(run.config.tasks.map((spec) => [spec.id, spec])), [run]);
  const doneIds = tasks
    .filter((item) => item.status === 'done')
    .map((item) => item.id)
    .join(',');

  useEffect(() => {
    const refresh = () => {
      setTasks(store.listTasks(run.id));
      if (taskId) setEvents(store.tailEvents(run.id, taskId, MAX_LOG_EVENTS));
    };
    refresh();
    const timer = setInterval(refresh, pollMs);
    return () => clearInterval(timer);
  }, [store, run.id, taskId, pollMs]);

  useEffect(() => {
    let current = true;
    const ids = doneIds ? doneIds.split(',') : [];
    Promise.all(ids.map(async (id) => ((await worktrees.isMerged(worktrees.branchName(run.id, id))) ? id : undefined))).then(
      (result) => current && setMerged(new Set(result.filter((id) => id !== undefined))),
    );
    return () => void (current = false);
  }, [worktrees, run.id, doneIds, mergeTick]);

  useEffect(() => {
    if (view !== 'diff' || !task) return;
    let current = true;
    const show = (lines: Line[]) => current && setDiff(lines);
    if (!task.baseSha) {
      show([{ text: 'This task has not produced a branch yet.', dim: true }]);
    } else {
      worktrees.diffBranch(task.baseSha, worktrees.branchName(run.id, task.id)).then(
        (text) => show(text ? diffLines(text) : [{ text: 'No changes.', dim: true }]),
        (err: Error) => show([{ text: err.message, color: 'red' }]),
      );
    }
    return () => void (current = false);
  }, [view, worktrees, run.id, task?.id, task?.baseSha, task?.status]);

  const bodyHeight = Math.max(3, size.rows - 4);
  const lines = view === 'log' ? logLines(events) : diff;
  const maxScroll = Math.max(0, lines.length - bodyHeight);
  const offset = Math.min(scroll, maxScroll);
  const visible =
    view === 'log'
      ? lines.slice(Math.max(0, lines.length - bodyHeight - offset), lines.length - offset)
      : lines.slice(offset, offset + bodyHeight);

  const select = (index: number) => {
    setSelected(Math.max(0, Math.min(tasks.length - 1, index)));
    setScroll(0);
    setMessage('');
  };
  const page = (towardsStart: boolean) => {
    const step = Math.max(1, bodyHeight - 2);
    const up = view === 'log' ? towardsStart : !towardsStart;
    setScroll(Math.max(0, Math.min(maxScroll, offset + (up ? step : -step))));
  };

  const merge = async (id: string) => {
    try {
      await worktrees.mergeIntoCurrent(worktrees.branchName(run.id, id));
      setMessage(`Merged ${id}.`);
      setMergeTick((tick) => tick + 1);
    } catch (err) {
      setMessage((err as Error).message.split('\n')[0]!);
    }
  };

  useInput((input, key) => {
    if (confirm) {
      const { taskId: id } = confirm;
      setConfirm(undefined);
      if (input === 'y') void merge(id);
      return;
    }
    if (input === 'q' || (key.ctrl && input === 'c')) {
      if (!active) return exit();
      setStopping(true);
      onStop();
    } else if (key.upArrow || input === 'k') select(selected - 1);
    else if (key.downArrow || input === 'j') select(selected + 1);
    else if (input === 'l') (setView('log'), setScroll(0));
    else if (input === 'd') (setView('diff'), setScroll(0));
    else if (key.pageUp || input === 'u') page(true);
    else if (key.pageDown || input === 'n') page(false);
    else if (input === 'm' && task) {
      if (task.status !== 'done') setMessage('Only a finished task can be merged.');
      else if (merged.has(task.id)) setMessage(`${task.id} is already merged.`);
      else void worktrees.currentBranch().then((target) => setConfirm({ taskId: task.id, target }));
    }
  });

  const cost = tasks.reduce((sum, item) => sum + item.costUsd, 0);
  const count = (status: TaskStatus) => tasks.filter((item) => item.status === status).length;
  const state = stopping ? 'stopping agents…' : active ? 'running' : 'idle';

  return (
    <Box flexDirection="column" height={size.rows} width={size.columns}>
      <Box>
        <Text bold>ctrl-guru </Text>
        <Text wrap="truncate-end">
          run {run.id} · {state} · {count('done')}/{tasks.length} done
          {count('failed') ? ` · ${count('failed')} failed` : ''}
          {count('blocked') ? ` · ${count('blocked')} blocked` : ''} · ${cost.toFixed(2)}
        </Text>
      </Box>
      <Box height={bodyHeight} marginTop={1}>
        <Box flexDirection="column" width={LIST_WIDTH} flexShrink={0}>
          {tasks.slice(0, bodyHeight).map((item, index) => {
            const provider = specs.get(item.id)?.provider ?? run.config.defaults.provider;
            const label = `${item.id.slice(0, 16).padEnd(16)} ${provider.padEnd(6)} ${`$${item.costUsd.toFixed(2)}`.padStart(6)}`;
            return (
              <Text key={item.id} wrap="truncate-end" inverse={index === selected}>
                <Text color={STATUS[item.status].color}>{STATUS[item.status].icon}</Text> {label}
                {merged.has(item.id) ? ' ⇄' : '  '}
              </Text>
            );
          })}
        </Box>
        <Box flexDirection="column" flexGrow={1} marginLeft={1}>
          {visible.length === 0 ? (
            <Text dimColor>{view === 'log' ? 'No output yet.' : ''}</Text>
          ) : (
            visible.map((line, index) => (
              <Text key={index} wrap="truncate-end" color={line.color} dimColor={line.dim}>
                {line.text || ' '}
              </Text>
            ))
          )}
        </Box>
      </Box>
      <Box marginTop={1}>
        {confirm ? (
          <Text color="yellow" wrap="truncate-end">
            Merge {worktrees.branchName(run.id, confirm.taskId)} into {confirm.target}? y/n
          </Text>
        ) : (
          <Text wrap="truncate-end">
            {message ? <Text color="yellow">{message} </Text> : null}
            <Text dimColor>
              ↑↓ task · l log · d diff · PgUp/PgDn scroll · m merge · q {active ? 'stop' : 'quit'} · {view}
              {task ? ` of ${task.id}` : ''}
              {task?.error ? ` · ${task.error.split('\n')[0]}` : ''}
            </Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}
