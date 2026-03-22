import { computeVisibleStateForAgent, findAgentById, type AgentVisibleState, type MarketState } from "@agents-marketplace/engine";
import type { MarketOrder, TradeOffer } from "@agents-marketplace/shared";

type RuntimeConfig = {
  agentRuntimeMode: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  agentToolBudget: number;
};

type StreamCallbacks = {
  onStart?: (systemPrompt: string, userPrompt: string) => void;
  onToken?: (chunk: string, aggregate: string) => void;
  onComplete?: (aggregate: string) => void;
  onError?: (message: string) => void;
};

type SelfContext = {
  id: string;
  name: string;
  persona: string;
  budget: number;
  inventory: string[];
  wishlist: string[];
  valuations: Record<string, number>;
};

type OtherAgentContext = {
  id: string;
  name: string;
};

type ItemContext = {
  id: string;
  name: string;
};

type OutgoingOfferSummary = {
  offerId: string;
  toAgentId: string;
  giveItemIds: string[];
  requestItemIds: string[];
  cashFromProposer: number;
  message: string;
};


type OfferGuidance = {
  canAcceptNow: boolean;
  missingItems: string[];
  cashDeltaToMe: number;
  canCoverCash: boolean;
  valueIReceive: number;
  valueIGive: number;
  netValue: number;
  blockers: string[];
};

type IncomingOfferSummary = {
  offerId: string;
  fromAgentId: string;
  giveItemIds: string[];
  requestItemIds: string[];
  cashFromProposer: number;
  message: string;
  guidance: OfferGuidance;
};

type CompactContext = {
  self: SelfContext | null;
  otherAgents: OtherAgentContext[];
  items: ItemContext[];
  publicOrders: MarketOrder[];
  myPendingOffers: OutgoingOfferSummary[];
  incomingOffers: IncomingOfferSummary[];
  recentTrades: string[];
};

type ToolRequest =
  | { tool: "check_sell_orders"; itemId?: string }
  | { tool: "check_buy_orders"; itemId?: string }
  | { tool: "check_price_history"; itemId: string }
  | { tool: "post_sell_order"; itemId: string; price: number }
  | { tool: "post_buy_order"; itemId: string; price: number }
  | { tool: "make_offer"; targetAgentId: string; giveItemIds: string[]; requestItemIds: string[]; cashFromProposer: number; message: string }
  | { tool: "respond_to_offer"; offerId: string; decision: "accept" | "reject" | "counter"; reason?: string; giveItemIds?: string[]; requestItemIds?: string[]; cashFromProposer?: number; message?: string }
  | { tool: "pass" };


type CounterOfferPayload = {
  giveItemIds: string[];
  requestItemIds: string[];
  cashFromProposer: number;
  message: string;
};

export type PostedOrder = { type: "buy" | "sell"; itemId: string; price: number };

export type OfferAction = {
  targetAgentId: string;
  giveItemIds: string[];
  requestItemIds: string[];
  cashFromProposer: number;
  message: string;
};

export type OfferResponseAction =
  | { offerId: string; kind: "accept" }
  | { offerId: string; kind: "reject"; reason: string }
  | { offerId: string; kind: "counter"; counter: CounterOfferPayload };

export type ActiveActionResult = {
  trace: string;
  postedOrders: PostedOrder[];
  offers: OfferAction[];
  offerResponses: OfferResponseAction[];
};

export class AgentRuntime {
  constructor(private readonly runtimeConfig: RuntimeConfig) {}

  async warmModel() {
    if (this.runtimeConfig.agentRuntimeMode !== "ollama") {
      return `Model warm-up skipped because runtime mode is ${this.runtimeConfig.agentRuntimeMode}.`;
    }

    const response = await fetch(`${this.runtimeConfig.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.runtimeConfig.ollamaModel,
        messages: [],
        stream: false
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama warm-up failed with ${response.status}`);
    }

