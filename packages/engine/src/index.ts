import { randomUUID } from "node:crypto";
import type {
  AgentProfile,
  AgentTickPlan,
  Item,
  MarketEvent,
  MarketOrder,
  MarketState,
  OfferResponseIntent,
  TradeOffer,
  TradeOfferIntent,
  WhisperIntent
} from "@agents-marketplace/shared";

export type {
  AgentProfile,
  AgentTickPlan,
  Item,
  MarketEvent,
  MarketState,
  OfferResponseIntent,
  TradeOffer,
  TradeOfferIntent,
  WhisperIntent
};

const MAX_TICKS = 1000;
const MAX_WHISPERS_PER_TARGET_PER_TICK = 10;
const AGENT_CONTEXT_TICK_WINDOW = 10;

const ITEMS: Item[] = [
  { id: "saffron", name: "Saffron", description: "Rare spice cache.", category: "luxury" },
  { id: "solar-lens", name: "Solar Lens", description: "Portable focusing array.", category: "tech" },
  { id: "tea-bricks", name: "Tea Bricks", description: "Aged ceremonial tea.", category: "consumable" },
  { id: "ink-map", name: "Ink Map", description: "Mutable map with hidden routes.", category: "artifact" },
  { id: "copper-key", name: "Copper Key", description: "Opens an unknown lock.", category: "artifact" },
  { id: "reef-glass", name: "Reef Glass", description: "Shimmering ocean glass.", category: "luxury" },
  { id: "repair-kit", name: "Repair Kit", description: "Universal tool bundle.", category: "utility" },
  { id: "amber-chip", name: "Amber Chip", description: "Encrypted data fragment.", category: "tech" }
];

const SEED_AGENTS: AgentProfile[] = [
  {
    id: "marlo",
    name: "Marlo Vane",
    persona: "A smooth-talking broker who overpays only when cornered.",
    budget: 48,
    inventory: ["tea-bricks", "reef-glass"],
    wishlist: ["solar-lens", "ink-map", "copper-key"],
    valuations: {
      saffron: 28,
      "solar-lens": 52,
      "tea-bricks": 14,
      "ink-map": 41,
      "copper-key": 38,
      "reef-glass": 16,
      "repair-kit": 18,
      "amber-chip": 26
    }
  },
  {
    id: "iara",
    name: "Iara Flint",
    persona: "A patient scavenger who values hidden utility over status.",
    budget: 34,
    inventory: ["solar-lens", "repair-kit"],
    wishlist: ["amber-chip", "copper-key", "saffron"],
    valuations: {
      saffron: 37,
      "solar-lens": 24,
      "tea-bricks": 10,
      "ink-map": 32,
      "copper-key": 39,
      "reef-glass": 12,
      "repair-kit": 31,
      "amber-chip": 44
    }
  },
  {
    id: "quill",
    name: "Quill Mercer",
    persona: "A collector obsessed with completing symbolic sets.",
    budget: 56,
    inventory: ["ink-map", "amber-chip"],
    wishlist: ["reef-glass", "tea-bricks", "saffron"],
    valuations: {
      saffron: 35,
      "solar-lens": 27,
      "tea-bricks": 33,
      "ink-map": 19,
      "copper-key": 26,
      "reef-glass": 29,
      "repair-kit": 17,
      "amber-chip": 21
    }
  },
  {
    id: "toma",
    name: "Toma Reed",
    persona: "A guarded opportunist who trades hard for liquidity.",
    budget: 61,
    inventory: ["saffron", "copper-key"],
    wishlist: ["repair-kit", "solar-lens", "amber-chip"],
    valuations: {
      saffron: 18,
      "solar-lens": 36,
      "tea-bricks": 15,
      "ink-map": 22,
      "copper-key": 20,
      "reef-glass": 14,
      "repair-kit": 42,
      "amber-chip": 35
    }
  }
];

export type AgentVisibleState = {
  round: number;
  tickCount: number;
  maxTicks: number;
  self: {
    id: string;
    name: string;
    persona: string;
    budget: number;
    inventory: string[];
    wishlist: string[];
    valuations: Record<string, number>;
    doneTrading: boolean;
  } | null;
  publicAgents: Array<{
    id: string;
    name: string;
    persona: string;
    doneTrading: boolean;
  }>;
  items: Item[];
  openOffers: TradeOffer[];
  incomingOffers: TradeOffer[];
  outgoingOffers: TradeOffer[];
  publicOrders: MarketOrder[];
  publicAnnouncements: MarketEvent[];
  privateWhispers: MarketEvent[];
  publicTradeEvents: MarketEvent[];
  constraints: {
    maxAnnouncementsPerTick: 1;
    maxOffersPerTick: 1;
    maxWhispersPerTargetPerTick: number;
  };
};

