import { computeVisibleStateForAgent, findAgentById, type AgentVisibleState, type MarketState } from "@agents-marketplace/engine";
import type { MarketOrder } from "@agents-marketplace/shared";

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

type IncomingOfferContext = {
  offerId: string;
  fromAgentId: string;
  giveItemIds: string[];
  requestItemIds: string[];
  cashFromProposer: number;
  message: string;
  guidance: OfferGuidance;
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

type CompactContext = {
  self: SelfContext | null;
  otherAgents: OtherAgentContext[];
  items: ItemContext[];
  publicOrders: MarketOrder[];
  myPendingOffers: OutgoingOfferSummary[];
  recentTrades: string[];
};

type ToolRequest =
  | { tool: "check_sell_orders"; itemId?: string }
  | { tool: "check_buy_orders"; itemId?: string }
  | { tool: "check_price_history"; itemId: string }
  | { tool: "post_sell_order"; itemId: string; price: number }
  | { tool: "post_buy_order"; itemId: string; price: number };

type PromptOptions = {
  callbacks?: StreamCallbacks;
  systemPrompt?: string;
  temperature?: number;
  format?: "json" | Record<string, unknown>;
};

type MakeOfferPayload = {
  targetAgentId: string;
  giveItemIds: string[];
  requestItemIds: string[];
  cashFromProposer: number;
  message: string;
};

type CounterOfferPayload = {
  giveItemIds: string[];
  requestItemIds: string[];
  cashFromProposer: number;
  message: string;
};

export type PostedOrder = { type: "buy" | "sell"; itemId: string; price: number };

export type ActiveActionResult =
  | { kind: "pass"; trace: string; postedOrders: PostedOrder[] }
  | {
      kind: "offer";
      offer: {
        targetAgentId: string;
        giveItemIds: string[];
        requestItemIds: string[];
        cashFromProposer: number;
        message: string;
      };
      trace: string;
      postedOrders: PostedOrder[];
    };

export type OfferResponseResult =
  | { kind: "accept"; trace: string }
  | { kind: "reject"; reason: string; trace: string }
  | {
      kind: "counter";
      counter: {
        giveItemIds: string[];
        requestItemIds: string[];
        cashFromProposer: number;
        message: string;
      };
      trace: string;
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
      return { kind: "pass", trace: `Active action skipped because runtime mode is ${this.runtimeConfig.agentRuntimeMode}.`, postedOrders: [] };
    }

    const agent = findAgentById(state, agentId);
    if (!agent) {
      return { kind: "pass", trace: "Agent missing from state.", postedOrders: [] };
    }

    const visibleState = computeVisibleStateForAgent(state, agentId);
    const compact = buildCompactContext(visibleState);

    try {
      const { response, postedOrders } = await this.runToolChain(agentId, compact, callbacks);
      const base = await this.normalizeActiveAction(agentId, compact, response);
      if (base.kind === "offer") {
        return { kind: "offer" as const, offer: base.offer, trace: base.trace, postedOrders };
      }
      return { kind: "pass" as const, trace: base.trace, postedOrders };
    } catch (error) {
      callbacks?.onError?.(toMessage(error));
      return { kind: "pass", trace: `Active action failed: ${toMessage(error)}`, postedOrders: [] };
    }
  }

  async generateOfferResponse(
    state: MarketState,
    agentId: string,
    offer: {
      offerId: string;
      fromAgentId: string;
      giveItemIds: string[];
      requestItemIds: string[];
      cashFromProposer: number;
      message: string;
    },
    callbacks?: StreamCallbacks
  ): Promise<OfferResponseResult> {
    if (this.runtimeConfig.agentRuntimeMode !== "ollama") {
      return {
        kind: "reject",
        reason: `Offer response skipped because runtime mode is ${this.runtimeConfig.agentRuntimeMode}.`,
        trace: `Offer response skipped because runtime mode is ${this.runtimeConfig.agentRuntimeMode}.`
      };
    }

    const visibleState = computeVisibleStateForAgent(state, agentId);
    const compact = buildCompactContext(visibleState);
    const guidance = buildOfferGuidance(compact, offer);
    const incomingOffer: IncomingOfferContext = { ...offer, guidance };

    try {
      const response = await this.completePrompt(
        buildOfferResponsePrompt(agentId, compact, incomingOffer),
        {
          callbacks,
          format: buildOfferResponseActionSchema(),
          temperature: 0.1
        }
      );

      return this.normalizeOfferResponse(agentId, compact, response);
    } catch (error) {
      callbacks?.onError?.(toMessage(error));
      return {
        kind: "reject",
        reason: `Offer response failed: ${toMessage(error)}`,
        trace: `Offer response failed: ${toMessage(error)}`
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Prompt chain — the agent can call multiple tools before deciding
  // ---------------------------------------------------------------------------

  private async runToolChain(
    agentId: string,
    compact: CompactContext,
    callbacks?: StreamCallbacks
  ): Promise<{ response: string; postedOrders: PostedOrder[] }> {
    const toolResults: string[] = [];
    const postedOrders: PostedOrder[] = [];
    const maxSteps = Math.max(1, this.runtimeConfig.agentToolBudget + 1);

    for (let step = 0; step < maxSteps; step += 1) {
      const toolsUsed = step;
      const toolsRemaining = this.runtimeConfig.agentToolBudget - toolsUsed;
      const isLastStep = toolsRemaining <= 0;
      const prompt = isLastStep
        ? buildForcedFinalPrompt(agentId, compact, toolResults)
        : buildActiveActionPrompt(agentId, compact, toolResults, toolsRemaining);

      const schema = isLastStep
        ? buildActiveActionSchema(false)
        : buildActiveActionSchema(true);

      const response = await this.completePrompt(prompt, {
        callbacks,
        format: schema,
        temperature: 0.1
      });

      const toolRequest = parseToolRequest(response);
      if (!toolRequest) {
        return { response, postedOrders };
      }

      const toolResult = executeToolRequest(compact, toolRequest, postedOrders);
      toolResults.push(toolResult);
    }

    return { response: '{"type":"pass"}', postedOrders };
  }

  private async normalizeActiveAction(
    agentId: string,
    compact: CompactContext,
    response: string
  ): Promise<{ kind: "pass"; trace: string } | { kind: "offer"; offer: MakeOfferPayload; trace: string }> {
    const payload = extractActionObject(response);

    if (payload?.type === "make_offer") {
      const offer = parseMakeOfferPayload(payload);
      if (offer) {
        return { kind: "offer", offer, trace: "Active action generated by Ollama." };
      }
    }

    if (payload?.type === "pass" || isPass(response)) {
      return { kind: "pass", trace: "Active action: pass." };
    }

    const repaired = await this.completePrompt(
      buildActiveRecoveryPrompt(agentId, compact, response),
      { systemPrompt: buildRecoverySystemPrompt(), temperature: 0.1 }
    );

    if (isPass(repaired) || extractActionObject(repaired)?.type === "pass") {
      return { kind: "pass", trace: "Active action: pass (recovered)." };
    }

    const repairedPayload = extractActionObject(repaired);
    if (repairedPayload?.type === "make_offer") {
      const offer = parseMakeOfferPayload(repairedPayload);
      if (offer) {
        return { kind: "offer", offer, trace: "Active action translated from malformed Ollama output." };
      }
    }

    return { kind: "pass", trace: "Active action: could not parse; defaulting to pass." };
  }

  private async normalizeOfferResponse(agentId: string, compact: CompactContext, response: string): Promise<OfferResponseResult> {
    const payload = extractActionObject(response);

    if (payload?.type === "accept") {
      return { kind: "accept", trace: "Offer accepted by Ollama." };
    }

    if (payload?.type === "reject") {
      const reason = typeof payload.reason === "string" ? payload.reason.trim() : "No reason given.";
      return { kind: "reject", reason, trace: "Offer rejected by Ollama." };
    }

    if (payload?.type === "counter") {
      const counter = parseCounterPayload(payload);
      if (counter) {
        return { kind: "counter", counter, trace: "Counter-offer generated by Ollama." };
      }
    }

    const repaired = await this.completePrompt(
      buildOfferResponseRecoveryPrompt(agentId, compact, response),
      { systemPrompt: buildRecoverySystemPrompt(), temperature: 0.1 }
    );

    const repairedPayload = extractActionObject(repaired);

    if (repairedPayload?.type === "accept") {
      return { kind: "accept", trace: "Offer accepted (recovered)." };
    }

    if (repairedPayload?.type === "reject") {
      const reason = typeof repairedPayload.reason === "string" ? repairedPayload.reason.trim() : "No reason given.";
      return { kind: "reject", reason, trace: "Offer rejected (recovered)." };
    }

    if (repairedPayload?.type === "counter") {
      const counter = parseCounterPayload(repairedPayload);
      if (counter) {
        return { kind: "counter", counter, trace: "Counter-offer translated from malformed Ollama output." };
      }
    }

    return { kind: "reject", reason: "Could not parse response.", trace: "Offer response parsing failed; defaulting to reject." };
  }

  private async completePrompt(prompt: string, options: PromptOptions = {}) {
    const systemPrompt = options.systemPrompt ?? buildSystemPrompt();
    options.callbacks?.onStart?.(systemPrompt, prompt);

    const response = await fetch(`${this.runtimeConfig.ollamaBaseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.runtimeConfig.ollamaModel,
        stream: true,
        keep_alive: "30m",
        format: options.format,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt }
        ],
        options: { temperature: options.temperature ?? 0.9 }
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}`);
    }

    if (!response.body) {
      throw new Error("Ollama returned no response body.");
    }

    return readStreamedContent(response.body, options.callbacks);
  }
}

// =============================================================================
// System prompts
// =============================================================================

function buildSystemPrompt() {
  return [
    "You are a trading agent in a marketplace simulation.",
    "Return exactly one JSON object — no prose, no markdown fences, no extra text.",
    "The \"message\" field is public — write it in your character's voice, at least one sentence.",
    "Keep valuations and budget secret in messages. Stay in character."
  ].join(" ");
}

function buildRecoverySystemPrompt() {
  return [
    "You translate messy agent output into one allowed machine-readable result.",
    "Return only the normalized result.",
    "Do not explain your reasoning.",
    "Do not add markdown fences.",
    "If the text cannot be mapped with high confidence, return INVALID."
  ].join(" ");
}

// =============================================================================
// Context building
// =============================================================================

function buildCompactContext(visibleState: AgentVisibleState): CompactContext {
  const selfAgent = visibleState.self;
  return {
    self: selfAgent
      ? {
          id: selfAgent.id,
          name: selfAgent.name,
          persona: selfAgent.persona,
          budget: selfAgent.budget,
          inventory: [...selfAgent.inventory],
          wishlist: [...selfAgent.wishlist],
          valuations: { ...selfAgent.valuations },
        }
      : null,
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
// Offer guidance (for response phase)
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
// Active-phase prompts
// =============================================================================

function buildActiveActionPrompt(
  agentId: string,
  compact: CompactContext,
  toolResults: string[],
  toolsRemaining: number
) {
  const self = compact.self;
  const { sellSuggestions, buySuggestions, orderMatches } = computeSuggestions(compact);
  const sections: string[] = [];

  sections.push([
    "=== YOU ===",
    `Agent: ${self?.name ?? agentId} (${agentId})`,
    `Persona: ${self?.persona ?? ""}`,
    `Budget: $${self?.budget ?? 0}`,
    `You own: ${self ? self.inventory.map((id) => `${id} ($${self.valuations[id] ?? 0})`).join(", ") || "nothing" : "nothing"}`,
    `You want: ${self ? self.wishlist.map((id) => `${id} ($${self.valuations[id] ?? 0})`).join(", ") || "nothing" : "nothing"}`,
  ].join("\n"));

  // Suggestions section
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
    sugParts.push("No immediate opportunities found. Consider browsing orders or passing.");
  }
  sections.push(sugParts.join("\n"));

  sections.push([
    "=== YOUR OPEN OFFERS (do NOT duplicate these) ===",
    compact.myPendingOffers.length === 0
      ? "None."
      : compact.myPendingOffers.map((o) =>
          `To ${o.toAgentId}: give [${o.giveItemIds.join(", ")}] for [${o.requestItemIds.join(", ") || "nothing"}]`
        ).join("\n"),
  ].join("\n"));

  if (toolResults.length > 0) {
    sections.push(`=== TOOL RESULTS ===\n${toolResults.join("\n\n")}`);
  }

  if (compact.recentTrades.length > 0) {
    sections.push(["=== RECENT ACTIVITY ===", ...compact.recentTrades].join("\n"));
  }

  sections.push([
    `=== AVAILABLE TOOLS (${toolsRemaining} call${toolsRemaining === 1 ? "" : "s"} remaining) ===`,
    '{"type":"tool","tool":"check_sell_orders","itemId":"solar-lens"} — see who is selling an item (omit itemId for all)',
    '{"type":"tool","tool":"check_buy_orders","itemId":"copper-key"} — see who wants to buy an item (omit itemId for all)',
    '{"type":"tool","tool":"check_price_history","itemId":"saffron"} — recent trades involving an item',
    '{"type":"tool","tool":"post_sell_order","itemId":"item-id","price":25} — publicly list an item for sale',
    '{"type":"tool","tool":"post_buy_order","itemId":"item-id","price":30} — publicly request to buy an item',
    ...(toolsRemaining === 1 ? ["This is your LAST tool call. After this you must choose a final action."] : []),
  ].join("\n"));

  sections.push([
    "=== FINAL ACTIONS (when you are ready to finish your turn) ===",
    '{"type":"pass"} — end your turn with no trade',
    '{"type":"make_offer","targetAgentId":"ID","giveItemIds":["item"],"requestItemIds":["item"],"cashFromProposer":0,"message":"In character."}',
    "",
    "Offers are private between you and the target. cashFromProposer > 0 = you pay; < 0 = they pay.",
    "Only GIVE items you own. Only REQUEST items you actually want.",
    'The "message" is public — write it in your character\'s voice.',
  ].join("\n"));

  sections.push(buildIdentityFooter(agentId, compact));

  return sections.join("\n\n");
}

function buildForcedFinalPrompt(
  agentId: string,
  compact: CompactContext,
  toolResults: string[]
) {
  const self = compact.self;
  const sections: string[] = [];

  sections.push([
    "=== YOU ===",
    `Agent: ${self?.name ?? agentId} (${agentId})`,
    `Budget: $${self?.budget ?? 0}`,
    `You own: ${self?.inventory.join(", ") || "nothing"}`,
    `You want: ${self?.wishlist.join(", ") || "nothing"}`,
  ].join("\n"));

  if (toolResults.length > 0) {
    sections.push(`=== TOOL RESULTS ===\n${toolResults.join("\n\n")}`);
  }

  sections.push([
    "=== OPEN OFFERS (do NOT duplicate) ===",
    compact.myPendingOffers.length === 0
      ? "None."
      : compact.myPendingOffers.map((o) =>
          `To ${o.toAgentId}: give [${o.giveItemIds.join(", ")}] for [${o.requestItemIds.join(", ") || "nothing"}]`
        ).join("\n"),
  ].join("\n"));

  sections.push([
    "No more tool calls allowed. Choose your FINAL action NOW:",
    '{"type":"pass"}',
    '{"type":"make_offer","targetAgentId":"ID","giveItemIds":["item"],"requestItemIds":["item"],"cashFromProposer":0,"message":"In character."}',
    "Return exactly one JSON object.",
  ].join("\n"));

  sections.push(buildIdentityFooter(agentId, compact));

  return sections.join("\n\n");
}

// =============================================================================
// Offer-response prompt
// =============================================================================

function buildOfferResponsePrompt(
  agentId: string,
  compact: CompactContext,
  incomingOffer: IncomingOfferContext
) {
  const self = compact.self;
  const g = incomingOffer.guidance;
  const sections: string[] = [];

  sections.push([
    "=== YOU ===",
    `Agent: ${self?.name ?? agentId} (${agentId})`,
    `Persona: ${self?.persona ?? ""}`,
    `Budget: $${self?.budget ?? 0}`,
    `You own: ${self?.inventory.join(", ") || "nothing"}`,
    `You want: ${self?.wishlist.join(", ") || "nothing"}`,
  ].join("\n"));

  const giveNames = incomingOffer.giveItemIds.join(", ") || "nothing";
  const requestNames = incomingOffer.requestItemIds.join(", ") || "nothing";
  const cashDesc = incomingOffer.cashFromProposer === 0
    ? "none"
    : incomingOffer.cashFromProposer > 0
      ? `they pay you $${incomingOffer.cashFromProposer}`
      : `you pay $${Math.abs(incomingOffer.cashFromProposer)}`;

  sections.push([
    "=== INCOMING OFFER ===",
    `From: ${incomingOffer.fromAgentId}`,
    `They give you: ${giveNames}`,
    `They want from you: ${requestNames}`,
    `Cash: ${cashDesc}`,
    ...(incomingOffer.message ? [`Their message: "${incomingOffer.message}"`] : []),
  ].join("\n"));

  const wishlistSet = new Set(self?.wishlist ?? []);
  const analysis: string[] = ["=== TRADE ANALYSIS ==="];
  const receivingWishlist = incomingOffer.giveItemIds.filter((id) => wishlistSet.has(id));
  const receivingOther = incomingOffer.giveItemIds.filter((id) => !wishlistSet.has(id));
  const givingNonWishlist = incomingOffer.requestItemIds.filter((id) => !wishlistSet.has(id));
  const givingWishlist = incomingOffer.requestItemIds.filter((id) => wishlistSet.has(id));

  if (receivingWishlist.length > 0) analysis.push(`+ You receive ${receivingWishlist.join(", ")} — ON your wishlist`);
  if (receivingOther.length > 0) analysis.push(`  You receive ${receivingOther.join(", ")} — not on wishlist`);
  if (givingNonWishlist.length > 0) analysis.push(`+ You give ${givingNonWishlist.join(", ")} — NOT on your wishlist (fine to trade)`);
  if (givingWishlist.length > 0) analysis.push(`- You give ${givingWishlist.join(", ")} — ON your wishlist (losing a desired item!)`);

  analysis.push(`Value you gain: $${g.valueIReceive}`);
  analysis.push(`Value you lose: $${g.valueIGive}`);
  analysis.push(`Net value: ${g.netValue >= 0 ? "+" : ""}$${g.netValue}`);

  if (g.canAcceptNow) {
    analysis.push("Settlement: POSSIBLE — you own the requested items");
  } else {
    analysis.push(`Settlement: BLOCKED — ${g.blockers.join("; ")}`);
  }

  sections.push(analysis.join("\n"));

  sections.push([
    "=== DECIDE ===",
    '{"type":"accept"} — settle the trade as-is',
    '{"type":"reject","reason":"short reason"} — decline',
    '{"type":"counter","giveItemIds":["item"],"requestItemIds":["item"],"cashFromProposer":0,"message":"In character."}',
    "",
    "Consider countering to negotiate better terms before accepting.",
    "If countering: only give items YOU own, only request items on YOUR wishlist.",
    "Use cashFromProposer to balance value differences (> 0 = you pay, < 0 = they pay).",
    'The "message" field is public — write in your persona\'s voice.',
    "Return exactly one JSON object.",
  ].join("\n"));

  sections.push(buildIdentityFooter(agentId, compact));

  return sections.join("\n\n");
}

// =============================================================================
// Recovery prompts
// =============================================================================

function buildActiveRecoveryPrompt(agentId: string, compact: CompactContext, candidate: string) {
  return [
    `Normalize ${agentId}'s active-turn candidate into one allowed output.`,
    "Return exactly one of these outputs:",
    '{"type":"pass"}',
    '{"type":"make_offer","targetAgentId":"iara","giveItemIds":["reef-glass"],"requestItemIds":["solar-lens"],"cashFromProposer":0,"message":"Clean swap."}',
    "INVALID",
    `Known agents:\n${compact.otherAgents.map((a) => `- ${a.id}: ${a.name}`).join("\n")}`,
    `Known items:\n${compact.items.map((i) => `- ${i.id}: ${i.name}`).join("\n")}`,
    `Candidate:\n${candidate}`
  ].join("\n\n");
}

function buildOfferResponseRecoveryPrompt(agentId: string, compact: CompactContext, candidate: string) {
  return [
    `Normalize ${agentId}'s offer-response candidate into one allowed output.`,
    "Return exactly one of these outputs:",
    '{"type":"accept"}',
    '{"type":"reject","reason":"short reason"}',
    '{"type":"counter","giveItemIds":["repair-kit"],"requestItemIds":["solar-lens"],"cashFromProposer":0,"message":"Counter."}',
    "INVALID",
    `Known items:\n${compact.items.map((i) => `- ${i.id}: ${i.name}`).join("\n")}`,
    `Candidate:\n${candidate}`
  ].join("\n\n");
}

function buildIdentityFooter(agentId: string, compact: CompactContext) {
  return [
    `Agent ID: ${agentId}`,
    `Agent Name: ${compact.self?.name ?? agentId}`,
    `Agent Persona: ${compact.self?.persona ?? ""}`,
    "Complete the response as this exact agent, fully embodying your persona."
  ].join("\n");
}

// =============================================================================
// Tool execution
// =============================================================================

function parseToolRequest(value: string): ToolRequest | null {
  const payload = extractActionObject(value);
  if (!payload || payload.type !== "tool") return null;

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
  }
}

// =============================================================================
// JSON schemas
// =============================================================================

function buildActiveActionSchema(includeTool: boolean) {
  const typeValues: string[] = ["pass", "make_offer"];
  const properties: Record<string, unknown> = {
    targetAgentId: { type: "string" },
    giveItemIds: { type: "array", items: { type: "string" } },
    requestItemIds: { type: "array", items: { type: "string" } },
    cashFromProposer: { type: "number" },
    message: { type: "string" }
  };

  if (includeTool) {
    typeValues.push("tool");
    properties.tool = { type: "string", enum: ["check_sell_orders", "check_buy_orders", "check_price_history", "post_sell_order", "post_buy_order"] };
    properties.itemId = { type: "string" };
    properties.price = { type: "number" };
  }

  return {
    type: "object",
    additionalProperties: false,
    required: ["type"],
    properties: {
      type: { type: "string", enum: typeValues },
      ...properties
    }
  };
}

function buildOfferResponseActionSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type"],
    properties: {
      type: { type: "string", enum: ["accept", "reject", "counter"] },
      reason: { type: "string" },
      giveItemIds: { type: "array", items: { type: "string" } },
      requestItemIds: { type: "array", items: { type: "string" } },
      cashFromProposer: { type: "number" },
      message: { type: "string" }
    }
  };
}