    return `Warm-loaded ${this.runtimeConfig.ollamaModel} via Ollama.`;
  }

  async generateActiveAction(state: MarketState, agentId: string, callbacks?: StreamCallbacks): Promise<ActiveActionResult> {
    if (this.runtimeConfig.agentRuntimeMode !== "ollama") {
      return { trace: `Active action skipped because runtime mode is ${this.runtimeConfig.agentRuntimeMode}.`, postedOrders: [], offers: [], offerResponses: [] };
    }

    const agent = findAgentById(state, agentId);
    if (!agent) {
      return { trace: "Agent missing from state.", postedOrders: [], offers: [], offerResponses: [] };
    }

    const visibleState = computeVisibleStateForAgent(state, agentId);
    const compact = buildCompactContext(visibleState);

    try {
      return await this.runToolChain(agentId, compact, callbacks);
    } catch (error) {
      callbacks?.onError?.(toMessage(error));
      return { trace: `Active action failed: ${toMessage(error)}`, postedOrders: [], offers: [], offerResponses: [] };
    }
  }

  // ---------------------------------------------------------------------------
  // Prompt chain — the agent calls tools until it passes or exhausts budget
  // ---------------------------------------------------------------------------

  private async runToolChain(
    agentId: string,
    compact: CompactContext,
    callbacks?: StreamCallbacks
  ): Promise<ActiveActionResult> {
    const postedOrders: PostedOrder[] = [];
    const offers: OfferAction[] = [];
    const offerResponses: OfferResponseAction[] = [];
    const systemPrompt = buildSystemPrompt();
    const initialPrompt = buildActiveActionPrompt(agentId, compact, this.runtimeConfig.agentToolBudget);

    callbacks?.onStart?.(systemPrompt, initialPrompt);

    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
      { role: "user", content: initialPrompt },
    ];

    let fullStreamContent = "";
    const budget = this.runtimeConfig.agentToolBudget;

    for (let step = 0; step <= budget; step++) {
      const toolsRemaining = budget - step;

      const stepResponse = await this.streamMessages(messages, {
        format: buildToolSchema(),
        temperature: 0.1,
        onToken: (chunk) => {
          fullStreamContent += chunk;
          callbacks?.onToken?.(chunk, fullStreamContent);
        },
      });

      const toolRequest = parseToolRequest(stepResponse);
      if (!toolRequest) {
        // Unparseable — treat as pass
        callbacks?.onComplete?.(fullStreamContent);
        return { trace: "Active action: could not parse; defaulting to pass.", postedOrders, offers, offerResponses };
      }

      // Terminal tools — end the turn
      if (toolRequest.tool === "pass") {
        callbacks?.onComplete?.(fullStreamContent);
        return { trace: "Active action: pass.", postedOrders, offers, offerResponses };
      }

      if (toolRequest.tool === "make_offer") {
        const { targetAgentId, giveItemIds, requestItemIds, cashFromProposer, message } = toolRequest;
        offers.push({ targetAgentId, giveItemIds, requestItemIds, cashFromProposer, message });
        const toolResult = `Tool result: make_offer\nOffer sent to ${targetAgentId}: give [${giveItemIds.join(", ")}] for [${requestItemIds.join(", ")}].`;
        messages.push({ role: "assistant", content: stepResponse });
        messages.push({ role: "user", content: toolResult });
        const sep = `\n\n${toolResult}\n\n`;
        fullStreamContent += sep;
        callbacks?.onToken?.(sep, fullStreamContent);
        // After making an offer, continue — agent can still use remaining tools
        continue;
      }

      if (toolRequest.tool === "respond_to_offer") {
        const result = executeRespondToOffer(compact, toolRequest, offerResponses);
        messages.push({ role: "assistant", content: stepResponse });
        messages.push({ role: "user", content: result });
        const sep = `\n\n${result}\n\n`;
        fullStreamContent += sep;
        callbacks?.onToken?.(sep, fullStreamContent);
        continue;
      }

      // Information/order tools
      const toolResult = executeToolRequest(compact, toolRequest, postedOrders);

      messages.push({ role: "assistant", content: stepResponse });

      const nextRemaining = toolsRemaining - 1;
      const nudge = nextRemaining <= 0
        ? "No more tool calls available. Your turn ends now."
        : `${nextRemaining} tool call${nextRemaining === 1 ? "" : "s"} remaining.`;

      messages.push({ role: "user", content: `${toolResult}\n\n${nudge}` });

      const separator = `\n\n${toolResult}\n\n`;
      fullStreamContent += separator;
      callbacks?.onToken?.(separator, fullStreamContent);
    }

    // Budget exhausted — implicit pass
    callbacks?.onComplete?.(fullStreamContent);
    return { trace: "Active action: budget exhausted, implicit pass.", postedOrders, offers, offerResponses };
  }


  private async streamMessages(
    messages: Array<{ role: string; content: string }>,
    options: {
      format?: "json" | Record<string, unknown>;
      temperature?: number;
      onToken?: (chunk: string) => void;
    }
  ): Promise<string> {
    const response = await fetch(`${this.runtimeConfig.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.runtimeConfig.ollamaModel,
        stream: true,
        keep_alive: "30m",
        format: options.format,
        messages,
        options: { temperature: options.temperature ?? 0.9 },
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}`);
    }

    if (!response.body) {
      throw new Error("Ollama returned no response body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let stepContent = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const payload = JSON.parse(trimmed) as {
          message?: { content?: string };
          error?: string;
        };

        if (payload.error) throw new Error(payload.error);

        const chunk = payload.message?.content ?? "";
        if (chunk) {
          stepContent += chunk;
          options.onToken?.(chunk);
        }
      }
    }

    return stepContent;
  }
}