export type AppliedTickResult = {
  state: MarketState;
  emittedEvents: MarketEvent[];
};

export function createSeedState(sessionId = randomUUID(), sessionName = buildSessionName()): MarketState {
  return {
    sessionId,
    sessionName,
    round: 1,
    tickCount: 0,
    maxTicks: MAX_TICKS,
    isRunning: false,
    status: "paused",
    turnAgentId: "all-agents",
    doneAgentIds: [],
    items: ITEMS,
    agents: structuredClone(SEED_AGENTS),
    initialAgents: structuredClone(SEED_AGENTS),
    offers: [],
    orders: [],
    events: [
      {
        id: randomUUID(),
        round: 1,
        type: "system",
        visibility: "public",
        content: "Market opened. Agents post public buy or sell orders, negotiate privately, and valid accepted trades settle immediately.",
        createdAt: new Date().toISOString()
      }
    ]
  };
}

export function findAgentById(state: MarketState, agentId: string) {
  return state.agents.find((agent) => agent.id === agentId);
}

export function getActiveAgentIds(state: MarketState) {
  return state.agents.map((agent) => agent.id);
}

export function computeVisibleStateForAgent(state: MarketState, agentId: string): AgentVisibleState {
  const self = findAgentById(state, agentId);
  const cutoffRound = Math.max(1, state.round - AGENT_CONTEXT_TICK_WINDOW);
  const recentEvents = state.events.filter((event) => event.round >= cutoffRound);

  return {
    round: state.round,
    tickCount: state.tickCount,
    maxTicks: state.maxTicks,
    self: self
      ? {
          id: self.id,
          name: self.name,
          persona: self.persona,
          budget: self.budget,
          inventory: [...self.inventory],
          wishlist: [...self.wishlist],
          valuations: { ...self.valuations },
          doneTrading: state.doneAgentIds.includes(self.id)
        }
      : null,
    publicAgents: state.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      persona: agent.persona,
      doneTrading: state.doneAgentIds.includes(agent.id),
    })),
    items: state.items,
    openOffers: state.offers.filter((offer) => offer.status === "open"),
    incomingOffers: state.offers.filter((offer) => offer.status === "open" && offer.toAgentId === agentId),
    outgoingOffers: state.offers.filter((offer) => offer.status === "open" && offer.fromAgentId === agentId),
    publicOrders: state.orders.filter((o) => o.status === "open"),
    publicAnnouncements: recentEvents.filter((event) => event.type === "announce").slice(0, 40),
    privateWhispers: recentEvents
      .filter(
        (event) =>
          event.type === "whisper" &&
          (event.actorAgentId === agentId || event.targetAgentId === agentId)
      )
      .slice(0, 80),
    publicTradeEvents: recentEvents
      .filter((event) => event.visibility === "public" && (event.type === "offer" || event.type === "trade"))
      .slice(0, 80),
    constraints: {
      maxAnnouncementsPerTick: 1,
      maxOffersPerTick: 1,
      maxWhispersPerTargetPerTick: MAX_WHISPERS_PER_TARGET_PER_TICK
    }
  };
}

