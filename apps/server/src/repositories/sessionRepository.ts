import type Database from "better-sqlite3";
import type { MarketEvent, MarketState, SessionReplay, SessionSummary } from "@agents-marketplace/shared";

type SessionRow = {
  id: string;
  name: string;
  round: number;
  tick_count: number;
  max_ticks: number;
  status: SessionSummary["status"];
  completion_reason: string | null;
  created_at: string;
  updated_at: string;
  state_json: string;
};

type SessionEventRow = {
  id: string;
  round: number;
  type: MarketEvent["type"];
  visibility: MarketEvent["visibility"];
  actor_agent_id: string | null;
  target_agent_id: string | null;
  content: string;
  payload_json: string;
  created_at: string;
};

export class SessionRepository {
  constructor(private readonly db: Database.Database) {}

  loadLatestState() {
    const row = this.db
      .prepare(
        `
          SELECT state_json
          FROM sessions
          ORDER BY updated_at DESC
          LIMIT 1
        `
      )
      .get() as { state_json: string } | undefined;

    if (!row) {
      return null;
    }

    return JSON.parse(row.state_json) as MarketState;
  }

  saveState(state: MarketState, emittedEvents: MarketEvent[], createdAt?: string) {
    const now = new Date().toISOString();
    const created = createdAt ?? now;

    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `
            INSERT INTO sessions (
              id, name, round, tick_count, max_ticks, status, is_running, completion_reason,
              turn_agent_id, state_json, created_at, updated_at
            ) VALUES (
              @id, @name, @round, @tick_count, @max_ticks, @status, @is_running, @completion_reason,
              @turn_agent_id, @state_json, @created_at, @updated_at
            )
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              round = excluded.round,
              tick_count = excluded.tick_count,
              max_ticks = excluded.max_ticks,
              status = excluded.status,
              is_running = excluded.is_running,
              completion_reason = excluded.completion_reason,
              turn_agent_id = excluded.turn_agent_id,
              state_json = excluded.state_json,
              updated_at = excluded.updated_at
          `
        )
        .run({
          id: state.sessionId,
          name: state.sessionName,
          round: state.round,
          tick_count: state.tickCount,
          max_ticks: state.maxTicks,
          status: state.status,
          is_running: state.isRunning ? 1 : 0,
          completion_reason: state.completionReason ?? null,
          turn_agent_id: state.turnAgentId,
          state_json: JSON.stringify(state),
          created_at: created,
          updated_at: now
        });

      const insertEvent = this.db.prepare(
        `
          INSERT INTO session_events (
            id, session_id, tick_count, round, type, visibility,
            actor_agent_id, target_agent_id, content, payload_json, created_at
          ) VALUES (
            @id, @session_id, @tick_count, @round, @type, @visibility,
            @actor_agent_id, @target_agent_id, @content, @payload_json, @created_at
          )
        `
      );

      for (const event of emittedEvents) {
        insertEvent.run({
          id: event.id,
          session_id: state.sessionId,
          tick_count: state.tickCount,
          round: event.round,
          type: event.type,
          visibility: event.visibility,
          actor_agent_id: event.actorAgentId ?? null,
          target_agent_id: event.targetAgentId ?? null,
          content: event.content,
          payload_json: JSON.stringify(event),
          created_at: event.createdAt
        });
      }
    });

    transaction();
  }

  listSessions(limit = 20) {
    const rows = this.db
      .prepare(
        `
          SELECT id, name, round, tick_count, max_ticks, status, completion_reason, created_at, updated_at
          FROM sessions
          ORDER BY updated_at DESC
          LIMIT ?
        `
      )
      .all(limit) as SessionRow[];

    return rows.map(toSessionSummary);
  }

  getReplay(sessionId: string): SessionReplay | null {
    const sessionRow = this.db
      .prepare(
        `
          SELECT id, name, round, tick_count, max_ticks, status, completion_reason, created_at, updated_at, state_json
          FROM sessions
          WHERE id = ?
        `
      )
      .get(sessionId) as SessionRow | undefined;

    if (!sessionRow) {
      return null;
    }

    const eventRows = this.db
      .prepare(
        `
          SELECT id, round, type, visibility, actor_agent_id, target_agent_id, content, payload_json, created_at
          FROM session_events
          WHERE session_id = ?
          ORDER BY seq ASC
        `
      )
      .all(sessionId) as SessionEventRow[];

    return {
      session: toSessionSummary(sessionRow),
      events: eventRows.map((row) => JSON.parse(row.payload_json) as MarketEvent)
    };
  }
}

function toSessionSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    name: row.name,
    round: row.round,
    tickCount: row.tick_count,
    maxTicks: row.max_ticks,
    status: row.status,
    completionReason: row.completion_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