// =============================================================================
// System prompts
// =============================================================================

function buildSystemPrompt() {
  return [
    "You are a trading agent in a marketplace simulation.",
    "On your turn, use tools FIRST to gather market information, then choose a final action.",
    "Return exactly one JSON object — no prose, no markdown fences, no extra text.",
    "The \"message\" field is public — write it in your character's voice, at least one sentence.",
    "Keep valuations and budget secret in messages. Stay in character."
  ].join(" ");
}


// =============================================================================
// Context building
// =============================================================================

function buildCompactContext(visibleState: AgentVisibleState): CompactContext {
  const selfAgent = visibleState.self;
  const self = selfAgent
    ? {
        id: selfAgent.id,
        name: selfAgent.name,
        persona: selfAgent.persona,
        budget: selfAgent.budget,
        inventory: [...selfAgent.inventory],
        wishlist: [...selfAgent.wishlist],
        valuations: { ...selfAgent.valuations },
      }
    : null;

  const incomingOffers: IncomingOfferSummary[] = visibleState.incomingOffers.map((offer) => {
    const guidance = buildOfferGuidance({ self } as CompactContext, {
      fromAgentId: offer.fromAgentId,
      giveItemIds: offer.giveItemIds,
      requestItemIds: offer.requestItemIds,
      cashFromProposer: offer.cashFromProposer,
    });
    return {
      offerId: offer.id,
      fromAgentId: offer.fromAgentId,
      giveItemIds: [...offer.giveItemIds],
      requestItemIds: [...offer.requestItemIds],
      cashFromProposer: offer.cashFromProposer,
      message: offer.message,
      guidance,
    };
  });

  return {
    self,
    otherAgents: visibleState.publicAgents
      .filter((agent) => agent.id !== selfAgent?.id)
      .map((agent) => ({ id: agent.id, name: agent.name })),
    items: visibleState.items.map((item) => ({ id: item.id, name: item.name })),
    publicOrders: visibleState.publicOrders,
    myPendingOffers: visibleState.outgoingOffers.map((offer) => ({
      offerId: offer.id,
      toAgentId: offer.toAgentId,
      giveItemIds: offer.giveItemIds,
      requestItemIds: offer.requestItemIds,
      cashFromProposer: offer.cashFromProposer,
      message: offer.message,
    })),
    incomingOffers,
    recentTrades: visibleState.publicTradeEvents.slice(0, 6).map((event) => event.content),
  };
}