export function applyTick(
  state: MarketState,
  plans: AgentTickPlan[],
  traces: Array<{ agentId: string; trace: string }>
): AppliedTickResult {
  const timestamp = new Date().toISOString();
  const nextState = structuredClone(state);
  const emittedEvents: MarketEvent[] = [];
  const planByAgent = new Map(plans.map((plan) => [plan.agentId, normalizePlan(plan)]));
  const openOfferIdsAtTickStart = new Set(
    state.offers.filter((offer) => offer.status === "open").map((offer) => offer.id)
  );

  emittedEvents.push({
    id: randomUUID(),
    round: state.round,
    type: "tick",
    visibility: "public",
    content: `Tick ${state.tickCount + 1} started with ${state.agents.length} agent submissions.`,
    createdAt: timestamp
  });

  nextState.doneAgentIds = state.agents
    .filter((agent) => planByAgent.get(agent.id)?.doneTrading)
    .map((agent) => agent.id);

  for (const agent of state.agents) {
    const plan = planByAgent.get(agent.id);

    if (!plan) {
      emittedEvents.push(createDecisionEvent(state.round, agent.id, "No plan submitted for this tick.", timestamp));
      continue;
    }

    if (plan.announce) {
      emittedEvents.push({
        id: randomUUID(),
        round: state.round,
        type: "announce",
        visibility: "public",
        actorAgentId: agent.id,
        content: `${agent.id} announced: ${plan.announce}`,
        createdAt: timestamp
      });
    }

    const whispersByTarget = new Map<string, number>();
    for (const whisper of plan.whispers) {
      const targetAgent = findAgentById(state, whisper.toAgentId);

      if (!targetAgent || whisper.toAgentId === agent.id) {
        emittedEvents.push(
          createDecisionEvent(state.round, agent.id, `Ignored invalid whisper target ${whisper.toAgentId}.`, timestamp)
        );
        continue;
      }

      const count = (whispersByTarget.get(whisper.toAgentId) ?? 0) + 1;
      whispersByTarget.set(whisper.toAgentId, count);

      if (count > MAX_WHISPERS_PER_TARGET_PER_TICK) {
        emittedEvents.push(
          createDecisionEvent(
            state.round,
            agent.id,
            `Ignored whisper to ${whisper.toAgentId} because the per-target limit was exceeded.`,
            timestamp
          )
        );
        continue;
      }

      emittedEvents.push({
        id: randomUUID(),
        round: state.round,
        type: "whisper",
        visibility: "private",
        actorAgentId: agent.id,
        targetAgentId: whisper.toAgentId,
        content: `${agent.id} whispered to ${whisper.toAgentId}: ${whisper.content}`,
        createdAt: timestamp
      });
    }

    if (plan.offer) {
      const validation = validateNewOffer(state, agent.id, plan.offer);

      if (!validation.ok) {
        emittedEvents.push(createDecisionEvent(state.round, agent.id, `Offer blocked: ${validation.reason}`, timestamp));
      } else {
        const offer: TradeOffer = {
          id: randomUUID(),
          fromAgentId: agent.id,
          toAgentId: plan.offer.toAgentId,
          giveItemIds: [...plan.offer.giveItemIds],
          requestItemIds: [...plan.offer.requestItemIds],
          cashFromProposer: plan.offer.cashFromProposer,
          status: "open",
          message: plan.offer.message,
          createdAt: timestamp
        };

        nextState.offers.unshift(offer);
        emittedEvents.push({
          id: randomUUID(),
          round: state.round,
          type: "offer",
          visibility: "public",
          actorAgentId: agent.id,
          targetAgentId: plan.offer.toAgentId,
          content: formatOfferContent(offer),
          createdAt: timestamp
        });
      }
    }
  }

  for (const agent of state.agents) {
    const plan = planByAgent.get(agent.id);

    if (!plan) {
      continue;
    }

    const seenOfferIds = new Set<string>();

    for (const response of plan.responses) {
      if (seenOfferIds.has(response.offerId)) {
        continue;
      }
      seenOfferIds.add(response.offerId);

      const offer = nextState.offers.find((candidate) => candidate.id === response.offerId);

      if (!offer || !openOfferIdsAtTickStart.has(response.offerId) || offer.status !== "open") {
        emittedEvents.push(
          createDecisionEvent(state.round, agent.id, `Response ignored for unavailable offer ${response.offerId}.`, timestamp)
        );
        continue;
      }

      if (offer.toAgentId !== agent.id) {
        emittedEvents.push(
          createDecisionEvent(state.round, agent.id, `Response ignored because ${response.offerId} is not addressed to ${agent.id}.`, timestamp)
        );
        continue;
      }

      offer.respondedAt = timestamp;

      if (response.decision === "reject") {
        offer.status = "rejected";
        emittedEvents.push(
          createDecisionEvent(
            state.round,
            agent.id,
            `${agent.id} rejected ${offer.fromAgentId}'s offer: ${response.reason || "No reason provided."}`,
            timestamp
          )
        );
        continue;
      }

      offer.status = "accepted";
      emittedEvents.push(
        createDecisionEvent(
          state.round,
          agent.id,
          `${agent.id} accepted ${offer.fromAgentId}'s offer and queued it for settlement.`,
          timestamp
        )
      );
    }
  }

  const acceptedOffers = nextState.offers
    .filter((offer) => offer.status === "accepted")
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

  for (const offer of acceptedOffers) {
    const validation = validateSettlement(nextState, offer);

    if (!validation.ok) {
      offer.status = "invalid";
      emittedEvents.push(
        createDecisionEvent(
          state.round,
          offer.fromAgentId,
          `Settlement failed for offer ${offer.id}: ${validation.reason}`,
          timestamp
        )
      );
      continue;
    }

    settleTrade(nextState, offer);
    offer.status = "settled";
    offer.settledAt = timestamp;
    emittedEvents.push({
      id: randomUUID(),
      round: state.round,
      type: "trade",
      visibility: "public",
      actorAgentId: offer.fromAgentId,
      targetAgentId: offer.toAgentId,
      content: `${offer.fromAgentId} and ${offer.toAgentId} settled a trade for ${offer.requestItemIds.join(", ") || "cash-only consideration"}.`,
      createdAt: timestamp
    });
  }

  for (const trace of traces) {
    emittedEvents.push(createDecisionEvent(state.round, trace.agentId, trace.trace, timestamp));
  }

  emittedEvents.push({
    id: randomUUID(),
    round: state.round,
    type: "tick",
    visibility: "public",
    content: `Tick ${state.tickCount + 1} resolved. ${nextState.doneAgentIds.length} agents declared they were done trading.`,
    createdAt: timestamp
  });

  nextState.tickCount = state.tickCount + 1;
  nextState.round = state.round + 1;
  nextState.turnAgentId = "all-agents";
  nextState.events = [...emittedEvents.slice().reverse(), ...state.events].slice(0, 200);

  return {
    state: nextState,
    emittedEvents
  };
}

