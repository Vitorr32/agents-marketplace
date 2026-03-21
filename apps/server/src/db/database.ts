import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

export function createDatabase(databasePath: string) {
  const resolvedPath = resolve(databasePath);
  mkdirSync(dirname(resolvedPath), { recursive: true });

  const db = new Database(resolvedPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      round INTEGER NOT NULL,
      tick_count INTEGER NOT NULL,
      max_ticks INTEGER NOT NULL,
      status TEXT NOT NULL,
      is_running INTEGER NOT NULL,
      completion_reason TEXT,
      turn_agent_id TEXT NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tick_count INTEGER NOT NULL,
      round INTEGER NOT NULL,
      type TEXT NOT NULL,
      visibility TEXT NOT NULL,
      actor_agent_id TEXT,
      target_agent_id TEXT,
      content TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_session_events_session_seq
    ON session_events(session_id, seq);
  `);

  return db;
}