// =============================================================================
// Suggestions — private strategic hints computed for the agent
// =============================================================================

type Suggestion = { action: string; detail: string };

function computeSuggestions(compact: CompactContext): {
  sellSuggestions: Suggestion[];
  buySuggestions: Suggestion[];
  orderMatches: Suggestion[];
} {
  const self = compact.self;
  if (!self) return { sellSuggestions: [], buySuggestions: [], orderMatches: [] };

  const inventorySet = new Set(self.inventory);
  const wishlistSet = new Set(self.wishlist);
  const sellSuggestions: Suggestion[] = [];
  const buySuggestions: Suggestion[] = [];
  const orderMatches: Suggestion[] = [];

  // Sell suggestions: items you own but don't need
  for (const itemId of self.inventory) {
    if (!wishlistSet.has(itemId)) {
      const val = self.valuations[itemId] ?? 0;
      const minPrice = val + Math.max(1, Math.round(val * 0.15));
      sellSuggestions.push({
        action: `post_sell_order for ${itemId} at $${minPrice} or higher`,
        detail: `your valuation: $${val} — any price above that is profit`,
      });
    }
  }

  // Buy suggestions: items you want but don't have
  for (const itemId of self.wishlist) {
    if (!inventorySet.has(itemId)) {
      const val = self.valuations[itemId] ?? 0;
      const maxPrice = val - Math.max(1, Math.round(val * 0.15));
      buySuggestions.push({
        action: `post_buy_order for ${itemId} at $${maxPrice} or lower`,
        detail: `your valuation: $${val} — any price below that is a deal`,
      });
    }
  }

  // Order book matches — actionable opportunities from existing orders
  for (const order of compact.publicOrders) {
    if (order.agentId === self.id) continue;

    if (order.type === "sell") {
      const myVal = self.valuations[order.itemId] ?? 0;
      if (myVal > order.price && wishlistSet.has(order.itemId) && !inventorySet.has(order.itemId)) {
        orderMatches.push({
          action: `buy ${order.itemId} from ${order.agentId} at $${order.price}`,
          detail: `you value it at $${myVal} — profit: +$${myVal - order.price}`,
        });
      }
    }

    if (order.type === "buy") {
      const myVal = self.valuations[order.itemId] ?? 0;
      if (order.price > myVal && inventorySet.has(order.itemId) && !wishlistSet.has(order.itemId)) {
        orderMatches.push({
          action: `sell ${order.itemId} to ${order.agentId} at $${order.price}`,
          detail: `you value it at $${myVal} — profit: +$${order.price - myVal}`,
        });
      }
    }
  }

  return { sellSuggestions, buySuggestions, orderMatches };
}

// =============================================================================
// Offer guidance
// =============================================================================

function buildOfferGuidance(
  compact: CompactContext,
  offer: {
    fromAgentId: string;
    giveItemIds: string[];
    requestItemIds: string[];
    cashFromProposer: number;
  }
): OfferGuidance {
  const self = compact.self;

  if (!self) {
    return {
      canAcceptNow: false,
      missingItems: offer.requestItemIds,
      cashDeltaToMe: offer.cashFromProposer,
      canCoverCash: false,
      valueIReceive: 0,
      valueIGive: 0,
      netValue: 0,
      blockers: ["Agent missing from context."]
    };
  }

  const inventorySet = new Set(self.inventory);
  const missingItems = offer.requestItemIds.filter((id) => !inventorySet.has(id));
  const cashDeltaToMe = offer.cashFromProposer;
  const canCoverCash = cashDeltaToMe >= 0 || self.budget >= Math.abs(cashDeltaToMe);
  const valueIReceive = offer.giveItemIds.reduce((sum, id) => sum + (self.valuations[id] ?? 0), 0) + cashDeltaToMe;
  const valueIGive = offer.requestItemIds.reduce((sum, id) => sum + (self.valuations[id] ?? 0), 0);
  const blockers: string[] = [];

  if (missingItems.length > 0) {
    blockers.push(`You do not own: ${missingItems.join(", ")}.`);
  }

  if (!canCoverCash) {
    blockers.push(`You cannot cover the cash movement of $${Math.abs(cashDeltaToMe)}.`);
  }

  return {
    canAcceptNow: blockers.length === 0,
    missingItems,
    cashDeltaToMe,
    canCoverCash,
    valueIReceive,
    valueIGive,
    netValue: valueIReceive - valueIGive,
    blockers
  };
}