export function completeSession(state: MarketState, reason: string, timestamp = new Date().toISOString()) {
  const event: MarketEvent = {
    id: randomUUID(),
    round: state.round,
    type: "system",
    visibility: "public",
    content: reason,
    createdAt: timestamp
  };

  return {
    state: {
      ...state,
      isRunning: false,
      status: "completed" as const,
      completionReason: reason,
      events: [event, ...state.events].slice(0, 200)
    },
    event
  };
}

export function isAgentTickPlan(value: unknown, agentId: string): value is AgentTickPlan {
  if (!value || typeof value !== "object") {
    return false;
  }

  const plan = value as Record<string, unknown>;

  if (plan.agentId !== agentId || typeof plan.reasoning !== "string" || typeof plan.doneTrading !== "boolean") {
    return false;
  }

  if (plan.announce !== undefined && typeof plan.announce !== "string") {
    return false;
  }

  if (!Array.isArray(plan.whispers) || !Array.isArray(plan.responses)) {
    return false;
  }

  if (
    !plan.whispers.every(
      (whisper) =>
        whisper &&
        typeof whisper === "object" &&
        typeof (whisper as WhisperIntent).toAgentId === "string" &&
        typeof (whisper as WhisperIntent).content === "string"
    )
  ) {
    return false;
  }

  if (
    !plan.responses.every(
      (response) =>
        response &&
        typeof response === "object" &&
        typeof (response as OfferResponseIntent).offerId === "string" &&
        ((response as OfferResponseIntent).decision === "accept" ||
          (response as OfferResponseIntent).decision === "reject") &&
        typeof (response as OfferResponseIntent).reason === "string"
    )
  ) {
    return false;
  }

  if (plan.offer === undefined || plan.offer === null) {
    return true;
  }

  return (
    typeof plan.offer === "object" &&
    typeof (plan.offer as TradeOfferIntent).toAgentId === "string" &&
    Array.isArray((plan.offer as TradeOfferIntent).giveItemIds) &&
    Array.isArray((plan.offer as TradeOfferIntent).requestItemIds) &&
    typeof (plan.offer as TradeOfferIntent).cashFromProposer === "number" &&
    typeof (plan.offer as TradeOfferIntent).message === "string"
  );
}

