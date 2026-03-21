import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Server as SocketServer } from "socket.io";
import { completeSession, createSeedState, findAgentById, getActiveAgentIds, type MarketEvent, type MarketState } from "@agents-marketplace/engine";
import type { SessionReplay, SessionSummary, TradeOffer } from "@agents-marketplace/shared";
import { config } from "../config.js";
import { createDatabase } from "../db/database.js";
import { SessionRepository } from "../repositories/sessionRepository.js";
import { AgentRuntime } from "./agentRuntime.js";

type SimulationUpdate = {
  state: MarketState;
  latestEvent?: MarketEvent;
};

type LlmStreamUpdate = {
  streamId: string;
  agentId: string;
  tickCount: number;
  stage: "announcement" | "whisper-init" | "whisper-reply" | "trade-proposal" | "trade-response";
  phase: "started" | "delta" | "completed" | "error";
  content: string;
};

export class SimulationService {
  private repository = new SessionRepository(createDatabase(config.databasePath));
  private state: MarketState;
  private runtime = new AgentRuntime(config);
  private interval: NodeJS.Timeout | null = null;
  private io: SocketServer | null = null;
  private stepInProgress = false;

  constructor() {
    const persistedState = this.repository.loadLatestState();

    if (persistedState) {
      this.state = {
        ...persistedState,
        isRunning: false,
        status: persistedState.status === "completed" ? "completed" : "paused",
        turnAgentId: "idle"
      };
      this.repository.saveState(this.state, []);
    } else {
      this.state = createSeedState();
      this.repository.saveState(this.state, this.state.events, this.state.events[0]?.createdAt);
    }
  }