// =============================================================================
// Prompts
// =============================================================================

function buildActiveActionPrompt(
  agentId: string,
  compact: CompactContext,
  toolBudget: number
) {
  const self = compact.self;
  const { sellSuggestions, buySuggestions, orderMatches } = computeSuggestions(compact);
  const sections: string[] = [];

  // --- Identity ---
  sections.push([
    "=== YOU ===",
    `Agent: ${self?.name ?? agentId} (${agentId})`,
    `Persona: ${self?.persona ?? ""}`,
    `Budget: $${self?.budget ?? 0}`,
    `You own: ${self ? self.inventory.map((id) => `${id} ($${self.valuations[id] ?? 0})`).join(", ") || "nothing" : "nothing"}`,
    `You want: ${self ? self.wishlist.map((id) => `${id} ($${self.valuations[id] ?? 0})`).join(", ") || "nothing" : "nothing"}`,
  ].join("\n"));

  // --- Other agents directory ---
  const otherAgentIds = compact.otherAgents.map((a) => a.id);
  sections.push([
    "=== OTHER AGENTS IN THE MARKET ===",
    "These are the ONLY agents you can trade with. Use their exact ID.",
    ...compact.otherAgents.map((a) => `  • ${a.id} (${a.name})`),
  ].join("\n"));

  // --- Incoming offers ---
  if (compact.incomingOffers.length > 0) {
    const offerLines: string[] = ["=== INCOMING OFFERS (you can respond to these) ==="];
    for (const o of compact.incomingOffers) {
      const g = o.guidance;
      const cashDesc = o.cashFromProposer === 0
        ? ""
        : o.cashFromProposer > 0
          ? ` + they pay you $${o.cashFromProposer}`
          : ` + you pay $${Math.abs(o.cashFromProposer)}`;
      offerLines.push(
        `  Offer ${o.offerId} from ${o.fromAgentId}:`,
        `    They give: [${o.giveItemIds.join(", ")}]  They want: [${o.requestItemIds.join(", ")}]${cashDesc}`,
        `    Net value to you: ${g.netValue >= 0 ? "+" : ""}$${g.netValue}` +
          (g.canAcceptNow ? " (settlement POSSIBLE)" : ` (BLOCKED: ${g.blockers.join("; ")})`)
      );
      if (o.message) offerLines.push(`    Message: "${o.message}"`);
    }
    offerLines.push("  Use respond_to_offer tool with the offerId to accept, reject, or counter.");
    sections.push(offerLines.join("\n"));
  }

  // --- Suggestions ---
  const sugParts: string[] = ["=== STRATEGY SUGGESTIONS (private to you) ==="];
  if (sellSuggestions.length > 0) {
    sugParts.push("Sell opportunities:");
    for (const s of sellSuggestions) sugParts.push(`  • ${s.action} — ${s.detail}`);
  }
  if (buySuggestions.length > 0) {
    sugParts.push("Buy opportunities:");
    for (const s of buySuggestions) sugParts.push(`  • ${s.action} — ${s.detail}`);
  }
  if (orderMatches.length > 0) {
    sugParts.push("Order book matches:");
    for (const s of orderMatches) sugParts.push(`  ★ ${s.action} — ${s.detail}`);
  }
  if (sellSuggestions.length + buySuggestions.length + orderMatches.length === 0) {
    sugParts.push("No immediate opportunities found. Use tools to browse the market.");
  }
  sections.push(sugParts.join("\n"));

  // --- Pending offers ---
  sections.push([
    "=== YOUR OPEN OFFERS (do NOT duplicate these) ===",
    compact.myPendingOffers.length === 0
      ? "None."
      : compact.myPendingOffers.map((o) =>
          `To ${o.toAgentId}: give [${o.giveItemIds.join(", ")}] for [${o.requestItemIds.join(", ") || "nothing"}]`
        ).join("\n"),
  ].join("\n"));

  if (compact.recentTrades.length > 0) {
    sections.push(["=== RECENT ACTIVITY ===", ...compact.recentTrades].join("\n"));
  }

  // --- Unified tool list ---
  const exampleItemOwned = self?.inventory[0] ?? "item";
  const exampleItemWanted = self?.wishlist[0] ?? "item";
  const exampleTarget = otherAgentIds[0] ?? "agent-id";

  const toolLines: string[] = [
    `=== TOOLS (${toolBudget} calls this turn) ===`,
    "Each response must be ONE JSON tool call. Results come back before your next call.",
    "",
    "Market information:",
    `  {"tool":"check_sell_orders"}`,
    `  {"tool":"check_buy_orders","itemId":"${exampleItemWanted}"}`,
    `  {"tool":"check_price_history","itemId":"${exampleItemWanted}"}`,
    "",
    "Post public orders:",
    `  {"tool":"post_sell_order","itemId":"${exampleItemOwned}","price":20}`,
    `  {"tool":"post_buy_order","itemId":"${exampleItemWanted}","price":15}`,
    "",
    "Private trade offers:",
    `  {"tool":"make_offer","targetAgentId":"${exampleTarget}","giveItemIds":["${exampleItemOwned}"],"requestItemIds":["${exampleItemWanted}"],"cashFromProposer":0,"message":"In character."}`,
  ];

  if (compact.incomingOffers.length > 0) {
    const exOffer = compact.incomingOffers[0];
    toolLines.push(
      "",
      "Respond to incoming offers:",
      `  {"tool":"respond_to_offer","offerId":"${exOffer.offerId}","decision":"accept"}`,
      `  {"tool":"respond_to_offer","offerId":"${exOffer.offerId}","decision":"reject","reason":"short reason"}`,
      `  {"tool":"respond_to_offer","offerId":"${exOffer.offerId}","decision":"counter","giveItemIds":["${exampleItemOwned}"],"requestItemIds":["${exampleItemWanted}"],"cashFromProposer":0,"message":"Counter."}`,
    );
  }

  toolLines.push(
    "",
    "End your turn:",
    `  {"tool":"pass"}`,
    "",
    "RULES:",
    `  • targetAgentId MUST be one of: ${otherAgentIds.join(", ")}`,
    "  • Only GIVE items you own. Only REQUEST items you want.",
    "  • cashFromProposer > 0 means you pay; < 0 means they pay.",
    "  • Gather information before making offers.",
  );
  sections.push(toolLines.join("\n"));

  sections.push(buildIdentityFooter(agentId, compact));

  return sections.join("\n\n");
}