function normalizePlan(plan: AgentTickPlan): AgentTickPlan {
  return {
    ...plan,
    announce: plan.announce?.trim() ? plan.announce.trim() : undefined,
    whispers: plan.whispers
      .map((whisper) => ({
        toAgentId: whisper.toAgentId,
        content: whisper.content.trim()
      }))
      .filter((whisper) => whisper.content.length > 0),
    responses: plan.responses.map((response) => ({
      offerId: response.offerId,
      decision: response.decision,
      reason: response.reason.trim()
    })),
    offer: plan.offer
      ? {
          toAgentId: plan.offer.toAgentId,
          giveItemIds: [...plan.offer.giveItemIds],
          requestItemIds: [...plan.offer.requestItemIds],
          cashFromProposer: plan.offer.cashFromProposer,
          message: plan.offer.message.trim()
        }
      : undefined,
    reasoning: plan.reasoning.trim()
  };
}

function createDecisionEvent(round: number, agentId: string, content: string, createdAt: string): MarketEvent {
  return {
    id: randomUUID(),
    round,
    type: "decision",
    visibility: "public",
    actorAgentId: agentId,
    content,
    createdAt
  };
}

function validateNewOffer(state: MarketState, agentId: string, offer: TradeOfferIntent) {
  const proposer = findAgentById(state, agentId);
  const target = findAgentById(state, offer.toAgentId);

  if (!proposer || !target) {
    return { ok: false, reason: "Unknown proposer or target." };
  }

  if (agentId === offer.toAgentId) {
    return { ok: false, reason: "Agents cannot offer trades to themselves." };
  }

  if (offer.cashFromProposer >= 0 && proposer.budget < offer.cashFromProposer) {
    return { ok: false, reason: "Cash offer exceeds budget." };
  }

  if (offer.cashFromProposer < 0 && target.budget < Math.abs(offer.cashFromProposer)) {
    return { ok: false, reason: "Requested cash exceeds the responder budget." };
  }

  if (!offer.giveItemIds.every((itemId) => proposer.inventory.includes(itemId))) {
    return { ok: false, reason: "Proposer tried to offer an item they do not own." };
  }

  return { ok: true };
}

function validateSettlement(state: MarketState, offer: TradeOffer) {
  const proposer = findAgentById(state, offer.fromAgentId);
  const responder = findAgentById(state, offer.toAgentId);

  if (!proposer || !responder) {
    return { ok: false, reason: "One party is missing." };
  }

  if (!offer.giveItemIds.every((itemId) => proposer.inventory.includes(itemId))) {
    return { ok: false, reason: "Proposer no longer owns offered items." };
  }

  if (!offer.requestItemIds.every((itemId) => responder.inventory.includes(itemId))) {
    return { ok: false, reason: "Responder no longer owns requested items." };
  }

  if (offer.cashFromProposer >= 0 && proposer.budget < offer.cashFromProposer) {
    return { ok: false, reason: "Proposer cannot cover the cash portion." };
  }

  if (offer.cashFromProposer < 0 && responder.budget < Math.abs(offer.cashFromProposer)) {
    return { ok: false, reason: "Responder cannot cover the cash portion." };
  }

  return { ok: true };
}

function settleTrade(state: MarketState, offer: TradeOffer) {
  const proposer = findAgentById(state, offer.fromAgentId);
  const responder = findAgentById(state, offer.toAgentId);

  if (!proposer || !responder) {
    return;
  }

  proposer.inventory = proposer.inventory.filter((itemId) => !offer.giveItemIds.includes(itemId));
  responder.inventory = responder.inventory.filter((itemId) => !offer.requestItemIds.includes(itemId));
  proposer.inventory.push(...offer.requestItemIds);
  responder.inventory.push(...offer.giveItemIds);
  proposer.budget -= offer.cashFromProposer;
  responder.budget += offer.cashFromProposer;
}

function formatOfferContent(offer: TradeOffer) {
  const itemLeg = offer.giveItemIds.join(", ") || "nothing";
  const requestLeg = offer.requestItemIds.join(", ") || "nothing";

  if (offer.cashFromProposer === 0) {
    return `${offer.fromAgentId} offered ${itemLeg} and no cash to ${offer.toAgentId} for ${requestLeg}.`;
  }

  if (offer.cashFromProposer > 0) {
    return `${offer.fromAgentId} offered ${itemLeg} and $${offer.cashFromProposer} to ${offer.toAgentId} for ${requestLeg}.`;
  }

  return `${offer.fromAgentId} offered ${itemLeg} to ${offer.toAgentId} for ${requestLeg}, and asked ${offer.toAgentId} to pay $${Math.abs(offer.cashFromProposer)}.`;
}

function buildSessionName() {
  return `Session ${new Date().toISOString().replace("T", " ").slice(0, 19)}`;
}
