import { randomUUID } from "node:crypto";
import type {
  AgentProfile,
  Item,
  MarketEvent,
  MarketState,
  SimulationAction,
  TradeOffer
} from "@agents-marketplace/shared";

export type { AgentProfile, Item, MarketEvent, MarketState, SimulationAction, TradeOffer };

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

export function createSeedState(): MarketState {
  return {
    round: 1,
    isRunning: false,
    turnAgentId: SEED_AGENTS[0].id,
    items: ITEMS,
    agents: structuredClone(SEED_AGENTS),
    offers: [],
    events: [
      {
        id: randomUUID(),
        round: 1,
        type: "system",
        visibility: "public",
        content: "Market opened. Agents may bluff in messages, but all settlements are deterministic.",
        createdAt: new Date().toISOString()
      }
    ]
  };
}

export function findAgentById(state: MarketState, agentId: string) {
  return state.agents.find((agent) => agent.id === agentId);
}

export function getNextAgentId(state: MarketState) {
  if (state.agents.length === 0) {
    return null;
  }

  if (state.agents.some((agent) => agent.id === state.turnAgentId)) {
    return state.turnAgentId;
  }

  return state.agents[0].id;
}

export function canAgentAffordCash(state: MarketState, agentId: string, amount: number) {
  const agent = findAgentById(state, agentId);
  return !!agent && amount >= 0 && agent.budget >= amount;
}

export function computeVisibleStateForAgent(state: MarketState, agentId: string) {
  const self = findAgentById(state, agentId);

  return {
    round: state.round,
    turnAgentId: state.turnAgentId,
    self,
    publicAgents: state.agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      persona: agent.persona,
      budget: agent.budget,
      inventoryCount: agent.inventory.length
    })),
    items: state.items,
    openOffers: state.offers.filter(
      (offer) => offer.status === "open" && (offer.fromAgentId === agentId || offer.toAgentId === agentId)
    ),
    publicEvents: state.events.filter((event) => event.visibility === "public").slice(0, 20),
    privateEvents: state.events
      .filter(
        (event) =>
          event.visibility === "private" &&
          (event.actorAgentId === agentId || event.targetAgentId === agentId)
      )
      .slice(0, 20)
  };
}

export function chooseFallbackAction(state: MarketState, agentId: string): SimulationAction {
  const agent = findAgentById(state, agentId);

  if (!agent) {
    return { type: "pass", agentId, reasoning: "Agent unavailable." };
  }

  const incomingOffer = state.offers.find(
    (offer) => offer.status === "open" && offer.toAgentId === agentId && evaluateOfferForTarget(state, offer) >= 8
  );

  if (incomingOffer) {
    return { type: "accept_trade", agentId, offerId: incomingOffer.id };
  }

  const desiredItems = agent.wishlist.filter((itemId) => !agent.inventory.includes(itemId));

  for (const targetItemId of desiredItems) {
    const owner = state.agents.find((candidate) => candidate.id !== agentId && candidate.inventory.includes(targetItemId));

    if (!owner) {
      continue;
    }

    const giveItemId = [...agent.inventory].sort((left, right) => agent.valuations[left] - agent.valuations[right])[0];
    const perceivedGain = agent.valuations[targetItemId] ?? 0;
    const perceivedLoss = giveItemId ? agent.valuations[giveItemId] ?? 0 : 0;
    const cashFromProposer = Math.max(0, Math.min(agent.budget, Math.round((perceivedGain - perceivedLoss) * 0.35)));

    return {
      type: "propose_trade",
      agentId,
      toAgentId: owner.id,
      giveItemIds: giveItemId ? [giveItemId] : [],
      requestItemIds: [targetItemId],
      cashFromProposer,
      message: "You know this helps your liquidity. Let's move quickly."
    };
  }

  const rival = state.agents.find((candidate) => candidate.id !== agentId);
  if (rival) {
    return {
      type: "whisper",
      agentId,
      toAgentId: rival.id,
      content: "A larger offer is already on the table. Decide whether you want to beat it."
    };
  }

  return {
    type: "announce",
    agentId,
    content: "The market is drifting. I'm open to creative offers."
  };
}