// =============================================================================
// Identity footer
// =============================================================================

function buildIdentityFooter(agentId: string, compact: CompactContext) {
  return [
    `Agent ID: ${agentId}`,
    `Agent Name: ${compact.self?.name ?? agentId}`,
    `Agent Persona: ${compact.self?.persona ?? ""}`,
    "Complete the response as this exact agent, fully embodying your persona."
  ].join("\n");
}

// =============================================================================
// Tool parsing and execution
// =============================================================================

function parseToolRequest(value: string): ToolRequest | null {
  const payload = extractJson(value);
  if (!payload) return null;

  const tool = typeof payload.tool === "string" ? payload.tool : "";

  switch (tool) {
    case "check_sell_orders":
      return { tool: "check_sell_orders", itemId: typeof payload.itemId === "string" ? payload.itemId.trim() : undefined };
    case "check_buy_orders":
      return { tool: "check_buy_orders", itemId: typeof payload.itemId === "string" ? payload.itemId.trim() : undefined };
    case "check_price_history":
      return { tool: "check_price_history", itemId: typeof payload.itemId === "string" ? payload.itemId.trim() : "" };
    case "post_sell_order":
      return {
        tool: "post_sell_order",
        itemId: typeof payload.itemId === "string" ? payload.itemId.trim() : "",
        price: typeof payload.price === "number" ? payload.price : 0,
      };
    case "post_buy_order":
      return {
        tool: "post_buy_order",
        itemId: typeof payload.itemId === "string" ? payload.itemId.trim() : "",
        price: typeof payload.price === "number" ? payload.price : 0,
      };
    case "make_offer": {
      const targetAgentId = typeof payload.targetAgentId === "string" ? payload.targetAgentId.trim() : "";
      const giveItemIds = coerceStringArray(payload.giveItemIds) ?? [];
      const requestItemIds = coerceStringArray(payload.requestItemIds) ?? [];
      const cashFromProposer = coerceNumber(payload.cashFromProposer) ?? 0;
      const message = typeof payload.message === "string" ? payload.message.trim() : "Offer.";
      if (!targetAgentId) return null;
      return { tool: "make_offer", targetAgentId, giveItemIds, requestItemIds, cashFromProposer, message };
    }
    case "respond_to_offer": {
      const offerId = typeof payload.offerId === "string" ? payload.offerId.trim() : "";
      const decision = typeof payload.decision === "string" ? payload.decision.trim() : "";
      if (!offerId || (decision !== "accept" && decision !== "reject" && decision !== "counter")) return null;
      return {
        tool: "respond_to_offer",
        offerId,
        decision: decision as "accept" | "reject" | "counter",
        reason: typeof payload.reason === "string" ? payload.reason.trim() : undefined,
        giveItemIds: coerceStringArray(payload.giveItemIds) ?? undefined,
        requestItemIds: coerceStringArray(payload.requestItemIds) ?? undefined,
        cashFromProposer: coerceNumber(payload.cashFromProposer) ?? undefined,
        message: typeof payload.message === "string" ? payload.message.trim() : undefined,
      };
    }
    case "pass":
      return { tool: "pass" };
    default:
      return null;
  }
}