  async initialize(logger: FastifyBaseLogger) {
    try {
      const message = await this.runtime.warmModel();
      logger.info(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Ollama warm-up error";
      logger.warn(`Model warm-up skipped: ${message}`);
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

    const event = this.appendSystemEvent(
      this.state.isRunning
        ? `Simulation resumed at tick ${this.state.tickCount + 1}.`
        : `Simulation paused at tick ${this.state.tickCount}.`
    );

    if (this.state.isRunning) {
      this.startLoop();
    } else {
      this.stopLoop();
    }

    this.repository.saveState(this.state, [event]);
    this.broadcast({ state: this.state, latestEvent: event });
    return this.state;
  }

  async step() {
    if (this.stepInProgress || this.state.status === "completed") {
      this.broadcast({ state: this.state });
      return this.state;
    }

    this.stepInProgress = true;

    try {
      const workingState = structuredClone(this.state);
      const emittedEvents: MarketEvent[] = [];
      const tickNumber = workingState.tickCount + 1;
      const agentIds = getActiveAgentIds(workingState);

      if (agentIds.length === 0) {
        const event = this.appendSystemEvent("No active agents available for ticking.");
        this.repository.saveState(this.state, [event]);
        this.broadcast({ state: this.state, latestEvent: event });
        return this.state;
      }

      pushEvent(workingState, emittedEvents, {
        id: randomUUID(),
        round: workingState.round,
        type: "tick",
        visibility: "public",
        content: `Tick ${tickNumber} started.`,
        createdAt: new Date().toISOString()
      });

      await this.runAnnouncementPhase(workingState, emittedEvents, tickNumber, agentIds);
      await this.runWhisperPhase(workingState, emittedEvents, tickNumber, agentIds);
      const doneAgentIds = await this.runTradePhase(workingState, emittedEvents, tickNumber, agentIds);

      workingState.doneAgentIds = doneAgentIds;
      workingState.tickCount += 1;
      workingState.round += 1;
      workingState.turnAgentId = "idle";
      workingState.status = "running";
      workingState.isRunning = this.state.isRunning;

      pushEvent(workingState, emittedEvents, {
        id: randomUUID(),
        round: workingState.round - 1,
        type: "tick",
        visibility: "public",
        content: `Tick ${tickNumber} ended with ${doneAgentIds.length} agents marked done.`,
        createdAt: new Date().toISOString()
      });

      this.state = workingState;

      const completionEvent = this.finalizeIfNeeded();
      if (completionEvent) {
        emittedEvents.push(completionEvent);
      }

      this.repository.saveState(this.state, emittedEvents);
      this.broadcast({
        state: this.state,
        latestEvent: emittedEvents[emittedEvents.length - 1] ?? this.state.events[0]
      });

      return this.state;
    } finally {
      this.stepInProgress = false;
    }
  }

  private async runAnnouncementPhase(
    workingState: MarketState,
    emittedEvents: MarketEvent[],
    tickNumber: number,
    agentIds: string[]
  ) {
    workingState.turnAgentId = "announcements";

    for (const agentId of agentIds) {
      const result = await this.runtime.generateAnnouncement(
        workingState,
        agentId,
        this.createStreamCallbacks(tickNumber, agentId, "announcement")
      );

      if (result.content) {
        pushEvent(workingState, emittedEvents, {
          id: randomUUID(),
          round: workingState.round,
          type: "announce",
          visibility: "public",
          actorAgentId: agentId,
          content: `${agentId} announced: ${result.content}`,
          createdAt: new Date().toISOString()
        });
      }

      pushEvent(workingState, emittedEvents, createDecisionEvent(workingState.round, agentId, result.trace));
    }
  }

  private async runWhisperPhase(
    workingState: MarketState,
    emittedEvents: MarketEvent[],
    tickNumber: number,
    agentIds: string[]
  ) {
    workingState.turnAgentId = "whispers";
    const priority = shuffle(agentIds);
    const closedPairs = new Set<string>();

    pushEvent(workingState, emittedEvents, {
      id: randomUUID(),
      round: workingState.round,
      type: "system",
      visibility: "public",
      content: `Whisper priority for tick ${tickNumber}: ${priority.join(", ")}.`,
      createdAt: new Date().toISOString()
    });

    for (const initiatorId of priority) {
      const unavailableTargets = priority.filter((candidate) => closedPairs.has(pairKey(initiatorId, candidate)));
      const start = await this.runtime.generateWhisperStart(
        workingState,
        initiatorId,
        unavailableTargets,
        this.createStreamCallbacks(tickNumber, initiatorId, "whisper-init")
      );

      if (!start.whisper) {
        pushEvent(workingState, emittedEvents, createDecisionEvent(workingState.round, initiatorId, start.trace));
        continue;
      }

      const targetId = start.whisper.targetAgentId;
      if (
        targetId === initiatorId ||
        !findAgentById(workingState, targetId) ||
        closedPairs.has(pairKey(initiatorId, targetId))
      ) {
        pushEvent(
          workingState,
          emittedEvents,
          createDecisionEvent(workingState.round, initiatorId, `Whisper target ${targetId} was invalid or unavailable.`)
        );
        continue;
      }

      pushEvent(workingState, emittedEvents, {
        id: randomUUID(),
        round: workingState.round,
        type: "whisper",
        visibility: "private",
        actorAgentId: initiatorId,
        targetAgentId: targetId,
        content: `${initiatorId} whispered to ${targetId}: ${start.whisper.message}`,
        createdAt: new Date().toISOString()
      });
      pushEvent(workingState, emittedEvents, createDecisionEvent(workingState.round, initiatorId, start.trace));

      const transcript = [{ speakerId: initiatorId, message: start.whisper.message }];
      let currentSpeaker = targetId;
      let otherSpeaker = initiatorId;
      let exchanged = 1;

      while (exchanged < 10) {
        const reply = await this.runtime.generateWhisperReply(
          workingState,
          currentSpeaker,
          otherSpeaker,
          transcript,
          this.createStreamCallbacks(tickNumber, currentSpeaker, "whisper-reply")
        );

        pushEvent(workingState, emittedEvents, createDecisionEvent(workingState.round, currentSpeaker, reply.trace));

        if (!reply.message) {
          break;
        }

        transcript.push({ speakerId: currentSpeaker, message: reply.message });
        pushEvent(workingState, emittedEvents, {
          id: randomUUID(),
          round: workingState.round,
          type: "whisper",
          visibility: "private",
          actorAgentId: currentSpeaker,
          targetAgentId: otherSpeaker,
          content: `${currentSpeaker} whispered to ${otherSpeaker}: ${reply.message}`,
          createdAt: new Date().toISOString()
        });

        exchanged += 1;
        [currentSpeaker, otherSpeaker] = [otherSpeaker, currentSpeaker];
      }

      closedPairs.add(pairKey(initiatorId, targetId));
    }
  }

  private async runTradePhase(
    workingState: MarketState,
    emittedEvents: MarketEvent[],
    tickNumber: number,
    agentIds: string[]
  ) {
    workingState.turnAgentId = "trades";
    const doneAgentIds: string[] = [];

    for (const agentId of agentIds) {
      const result = await this.runtime.generateTradeProposal(
        workingState,
        agentId,
        this.createStreamCallbacks(tickNumber, agentId, "trade-proposal")
      );

      if (result.kind === "done") {
        doneAgentIds.push(agentId);
        pushEvent(workingState, emittedEvents, createDecisionEvent(workingState.round, agentId, result.trace));
        continue;
      }

      if (result.kind === "pass") {
        pushEvent(workingState, emittedEvents, createDecisionEvent(workingState.round, agentId, result.trace));
        continue;
      }

      const validation = validateTradeFromProposerPerspective(workingState, agentId, result.proposal);

      if (!validation.ok) {
        pushEvent(
          workingState,
          emittedEvents,
          createDecisionEvent(workingState.round, agentId, `Trade blocked by the game master: ${validation.reason}`)
        );
        continue;
      }

      const offer: TradeOffer = {
        id: randomUUID(),
        fromAgentId: agentId,
        toAgentId: result.proposal.targetAgentId,
        giveItemIds: [...result.proposal.giveItemIds],
        requestItemIds: [...result.proposal.requestItemIds],
        cashFromProposer: result.proposal.cashFromProposer,
        status: "open",
        message: result.proposal.message,
        createdAt: new Date().toISOString()
      };

      workingState.offers.unshift(offer);
      pushEvent(workingState, emittedEvents, {
        id: randomUUID(),
        round: workingState.round,
        type: "offer",
        visibility: "public",
        actorAgentId: offer.fromAgentId,
        targetAgentId: offer.toAgentId,
        content: `${offer.fromAgentId} offered ${offer.giveItemIds.join(", ") || "nothing"} and $${offer.cashFromProposer} to ${offer.toAgentId} for ${offer.requestItemIds.join(", ") || "nothing"}.`,
        createdAt: new Date().toISOString()
      });
      pushEvent(workingState, emittedEvents, createDecisionEvent(workingState.round, agentId, result.trace));

      const response = await this.runtime.generateTradeResponse(
        workingState,
        offer.toAgentId,
        {
          fromAgentId: offer.fromAgentId,
          giveItemIds: offer.giveItemIds,
          requestItemIds: offer.requestItemIds,
          cashFromProposer: offer.cashFromProposer,
          message: offer.message
        },
        this.createStreamCallbacks(tickNumber, offer.toAgentId, "trade-response")
      );

      pushEvent(workingState, emittedEvents, createDecisionEvent(workingState.round, offer.toAgentId, response.trace));

      if (response.decision === "accept") {
        const settlement = validateTradeForSettlement(workingState, offer);

        if (!settlement.ok) {
          offer.status = "invalid";
          offer.respondedAt = new Date().toISOString();
          pushEvent(
            workingState,
            emittedEvents,
            createDecisionEvent(
              workingState.round,
              offer.toAgentId,
              `${offer.toAgentId} rejected ${offer.fromAgentId}'s offer: ${settlement.reason}`
            )
          );
          continue;
        }

        settleTrade(workingState, offer);
        offer.status = "settled";
        offer.respondedAt = new Date().toISOString();
        offer.settledAt = offer.respondedAt;
        pushEvent(workingState, emittedEvents, {
          id: randomUUID(),
          round: workingState.round,
          type: "trade",
          visibility: "public",
          actorAgentId: offer.fromAgentId,
          targetAgentId: offer.toAgentId,
          content: `${offer.toAgentId} accepted ${offer.fromAgentId}'s offer and the trade settled immediately.`,
          createdAt: new Date().toISOString()
        });
      } else {
        offer.status = "rejected";
        offer.respondedAt = new Date().toISOString();
        pushEvent(
          workingState,
          emittedEvents,
          createDecisionEvent(
            workingState.round,
            offer.toAgentId,
            `${offer.toAgentId} rejected ${offer.fromAgentId}'s offer: ${response.reason}`
          )
        );
      }
    }

    return doneAgentIds;
  }

  private createStreamCallbacks(
    tickCount: number,
    agentId: string,
    stage: LlmStreamUpdate["stage"]
  ) {
    const streamId = `${this.state.sessionId}:${tickCount}:${stage}:${agentId}:${randomUUID()}`;

    return {
      onStart: () => {
        this.broadcastLlmStream({ streamId, agentId, tickCount, stage, phase: "started", content: "" });
      },
      onToken: (_chunk: string, aggregate: string) => {
        this.broadcastLlmStream({ streamId, agentId, tickCount, stage, phase: "delta", content: aggregate });
      },
      onComplete: (aggregate: string) => {
        this.broadcastLlmStream({ streamId, agentId, tickCount, stage, phase: "completed", content: aggregate });
      },
      onError: (message: string) => {
        this.broadcastLlmStream({ streamId, agentId, tickCount, stage, phase: "error", content: message });
      }
    };
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
    const event: MarketEvent = {
      id: randomUUID(),
      round: this.state.round,
      type: "system",
      visibility: "public",
      content,
      createdAt: new Date().toISOString()
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

  private broadcastLlmStream(update: LlmStreamUpdate) {
    this.io?.emit("simulation:llm-stream", update);
  }

  private finalizeIfNeeded() {
    if (this.state.tickCount >= this.state.maxTicks) {
      this.stopLoop();
      const completed = completeSession(this.state, `Session reached the ${this.state.maxTicks}-tick cap.`);
      this.state = completed.state;
      return completed.event;
    }

    if (this.state.doneAgentIds.length === this.state.agents.length) {
      this.stopLoop();
      const completed = completeSession(this.state, "All agents marked themselves done trading.");
      this.state = completed.state;
      return completed.event;
    }

    return null;
  }
}

function createDecisionEvent(round: number, agentId: string, content: string): MarketEvent {
  return {
    id: randomUUID(),
    round,
    type: "decision",
    visibility: "public",
    actorAgentId: agentId,
    content,
    createdAt: new Date().toISOString()
  };
}

function pushEvent(state: MarketState, emittedEvents: MarketEvent[], event: MarketEvent) {
  emittedEvents.push(event);
  state.events = [event, ...state.events].slice(0, 200);
}

function shuffle<T>(values: T[]) {
  const clone = [...values];

  for (let index = clone.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [clone[index], clone[swapIndex]] = [clone[swapIndex], clone[index]];
  }

  return clone;
}

function pairKey(left: string, right: string) {
  return [left, right].sort().join("::");
}

function validateTradeFromProposerPerspective(
  state: MarketState,
  proposerId: string,
  proposal: {
    targetAgentId: string;
    giveItemIds: string[];
    requestItemIds: string[];
    cashFromProposer: number;
    message: string;
  }
) {
  const proposer = findAgentById(state, proposerId);
  const target = findAgentById(state, proposal.targetAgentId);

  if (!proposer || !target) {
    return { ok: false, reason: "Unknown proposer or target." };
  }

  if (proposerId === proposal.targetAgentId) {
    return { ok: false, reason: "Agents cannot trade with themselves." };
  }

  if (proposal.cashFromProposer < 0 || proposer.budget < proposal.cashFromProposer) {
    return { ok: false, reason: "Proposer cannot cover the offered cash." };
  }

  if (!proposal.giveItemIds.every((itemId) => proposer.inventory.includes(itemId))) {
    return { ok: false, reason: "Proposer does not own all offered items." };
  }

  return { ok: true };
}

function validateTradeForSettlement(state: MarketState, offer: TradeOffer) {
  const proposer = findAgentById(state, offer.fromAgentId);
  const target = findAgentById(state, offer.toAgentId);

  if (!proposer || !target) {
    return { ok: false, reason: "One party is no longer available." };
  }

  if (!offer.giveItemIds.every((itemId) => proposer.inventory.includes(itemId))) {
    return { ok: false, reason: "You cannot see all of the items being offered on their side anymore." };
  }

  if (!offer.requestItemIds.every((itemId) => target.inventory.includes(itemId))) {
    return { ok: false, reason: "I do not currently have what you are asking for." };
  }

  if (proposer.budget < offer.cashFromProposer) {
    return { ok: false, reason: "The proposer can no longer fund the cash side of the deal." };
  }

  return { ok: true };
}

function settleTrade(state: MarketState, offer: TradeOffer) {
  const proposer = findAgentById(state, offer.fromAgentId);
  const target = findAgentById(state, offer.toAgentId);

  if (!proposer || !target) {
    return;
  }

  proposer.inventory = proposer.inventory.filter((itemId) => !offer.giveItemIds.includes(itemId));
  target.inventory = target.inventory.filter((itemId) => !offer.requestItemIds.includes(itemId));
  proposer.inventory.push(...offer.requestItemIds);
  target.inventory.push(...offer.giveItemIds);
  proposer.budget -= offer.cashFromProposer;
  target.budget += offer.cashFromProposer;
}
