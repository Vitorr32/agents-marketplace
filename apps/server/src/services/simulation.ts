import { randomUUID } from "node:crypto";
import type { Server as SocketServer } from "socket.io";
import {
  applyAction,
  createSeedState,
  findAgentById,
  getNextAgentId,
  type MarketEvent,
  type MarketState
} from "@agents-marketplace/engine";
import { config } from "../config.js";
import { AgentRuntime } from "./agentRuntime.js";

type SimulationUpdate = {
  state: MarketState;
  latestEvent?: MarketEvent;
};

export class SimulationService {
  private state = createSeedState();
  private runtime = new AgentRuntime(config);
  private interval: NodeJS.Timeout | null = null;
  private io: SocketServer | null = null;

  attachIo(io: SocketServer) {
    this.io = io;
  }

  getState() {
    return this.state;
  }

  async reset() {
    this.stopLoop();
    this.state = createSeedState();
    this.broadcast({ state: this.state });
    return this.state;
  }

  async toggleRun() {
    this.state.isRunning = !this.state.isRunning;

    if (this.state.isRunning) {
      this.startLoop();
      this.appendSystemEvent(`Simulation resumed at round ${this.state.round}.`);
    } else {
      this.stopLoop();
      this.appendSystemEvent(`Simulation paused at round ${this.state.round}.`);
    }

    this.broadcast({ state: this.state });
    return this.state;
  }

  async step() {
    const agentId = getNextAgentId(this.state);

    if (!agentId) {
      this.appendSystemEvent("No active agents available for stepping.");
      this.broadcast({ state: this.state });
      return this.state;
    }

    const runtimeResult = await this.runtime.chooseAction(this.state, agentId);
    this.state = applyAction(this.state, runtimeResult.action, runtimeResult.trace);
    this.broadcast({ state: this.state, latestEvent: this.state.events[0] });
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
  }

  private broadcast(update: SimulationUpdate) {
    this.io?.emit("simulation:update", update);
  }
}