function executeToolRequest(
  compact: CompactContext,
  request: ToolRequest,
  postedOrders: PostedOrder[]
): string {
  switch (request.tool) {
    case "check_sell_orders": {
      const filter = request.itemId?.toLowerCase();
      const sells = compact.publicOrders.filter(
        (o) => o.type === "sell" && (!filter || o.itemId.toLowerCase().includes(filter))
      );
      if (sells.length === 0) {
        return `Tool result: check_sell_orders\nNo open sell orders${filter ? ` for "${filter}"` : ""}.`;
      }
      return [
        `Tool result: check_sell_orders${filter ? ` ("${filter}")` : ""}`,
        ...sells.map((o) => `SELL ${o.itemId} at $${o.price} by ${o.agentId}`),
      ].join("\n");
    }

    case "check_buy_orders": {
      const filter = request.itemId?.toLowerCase();
      const buys = compact.publicOrders.filter(
        (o) => o.type === "buy" && (!filter || o.itemId.toLowerCase().includes(filter))
      );
      if (buys.length === 0) {
        return `Tool result: check_buy_orders\nNo open buy orders${filter ? ` for "${filter}"` : ""}.`;
      }
      return [
        `Tool result: check_buy_orders${filter ? ` ("${filter}")` : ""}`,
        ...buys.map((o) => `BUY ${o.itemId} at $${o.price} by ${o.agentId}`),
      ].join("\n");
    }

    case "check_price_history": {
      const itemId = request.itemId.toLowerCase();
      if (!itemId) return "Tool result: check_price_history\nError: itemId is required.";
      const matches = compact.recentTrades.filter((text) => text.toLowerCase().includes(itemId));
      if (matches.length === 0) {
        return `Tool result: check_price_history\nNo recent trades involving "${request.itemId}".`;
      }
      return [
        `Tool result: check_price_history ("${request.itemId}")`,
        ...matches.slice(0, 6),
      ].join("\n");
    }

    case "post_sell_order": {
      const { itemId, price } = request;
      if (!itemId) return "Tool result: post_sell_order\nError: itemId is required.";
      if (!compact.self?.inventory.includes(itemId)) {
        return `Tool result: post_sell_order\nError: You do not own ${itemId}. Check your inventory.`;
      }
      if (price <= 0) return "Tool result: post_sell_order\nError: Price must be a positive number.";
      postedOrders.push({ type: "sell", itemId, price });
      return `Tool result: post_sell_order\nSell order posted: offering ${itemId} for $${price}. Other agents can now see this on the order book.`;
    }

    case "post_buy_order": {
      const { itemId, price } = request;
      if (!itemId) return "Tool result: post_buy_order\nError: itemId is required.";
      if (price <= 0) return "Tool result: post_buy_order\nError: Price must be a positive number.";
      if (compact.self && price > compact.self.budget) {
        return `Tool result: post_buy_order\nError: Price $${price} exceeds your budget of $${compact.self.budget}.`;
      }
      postedOrders.push({ type: "buy", itemId, price });
      return `Tool result: post_buy_order\nBuy order posted: requesting ${itemId} for $${price}. Other agents can now see this on the order book.`;
    }

    default:
      return `Tool result: unknown tool.`;
  }
}