export function applyAction(state: MarketState, action: SimulationAction, trace: string) {
  const timestamp = new Date().toISOString();
  const nextState = structuredClone(state);
  const events = [...state.events];

  switch (action.type) {
    case "announce":
      events.unshift({
        id: randomUUID(),
        round: state.round,
        type: "announce",
        visibility: "public",
        actorAgentId: action.agentId,
        content: `${action.agentId} announced: ${action.content}`,
        createdAt: timestamp
      });
      break;
    case "whisper":
      events.unshift({
        id: randomUUID(),
        round: state.round,
        type: "whisper",
        visibility: "private",
        actorAgentId: action.agentId,
        targetAgentId: action.toAgentId,
        content: `${action.agentId} whispered to ${action.toAgentId}: ${action.content}`,
        createdAt: timestamp
      });
      break;
    case "propose_trade": {
      const validation = validateOffer(state, action);

      if (!validation.ok) {
        events.unshift(createDecisionEvent(state.round, action.agentId, `Offer blocked: ${validation.reason}`, timestamp));
        break;
      }

      nextState.offers.unshift({
        id: randomUUID(),
        fromAgentId: action.agentId,
        toAgentId: action.toAgentId,
        giveItemIds: action.giveItemIds,
        requestItemIds: action.requestItemIds,
        cashFromProposer: action.cashFromProposer,
        status: "open",
        message: action.message,
        createdAt: timestamp
      });

      events.unshift({
        id: randomUUID(),
        round: state.round,
        type: "offer",
        visibility: "public",
        actorAgentId: action.agentId,
        targetAgentId: action.toAgentId,
        content: `${action.agentId} offered ${action.giveItemIds.join(", ") || "nothing"} and $${action.cashFromProposer} to ${action.toAgentId} for ${action.requestItemIds.join(", ")}.`,
        createdAt: timestamp
      });
      break;
    }
    case "accept_trade": {
      const offer = nextState.offers.find((candidate) => candidate.id === action.offerId);

      if (!offer || offer.status !== "open" || offer.toAgentId !== action.agentId) {
        events.unshift(createDecisionEvent(state.round, action.agentId, `Acceptance blocked for ${action.offerId}.`, timestamp));
        break;
      }

      const validation = validateAccept(nextState, offer);
      if (!validation.ok) {
        offer.status = "rejected";
        events.unshift(createDecisionEvent(state.round, action.agentId, `Acceptance failed: ${validation.reason}`, timestamp));
        break;
      }

      settleTrade(nextState, offer);
      offer.status = "accepted";
      events.unshift({
        id: randomUUID(),
        round: state.round,
        type: "trade",
        visibility: "public",
        actorAgentId: offer.fromAgentId,
        targetAgentId: offer.toAgentId,
        content: `${offer.toAgentId} accepted ${offer.fromAgentId}'s offer for ${offer.requestItemIds.join(", ")}.`,
        createdAt: timestamp
      });
      break;
    }
    case "reject_trade": {
      const offer = nextState.offers.find((candidate) => candidate.id === action.offerId);

      if (!offer || offer.status !== "open" || offer.toAgentId !== action.agentId) {
        events.unshift(createDecisionEvent(state.round, action.agentId, `Rejection ignored for ${action.offerId}.`, timestamp));
        break;
      }

      offer.status = "rejected";
      events.unshift(
        createDecisionEvent(
          state.round,
          action.agentId,
          `${action.agentId} rejected ${offer.fromAgentId}'s offer: ${action.reason}`,
          timestamp
        )
      );
      break;
    }
    case "pass":
      events.unshift(createDecisionEvent(state.round, action.agentId, `${action.agentId} passed: ${action.reasoning}`, timestamp));
      break;
  }

  events.unshift(createDecisionEvent(state.round, action.agentId, trace, timestamp));
  nextState.events = events.slice(0, 200);

  const currentIndex = state.agents.findIndex((agent) => agent.id === state.turnAgentId);
  const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % state.agents.length;
  nextState.turnAgentId = state.agents[nextIndex]?.id ?? state.turnAgentId;
  nextState.round = nextState.turnAgentId === state.agents[0]?.id ? state.round + 1 : state.round;

  return nextState;
}

export function isAgentAction(value: unknown, agentId: string): value is SimulationAction {
  if (!value || typeof value !== "object") {
    return false;
  }

  const action = value as Record<string, unknown>;
  if (action.agentId !== agentId || typeof action.type !== "string") {
    return false;
  }

  switch (action.type) {
    case "announce":
      return typeof action.content === "string";
    case "whisper":
      return typeof action.toAgentId === "string" && typeof action.content === "string";
    case "propose_trade":
      return (
        typeof action.toAgentId === "string" &&
        Array.isArray(action.giveItemIds) &&
        Array.isArray(action.requestItemIds) &&
        typeof action.cashFromProposer === "number" &&
        typeof action.message === "string"
      );
    case "accept_trade":
      return typeof action.offerId === "string";
    case "reject_trade":
      return typeof action.offerId === "string" && typeof action.reason === "string";
    case "pass":
      return typeof action.reasoning === "string";
    default:
      return false;
  }
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

function validateOffer(state: MarketState, action: Extract<SimulationAction, { type: "propose_trade" }>) {
  const proposer = findAgentById(state, action.agentId);
  const target = findAgentById(state, action.toAgentId);

  if (!proposer || !target) {
    return { ok: false, reason: "Unknown proposer or target." };
  }
  if (action.cashFromProposer < 0 || proposer.budget < action.cashFromProposer) {
    return { ok: false, reason: "Cash offer exceeds budget." };
  }
  if (!action.giveItemIds.every((itemId) => proposer.inventory.includes(itemId))) {
    return { ok: false, reason: "Proposer tried to offer an item they do not own." };
  }
  if (!action.requestItemIds.every((itemId) => target.inventory.includes(itemId))) {
    return { ok: false, reason: "Requested item is not owned by the target." };
  }

  return { ok: true };
}

function validateAccept(state: MarketState, offer: TradeOffer) {
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
  if (proposer.budget < offer.cashFromProposer) {
    return { ok: false, reason: "Proposer can no longer cover cash portion." };
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

function evaluateOfferForTarget(state: MarketState, offer: TradeOffer) {
  const target = findAgentById(state, offer.toAgentId);
  if (!target) {
    return -Infinity;
  }

  const gainedValue = offer.giveItemIds.reduce((sum, itemId) => sum + scoreItem(target, itemId), 0);
  const lostValue = offer.requestItemIds.reduce((sum, itemId) => sum + scoreItem(target, itemId), 0);
  return gainedValue + offer.cashFromProposer - lostValue;
}

function scoreItem(agent: AgentProfile, itemId: string) {
  const base = agent.valuations[itemId] ?? 0;
  const wishlistIndex = agent.wishlist.indexOf(itemId);
  return base + (wishlistIndex === -1 ? 0 : (agent.wishlist.length - wishlistIndex) * 8);
}
