import { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.js';

export type TaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked';

export interface RunRecord {
  id: string;
  createdAt: string;
  baseSha: string;
  config: Config;
}

export interface TaskRecord {
  runId: string;
  id: string;
  status: TaskStatus;
  attempts: number;
  costUsd: number;
  // Commit the task's own changes start from: the run base plus its dependencies.
  baseSha: string | null;
  sessionId: string | null;
  summary: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface EventRecord {
  ts: string;
  taskId: string;
  kind: string;
  data: string;
}

const TASK_COLUMNS = {
  status: 'status',
  attempts: 'attempts',
  costUsd: 'cost_usd',
  baseSha: 'base_sha',
  sessionId: 'session_id',
  summary: 'summary',
  error: 'error',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
} as const;

export type TaskPatch = Partial<Pick<TaskRecord, keyof typeof TASK_COLUMNS>>;

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        base_sha TEXT NOT NULL,
        config TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        run_id TEXT NOT NULL REFERENCES runs(id),
        id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        base_sha TEXT,
        session_id TEXT,
        summary TEXT,
        error TEXT,
        started_at TEXT,
        finished_at TEXT,
        PRIMARY KEY (run_id, id)
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_by_task ON events (run_id, task_id, seq);
    `);
  }

  close(): void {
    this.db.close();
  }

  createRun(run: RunRecord): void {
    this.db
      .prepare('INSERT INTO runs (id, created_at, base_sha, config) VALUES (?, ?, ?, ?)')
      .run(run.id, run.createdAt, run.baseSha, JSON.stringify(run.config));
    const insert = this.db.prepare('INSERT INTO tasks (run_id, id) VALUES (?, ?)');
    for (const task of run.config.tasks) insert.run(run.id, task.id);
  }

  getRun(id: string): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return row ? toRun(row) : undefined;
  }

  latestRun(): RunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC, rowid DESC LIMIT 1').get();
    return row ? toRun(row) : undefined;
  }

  listTasks(runId: string): TaskRecord[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY rowid')
      .all(runId)
      .map((row: any) => ({
        runId: row.run_id,
        id: row.id,
        status: row.status,
        attempts: row.attempts,
        costUsd: row.cost_usd,
        baseSha: row.base_sha,
        sessionId: row.session_id,
        summary: row.summary,
        error: row.error,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
      }));
  }

  updateTask(runId: string, id: string, patch: TaskPatch): void {
    const keys = Object.keys(patch) as (keyof TaskPatch)[];
    if (keys.length === 0) return;
    const sets = keys.map((key) => `${TASK_COLUMNS[key]} = ?`).join(', ');
    const values = keys.map((key) => patch[key] ?? null);
    this.db.prepare(`UPDATE tasks SET ${sets} WHERE run_id = ? AND id = ?`).run(...values, runId, id);
  }

  totalCost(runId: string): number {
    const row: any = this.db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS total FROM tasks WHERE run_id = ?').get(runId);
    return row.total;
  }

  addEvent(runId: string, taskId: string, kind: string, data: string): void {
    this.db
      .prepare('INSERT INTO events (run_id, task_id, ts, kind, data) VALUES (?, ?, ?, ?, ?)')
      .run(runId, taskId, new Date().toISOString(), kind, data);
  }

  // The most recent events of a task, oldest first.
  tailEvents(runId: string, taskId: string, limit: number): EventRecord[] {
    return this.db
      .prepare('SELECT ts, task_id, kind, data FROM events WHERE run_id = ? AND task_id = ? ORDER BY seq DESC LIMIT ?')
      .all(runId, taskId, limit)
      .map((row: any) => ({ ts: row.ts, taskId: row.task_id, kind: row.kind, data: row.data }))
      .reverse();
  }

  listEvents(runId: string, taskId: string): EventRecord[] {
    return this.db
      .prepare('SELECT ts, task_id, kind, data FROM events WHERE run_id = ? AND task_id = ? ORDER BY seq')
      .all(runId, taskId)
      .map((row: any) => ({ ts: row.ts, taskId: row.task_id, kind: row.kind, data: row.data }));
  }
}

function toRun(row: any): RunRecord {
  return { id: row.id, createdAt: row.created_at, baseSha: row.base_sha, config: JSON.parse(row.config) };
}