function executeRespondToOffer(
  compact: CompactContext,
  request: Extract<ToolRequest, { tool: "respond_to_offer" }>,
  offerResponses: OfferResponseAction[]
): string {
  const offer = compact.incomingOffers.find((o) => o.offerId === request.offerId);
  if (!offer) {
    return `Tool result: respond_to_offer\nError: No incoming offer with id "${request.offerId}".`;
  }

  switch (request.decision) {
    case "accept":
      if (!offer.guidance.canAcceptNow) {
        return `Tool result: respond_to_offer\nError: Cannot accept — ${offer.guidance.blockers.join("; ")}`;
      }
      offerResponses.push({ offerId: request.offerId, kind: "accept" });
      return `Tool result: respond_to_offer\nYou accepted offer ${request.offerId} from ${offer.fromAgentId}.`;

    case "reject":
      offerResponses.push({ offerId: request.offerId, kind: "reject", reason: request.reason ?? "Declined." });
      return `Tool result: respond_to_offer\nYou rejected offer ${request.offerId} from ${offer.fromAgentId}.`;

    case "counter": {
      const giveItemIds = request.giveItemIds ?? [];
      const requestItemIds = request.requestItemIds ?? [];
      const cashFromProposer = request.cashFromProposer ?? 0;
      const message = request.message ?? "Counter offer.";
      offerResponses.push({
        offerId: request.offerId,
        kind: "counter",
        counter: { giveItemIds, requestItemIds, cashFromProposer, message },
      });
      return `Tool result: respond_to_offer\nYou countered offer ${request.offerId}. Give [${giveItemIds.join(", ")}] for [${requestItemIds.join(", ")}].`;
    }
  }
}

// =============================================================================
// JSON schemas
// =============================================================================

function buildToolSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["tool"],
    properties: {
      tool: {
        type: "string",
        enum: [
          "check_sell_orders", "check_buy_orders", "check_price_history",
          "post_sell_order", "post_buy_order",
          "make_offer", "respond_to_offer", "pass"
        ]
      },
      itemId: { type: "string" },
      price: { type: "number" },
      targetAgentId: { type: "string" },
      giveItemIds: { type: "array", items: { type: "string" } },
      requestItemIds: { type: "array", items: { type: "string" } },
      cashFromProposer: { type: "number" },
      message: { type: "string" },
      offerId: { type: "string" },
      decision: { type: "string", enum: ["accept", "reject", "counter"] },
      reason: { type: "string" }
    }
  };
}

// =============================================================================
// Parsing helpers
// =============================================================================


function extractJson(value: string) {
  const trimmed = value.trim();
  if (!trimmed.includes("{")) return null;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function coerceNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function coerceStringArray(value: unknown) {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim());
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return null;
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown runtime error";
}

// =============================================================================
// Streaming
// =============================================================================

