import { randomUUID } from "node:crypto";
import type { Server as SocketServer } from "socket.io";
import {
  applyAction,
  completeSession,
  createSeedState,
  findAgentById,
  getNextAgentId,
  type MarketEvent,
  type MarketState
} from "@agents-marketplace/engine";
import type { SessionReplay, SessionSummary } from "@agents-marketplace/shared";
import { config } from "../config.js";
import { createDatabase } from "../db/database.js";
import { SessionRepository } from "../repositories/sessionRepository.js";
import { AgentRuntime } from "./agentRuntime.js";

type SimulationUpdate = {
  state: MarketState;
  latestEvent?: MarketEvent;
};

export class SimulationService {
  private repository = new SessionRepository(createDatabase(config.databasePath));
  private state: MarketState;
  private runtime = new AgentRuntime(config);
  private interval: NodeJS.Timeout | null = null;
  private io: SocketServer | null = null;

  constructor() {
    const persistedState = this.repository.loadLatestState();

    if (persistedState) {
      this.state = {
        ...persistedState,
        isRunning: false,
        status: persistedState.status === "completed" ? "completed" : "paused"
      };
      this.repository.saveState(this.state, []);
    } else {
      this.state = createSeedState();
      this.repository.saveState(this.state, this.state.events, this.state.events[0]?.createdAt);
    }
  }

  attachIo(io: SocketServer) {
    this.io = io;
  }

  getState() {
    return this.state;
  }

  listSessions(): SessionSummary[] {
    return this.repository.listSessions();
  }

  getReplay(sessionId: string): SessionReplay | null {
    return this.repository.getReplay(sessionId);
  }

  async reset() {
    this.stopLoop();
    this.state = createSeedState();
    this.repository.saveState(this.state, this.state.events, this.state.events[0]?.createdAt);
    this.broadcast({ state: this.state });
    return this.state;
  }

  async toggleRun() {
    if (this.state.status === "completed") {
      this.broadcast({ state: this.state });
      return this.state;
    }

    this.state.isRunning = !this.state.isRunning;
    this.state.status = this.state.isRunning ? "running" : "paused";

    if (this.state.isRunning) {
      this.startLoop();
      this.appendSystemEvent(`Simulation resumed at round ${this.state.round}.`);
    } else {
      this.stopLoop();
      this.appendSystemEvent(`Simulation paused at round ${this.state.round}.`);
    }

    this.repository.saveState(this.state, this.state.events.slice(0, 1));
    this.broadcast({ state: this.state });
    return this.state;
  }

  async step() {
    if (this.state.status === "completed") {
      this.broadcast({ state: this.state });
      return this.state;
    }

    const agentId = getNextAgentId(this.state);

    if (!agentId) {
      this.appendSystemEvent("No active agents available for stepping.");
      this.repository.saveState(this.state, this.state.events.slice(0, 1));
      this.broadcast({ state: this.state });
      return this.state;
    }

    const runtimeResult = await this.runtime.chooseAction(this.state, agentId);
    const result = applyAction(this.state, runtimeResult.action, runtimeResult.trace);
    this.state = result.state;

    const persistedEvents = [...result.emittedEvents];
    const completionEvent = this.finalizeIfNeeded();
    if (completionEvent) {
      persistedEvents.push(completionEvent);
    }

    this.repository.saveState(this.state, persistedEvents);
    this.broadcast({ state: this.state, latestEvent: persistedEvents[persistedEvents.length - 1] ?? this.state.events[0] });
    return this.state;
  }

  private startLoop() {
    if (this.interval) {
      return;
    }

    this.interval = setInterval(() => {
      void this.step();
    }, config.stepIntervalMs);
  }

  private stopLoop() {
    if (!this.interval) {
      return;
    }

    clearInterval(this.interval);
    this.interval = null;
  }

  private appendSystemEvent(content: string) {
    const activeAgent = findAgentById(this.state, this.state.turnAgentId);
    const event: MarketEvent = {
      id: randomUUID(),
      round: this.state.round,
      type: "system",
      visibility: "public",
      content,
      createdAt: new Date().toISOString(),
      actorAgentId: activeAgent?.id
    };

    this.state = {
      ...this.state,
      events: [event, ...this.state.events].slice(0, 200)
    };

    return event;
  }

  private broadcast(update: SimulationUpdate) {
    this.io?.emit("simulation:update", update);
  }

  private finalizeIfNeeded() {
    if (this.state.tickCount >= this.state.maxTicks) {
      this.stopLoop();
      const completed = completeSession(
        {
          ...this.state,
          status: "running"
        },
        `Session reached the ${this.state.maxTicks}-tick cap.`
      );
      this.state = completed.state;
      return completed.event;
    }

    if (this.state.doneAgentIds.length === this.state.agents.length) {
      this.stopLoop();
      const completed = completeSession(
        {
          ...this.state,
          status: "running"
        },
        "All agents passed in sequence and declared the market inactive."
      );
      this.state = completed.state;
      return completed.event;
    }

    return null;
  }
}
