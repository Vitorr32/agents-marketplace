import { computeVisibleStateForAgent, findAgentById, type AgentVisibleState, type MarketState } from "@agents-marketplace/engine";

type RuntimeConfig = {
  agentRuntimeMode: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
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
  myPendingOffers: OutgoingOfferSummary[];
  recentTrades: string[];
};

type InfoToolRequest = {
  tool: "trade_history";
  query?: string;
};

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

export type ActiveActionResult =
  | { kind: "pass"; trace: string }
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
      return { kind: "pass", trace: `Active action skipped because runtime mode is ${this.runtimeConfig.agentRuntimeMode}.` };
    }

    const agent = findAgentById(state, agentId);
    if (!agent) {
      return { kind: "pass", trace: "Agent missing from state." };
    }

    const visibleState = computeVisibleStateForAgent(state, agentId);
    const compact = buildCompactContext(visibleState);

    const finalInstruction = [
      "Return exactly one JSON object.",
      "Options:",
      '- {"type":"pass"} — skip this tick.',
      '- {"type":"make_offer","targetAgentId":"iara","giveItemIds":["reef-glass"],"requestItemIds":["solar-lens"],"cashFromProposer":0,"message":"Clean swap."}',
      "Use only items from self.inventory on giveItemIds.",
      "cashFromProposer > 0 means you pay them; cashFromProposer < 0 means they pay you.",
      "Check myPendingOffers before making a new offer to avoid duplicating open outbound offers.",
      "Use self.wishlist to determine what you want to acquire.",
      "Only make an offer if you have a genuine intent to trade right now."
    ].join(" ");

    try {
      const response = await this.resolveWithInfoRequests(
        agentId,
        compact,
        finalInstruction,
        buildActiveActionSchema(true),
        buildActiveActionSchema(false),
        callbacks
      );

      return this.normalizeActiveAction(agentId, compact, response);
    } catch (error) {
      callbacks?.onError?.(toMessage(error));
      return { kind: "pass", trace: `Active action failed: ${toMessage(error)}` };
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

    const finalInstruction = [
      "Return exactly one JSON object.",
      "Options:",
      '- {"type":"accept"} — settle the offer as-is.',
      '- {"type":"reject","reason":"short reason"} — decline.',
      '- {"type":"counter","giveItemIds":["repair-kit"],"requestItemIds":["solar-lens"],"cashFromProposer":0,"message":"Counter."} — reject this offer and send a new one back.',
      "guidance.canAcceptNow is true only if you physically can settle. If false, you must reject or counter.",
      "In a counter, cashFromProposer > 0 means you pay them; cashFromProposer < 0 means they pay you.",
      "Only include items you own in giveItemIds of a counter."
    ].join(" ");

    try {
      const response = await this.completePrompt(
        buildOfferResponsePrompt(agentId, compact, incomingOffer, finalInstruction),
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

  private async resolveWithInfoRequests(
    agentId: string,
    compact: CompactContext,
    finalInstruction: string,
    actionSchema: Record<string, unknown>,
    forcedActionSchema: Record<string, unknown>,
    callbacks?: StreamCallbacks
  ) {
    const toolResults: string[] = [];
    const attemptedResponses: string[] = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const prompt = buildActiveActionPrompt(agentId, compact, toolResults, finalInstruction);
      const response = await this.completePrompt(prompt, {
        callbacks,
        format: actionSchema,
        temperature: 0.1
      });
      attemptedResponses.push(`Attempt ${attempt + 1}: ${sanitizeTraceSnippet(response)}`);

      const infoRequest = parseInfoToolRequest(response);
      if (!infoRequest) {
        return response;
      }

      toolResults.push(executeInfoTool(compact, infoRequest));
    }

    const forcedFinalPrompt = buildForcedFinalPrompt(agentId, compact, toolResults, finalInstruction);
    const forcedFinalResponse = await this.completePrompt(forcedFinalPrompt, {
      callbacks,
      format: forcedActionSchema,
      temperature: 0.1
    });
    attemptedResponses.push(`Forced final: ${sanitizeTraceSnippet(forcedFinalResponse)}`);

    if (parseInfoToolRequest(forcedFinalResponse)) {
      throw new Error(
        `Agent exhausted its information request budget and still requested a tool. Raw responses: ${attemptedResponses.join(" | ")}`
      );
    }

    return forcedFinalResponse;
  }

  private async normalizeActiveAction(agentId: string, compact: CompactContext, response: string): Promise<ActiveActionResult> {
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
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "user",
            content: prompt
          }
        ],
        options: {
          temperature: options.temperature ?? 0.9
        }
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

function buildSystemPrompt() {
  return [
    "You are a trading agent in a repeated market simulation.",
    "Every response is consumed by a strict machine parser.",
    'For action phases, return exactly one JSON object with a "type" field.',
    "Any extra prose, labels, markdown fences, or multiple outputs will be rejected.",
    "Inventories, budgets, and valuations are private — do not reveal them.",
    "You may negotiate strategically and bluff in messages.",
    "The \"message\" field of every offer or counter is shown publicly to everyone watching the marketplace — write it with your character's voice, personality, and motivation. Make it vivid and at least one full sentence.",
    "Stay in character with your persona at all times.",
    "If you need more information, request a tool exactly in JSON.",
    "Return exactly one JSON object with no prose before or after it.",
    "Do not wrap JSON in markdown fences."
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

function buildCompactContext(visibleState: AgentVisibleState): CompactContext {
  return {
    self: visibleState.self
      ? {
          id: visibleState.self.id,
          name: visibleState.self.name,
          persona: visibleState.self.persona,
          budget: visibleState.self.budget,
          inventory: visibleState.self.inventory,
          wishlist: visibleState.self.wishlist,
          valuations: visibleState.self.valuations
        }
      : null,
    otherAgents: visibleState.publicAgents
      .filter((agent) => agent.id !== visibleState.self?.id)
      .map((agent) => ({ id: agent.id, name: agent.name })),
    items: visibleState.items.map((item) => ({ id: item.id, name: item.name })),
    myPendingOffers: visibleState.outgoingOffers.map((offer) => ({
      offerId: offer.id,
      toAgentId: offer.toAgentId,
      giveItemIds: offer.giveItemIds,
      requestItemIds: offer.requestItemIds,
      cashFromProposer: offer.cashFromProposer,
      message: offer.message
    })),
    recentTrades: visibleState.publicTradeEvents.slice(0, 6).map((event) => event.content)
  };
}

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

function buildActiveActionPrompt(
  agentId: string,
  compact: CompactContext,
  toolResults: string[],
  finalInstruction: string
) {
  return [
    `Your market context:\n${JSON.stringify(compact, null, 2)}`,
    toolResults.length > 0 ? `Tool results:\n${toolResults.join("\n\n")}` : "Tool results: none yet.",
    "Focus on self.wishlist to find what you want to acquire.",
    "Check self.inventory for items you can offer.",
    "Review myPendingOffers before making a new offer to avoid duplicating open outbound offers.",
    "You may optionally request one tool before deciding:",
    '- {"type":"tool","tool":"trade_history","query":"repair-kit"}',
    'Return one JSON object with a "type" field.',
    "If you already have enough information, respond with the final action directly.",
    "IMPORTANT: The \"message\" field is publicly visible to watchers of the marketplace. Write it in your character's voice — expressive, motivated, and on-brand with your persona. At least one full sentence.",
    `Expected response:\n${finalInstruction}`,
    buildIdentityFooter(agentId, compact)
  ].join("\n\n");
}

function buildForcedFinalPrompt(
  agentId: string,
  compact: CompactContext,
  toolResults: string[],
  finalInstruction: string
) {
  return [
    `Your market context:\n${JSON.stringify(compact, null, 2)}`,
    toolResults.length > 0 ? `Tool results:\n${toolResults.join("\n\n")}` : "Tool results: none yet.",
    "Your tool-request budget is exhausted. Choose your final action now.",
    "Do not request any tool.",
    'Return one JSON object with a "type" field.',
    `Expected response:\n${finalInstruction}`,
    buildIdentityFooter(agentId, compact)
  ].join("\n\n");
}

function buildOfferResponsePrompt(
  agentId: string,
  compact: CompactContext,
  incomingOffer: IncomingOfferContext,
  finalInstruction: string
) {
  return [
    `Your identity: ${agentId} (${compact.self?.name ?? agentId})`,
    `Your persona: ${compact.self?.persona ?? ""}`,
    `Your budget: $${compact.self?.budget ?? 0}`,
    `Your inventory: ${JSON.stringify(compact.self?.inventory ?? [])}`,
    `Your wishlist: ${JSON.stringify(compact.self?.wishlist ?? [])}`,
    `Your valuations: ${JSON.stringify(compact.self?.valuations ?? {})}`,
    `Incoming offer from ${incomingOffer.fromAgentId}:\n${JSON.stringify(incomingOffer, null, 2)}`,
    "guidance.canAcceptNow tells you if you physically can settle. If false, you must reject or counter.",
    "A counter rejects this offer and sends a new proposal back to the same agent.",
    "IMPORTANT: If you counter, the \"message\" field is shown publicly — write it in your character's voice with personality. At least one full sentence.",
    `Expected response:\n${finalInstruction}`,
    buildIdentityFooter(agentId, compact)
  ].join("\n\n");
}

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

function executeInfoTool(compact: CompactContext, request: InfoToolRequest) {
  const query = (request.query ?? "").toLowerCase().trim();
  const matches = compact.recentTrades.filter((text) => !query || text.toLowerCase().includes(query));
  const lines = matches.length > 0 ? matches.slice(0, 6) : ["No recent matching trades."];
  return [`Tool result: trade_history`, ...lines].join("\n");
}

function parseInfoToolRequest(value: string): InfoToolRequest | null {
  const payload = extractActionObject(value);

  if (!payload || payload.type !== "tool" || payload.tool !== "trade_history") {
    return null;
  }

  return {
    tool: "trade_history",
    query: typeof payload.query === "string" ? payload.query : undefined
  };
}

function parseMakeOfferPayload(payload: Record<string, unknown> & { type: string }): MakeOfferPayload | null {
  const targetAgentId = typeof payload.targetAgentId === "string" ? payload.targetAgentId.trim() : "";
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  const cashFromProposer = coerceNumber(payload.cashFromProposer);
  const giveItemIds = coerceStringArray(payload.giveItemIds);
  const requestItemIds = coerceStringArray(payload.requestItemIds);

  if (!targetAgentId || cashFromProposer === null || !giveItemIds || !requestItemIds) {
    return null;
  }

  return {
    targetAgentId,
    giveItemIds,
    requestItemIds,
    cashFromProposer,
    message: message || "Offer."
  };
}

function parseCounterPayload(payload: Record<string, unknown> & { type: string }): CounterOfferPayload | null {
  const message = typeof payload.message === "string" ? payload.message.trim() : "";
  const cashFromProposer = coerceNumber(payload.cashFromProposer);
  const giveItemIds = coerceStringArray(payload.giveItemIds);
  const requestItemIds = coerceStringArray(payload.requestItemIds);

  if (cashFromProposer === null || !giveItemIds || !requestItemIds) {
    return null;
  }

  return {
    giveItemIds,
    requestItemIds,
    cashFromProposer,
    message: message || "Counter offer."
  };
}

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
    properties.tool = { type: "string", enum: ["trade_history"] };
    properties.query = { type: "string" };
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

function isPass(value: string) {
  return matchesControlWord(value, "PASS");
}

function matchesControlWord(value: string, word: string) {
  return new RegExp(`^${word}(?:\\b|\\s|[.!?,:;])`, "i").test(value.trim());
}

function extractJson(value: string) {
  const trimmed = value.trim();

  if (!trimmed.includes("{")) {
    return null;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractActionObject(value: string) {
  const payload = extractJson(value);

  if (!payload || typeof payload.type !== "string") {
    return null;
  }

  return payload as Record<string, unknown> & { type: string };
}

function coerceNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

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

  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }

  return null;
}

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown runtime error";
}

function sanitizeTraceSnippet(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 280) || "(empty response)";
}

async function readStreamedContent(body: ReadableStream<Uint8Array>, callbacks?: StreamCallbacks) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let aggregate = "";

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();

      if (!trimmed) {
        continue;
      }

      const payload = JSON.parse(trimmed) as {
        message?: {
          content?: string;
        };
        error?: string;
      };

      if (payload.error) {
        throw new Error(payload.error);
      }

      const chunk = payload.message?.content ?? "";
      if (chunk) {
        aggregate += chunk;
        callbacks?.onToken?.(chunk, aggregate);
      }
    }
  }

  if (buffer.trim()) {
    const payload = JSON.parse(buffer.trim()) as {
      message?: {
        content?: string;
      };
      error?: string;
    };

    if (payload.error) {
      throw new Error(payload.error);
    }

    const chunk = payload.message?.content ?? "";
    if (chunk) {
      aggregate += chunk;
      callbacks?.onToken?.(chunk, aggregate);
    }
  }

  callbacks?.onComplete?.(aggregate);
  return aggregate;
}