// =============================================================================
// Parsing helpers
// =============================================================================

function parseMakeOfferPayload(payload: Record<string, unknown> & { type: string }): MakeOfferPayload | null {
  const targetAgentId = typeof payload.targetAgentId === "string" ? payload.targetAgentId.trim() : "";
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  const cashFromProposer = coerceNumber(payload.cashFromProposer);
  const giveItemIds = coerceStringArray(payload.giveItemIds);
  const requestItemIds = coerceStringArray(payload.requestItemIds);

  if (!targetAgentId || cashFromProposer === null || !giveItemIds || !requestItemIds) {
    return null;
  }

  return { targetAgentId, giveItemIds, requestItemIds, cashFromProposer, message: message || "Offer." };
}

function parseCounterPayload(payload: Record<string, unknown> & { type: string }): CounterOfferPayload | null {
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  const cashFromProposer = coerceNumber(payload.cashFromProposer);
  const giveItemIds = coerceStringArray(payload.giveItemIds);
  const requestItemIds = coerceStringArray(payload.requestItemIds);

  if (cashFromProposer === null || !giveItemIds || !requestItemIds) {
    return null;
  }

  return { giveItemIds, requestItemIds, cashFromProposer, message: message || "Counter offer." };
}

function isPass(value: string) {
  return matchesControlWord(value, "PASS");
}

function matchesControlWord(value: string, word: string) {
  return new RegExp(`^${word}(?:\\b|\\s|[.!?,:;])`, "i").test(value.trim());
}

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

function extractActionObject(value: string) {
  const payload = extractJson(value);
  if (!payload || typeof payload.type !== "string") return null;
  return payload as Record<string, unknown> & { type: string };
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

async function readStreamedContent(body: ReadableStream<Uint8Array>, callbacks?: StreamCallbacks) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let aggregate = "";

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
        aggregate += chunk;
        callbacks?.onToken?.(chunk, aggregate);
      }
    }
  }

  if (buffer.trim()) {
    const payload = JSON.parse(buffer.trim()) as {
      message?: { content?: string };
      error?: string;
    };
    if (payload.error) throw new Error(payload.error);
    const chunk = payload.message?.content ?? "";
    if (chunk) {
      aggregate += chunk;
      callbacks?.onToken?.(chunk, aggregate);
    }
  }

  callbacks?.onComplete?.(aggregate);
  return aggregate;
}
