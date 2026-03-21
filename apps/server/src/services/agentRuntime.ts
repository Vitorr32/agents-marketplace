import { computeVisibleStateForAgent, findAgentById, type AgentVisibleState, type MarketState } from "@agents-marketplace/engine";

type RuntimeConfig = {
  agentRuntimeMode: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
};

type StreamCallbacks = {
  onStart?: () => void;
  onToken?: (chunk: string, aggregate: string) => void;
  onComplete?: (aggregate: string) => void;
  onError?: (message: string) => void;
};

type SelfContext = {
  id: string;
  name: string;
  budget: number;
  inventory: string[];
  wishlist: string[];
  valuations: Record<string, number>;
};

type PublicAgentContext = {
  id: string;
  name: string;
};

type ItemContext = {
  id: string;
  name: string;
};

type OpenOfferContext = {
  fromAgentId: string;
  toAgentId: string;
  giveItemIds: string[];
  requestItemIds: string[];
  cashFromProposer: number;
  message: string;
};

type AnnouncementContext = {
  agentId: string;
  orderType: "buy" | "sell";
  itemId: string;
  price: number;
  note: string | null;
};

type WhisperContext = {
  withAgentId: string;
  text: string;
};

type FeasibleAnnouncementBuyOption = {
  itemId: string;
  itemName: string;
  maxPrice: number;
  reasoning: string;
};

type FeasibleAnnouncementSellOption = {
  itemId: string;
  itemName: string;
  minPrice: number;
  reasoning: string;
};

type ActionableAnnouncementContext = {
  agentId: string;
  orderType: "buy" | "sell";
  itemId: string;
  itemName: string;
  price: number;
  note: string | null;
  responseMode: "sell-into-buy-order" | "buy-from-sell-order";
  reasoning: string;
  suggestedOffer: EmbeddedTradeOfferPayload;
};

type TradeResponseGuidance = {
  canAcceptNow: boolean;
  requestedItemIdsYouOwn: string[];
  missingRequestedItemIds: string[];
  cashDeltaToYou: number;
  canCoverCashNow: boolean;
  valueYouReceive: number;
  valueYouGive: number;
  netValueEstimate: number;
  blockers: string[];
};

type CompactContext = {
  self: SelfContext | null;
  publicAgents: PublicAgentContext[];
  items: ItemContext[];
  openOffers: OpenOfferContext[];
  recentAnnouncements: AnnouncementContext[];
  recentWhispers: WhisperContext[];
  recentTrades: string[];
  feasibleActions: {
    announcementBuyOptions: FeasibleAnnouncementBuyOption[];
    announcementSellOptions: FeasibleAnnouncementSellOption[];
    relevantAnnouncements: ActionableAnnouncementContext[];
  };
};

type InfoToolRequest = {
  tool: "announcement_mentions" | "whisper_history" | "trade_feedback";
  query?: string;
  agentId?: string;
};

type PromptOptions = {
  callbacks?: StreamCallbacks;
  systemPrompt?: string;
  temperature?: number;
  format?: "json" | Record<string, unknown>;
};

type WhisperStartPayload = {
  targetAgentId: string;
  message: string;
  offer?: EmbeddedTradeOfferPayload;
};

type AnnouncementPayload = {
  orderType: "buy" | "sell";
  itemId: string;
  price: number;
  note: string | null;
};

type WhisperReplyPayload = {
  message: string;
  offer?: EmbeddedTradeOfferPayload;
};

type TradeProposalPayload = {
  targetAgentId: string;
  giveItemIds: string[];
  requestItemIds: string[];
  cashFromProposer: number;
  message: string;
};

type EmbeddedTradeOfferPayload = {
  giveItemIds: string[];
  requestItemIds: string[];
  cashFromProposer: number;
  message: string;
};

export type AnnouncementResult = {
  announcement: AnnouncementPayload | null;
  trace: string;
};

export type WhisperStartResult =
  | {
      kind: "pass";
      trace: string;
    }
  | {
      kind: "done";
      trace: string;
    }
  | {
      kind: "whisper";
      whisper: {
        targetAgentId: string;
        message: string;
        offer?: TradeProposalPayload;
      };
      trace: string;
    };

export type WhisperReplyResult = {
  whisper: {
    message: string;
    offer?: TradeProposalPayload;
  } | null;
  trace: string;
};

export type TradeProposalResult =
  | {
      kind: "pass";
      trace: string;
    }
  | {
      kind: "done";
      trace: string;
    }
  | {
      kind: "proposal";
      proposal: {
        targetAgentId: string;
        giveItemIds: string[];
        requestItemIds: string[];
        cashFromProposer: number;
        message: string;
      };
      trace: string;
    };

export type TradeResponseResult = {
  decision: "accept" | "reject";
  reason: string;
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

  async generateAnnouncement(state: MarketState, agentId: string, callbacks?: StreamCallbacks): Promise<AnnouncementResult> {
    const agent = findAgentById(state, agentId);

    if (!agent) {
      return { announcement: null, trace: "Agent missing from state." };
    }

    if (this.runtimeConfig.agentRuntimeMode !== "ollama") {
      return {
        announcement: null,
        trace: `Announcement skipped because runtime mode is ${this.runtimeConfig.agentRuntimeMode}.`
      };
    }

    const visibleState = computeVisibleStateForAgent(state, agentId);
    const compact = buildCompactContext(visibleState);

    try {
      const response = await this.resolveWithInfoRequests(
        agentId,
        compact,
        'Return exactly one JSON object. Final actions: {"type":"pass"} or {"type":"announcement","orderType":"buy","itemId":"solar-lens","price":24,"note":"optional short public reason"}. Use only items from feasibleActions.announcementBuyOptions or feasibleActions.announcementSellOptions. For buy options, never exceed maxPrice. For sell options, do not go below minPrice. Pass if both lists are empty. Buy orders must be for items you do not currently hold. Sell orders must be for items you currently hold.',
        buildAnnouncementActionSchema(true),
        buildAnnouncementActionSchema(false),
        callbacks
      );

      const normalized = await this.normalizeAnnouncementResponse(agentId, compact, response);

      if (normalized.kind === "pass") {
        return { announcement: null, trace: "Announcement phase passed." };
      }

      return {
        announcement: normalized.payload,
        trace: normalized.repaired
          ? "Announcement translated from malformed Ollama output."
          : "Announcement generated by Ollama."
      };
    } catch (error) {
      callbacks?.onError?.(toMessage(error));
      return {
        announcement: null,
        trace: `Announcement failed: ${toMessage(error)}`
      };
    }
  }

  async generateWhisperStart(
    state: MarketState,
    agentId: string,
    unavailableTargets: string[],
    callbacks?: StreamCallbacks
  ): Promise<WhisperStartResult> {
    if (this.runtimeConfig.agentRuntimeMode !== "ollama") {
      return {
        kind: "pass",
        trace: `Whisper start skipped because runtime mode is ${this.runtimeConfig.agentRuntimeMode}.`
      };
    }

    const visibleState = computeVisibleStateForAgent(state, agentId);
    const compact = buildCompactContext(visibleState);

    try {
      const actionableAnnouncements = compact.feasibleActions.relevantAnnouncements.filter(
        (announcement) => !unavailableTargets.includes(announcement.agentId)
      );
      const response = await this.resolveWithInfoRequests(
        agentId,
        compact,
        `Return exactly one JSON object. Final actions: {"type":"done"}, {"type":"pass"}, or {"type":"whisper_start","targetAgentId":"iara","message":"...","offer":{"giveItemIds":["reef-glass"],"requestItemIds":["solar-lens"],"cashFromProposer":2,"message":"Direct offer if you want to close now."}}. Prefer relevant public orders from phaseContext.actionableAnnouncements. If a posted price already works, use the suggested counterpart and attach a concrete offer immediately. If you want to negotiate, whisper without an offer. Use only your own inventory on the give side. cashFromProposer may be negative when the counterpart should pay you. Unavailable targets this tick: ${unavailableTargets.join(", ") || "none"}.`,
        buildWhisperStartActionSchema(true),
        buildWhisperStartActionSchema(false),
        callbacks,
        { unavailableTargets, actionableAnnouncements }
      );

      const normalized = await this.normalizeWhisperStartResponse(agentId, compact, response);

      if (normalized.kind === "pass") {
        return { kind: "pass", trace: "Whisper start phase passed." };
      }

      if (normalized.kind === "done") {
        return { kind: "done", trace: "Agent declared done trading." };
      }

      return {
        kind: "whisper",
        whisper: {
          targetAgentId: normalized.payload.targetAgentId,
          message: normalized.payload.message,
          offer: normalized.payload.offer
            ? {
                targetAgentId: normalized.payload.targetAgentId,
                ...normalized.payload.offer
              }
            : undefined
        },
        trace: normalized.repaired
          ? "Whisper start translated from malformed Ollama output."
          : "Whisper start generated by Ollama."
      };
    } catch (error) {
      callbacks?.onError?.(toMessage(error));
      return {
        kind: "pass",
        trace: `Whisper start failed: ${toMessage(error)}`
      };
    }
  }

  async generateWhisperReply(
    state: MarketState,
    agentId: string,
    counterpartId: string,
    transcript: Array<{ speakerId: string; message: string }>,
    callbacks?: StreamCallbacks
  ): Promise<WhisperReplyResult> {
    if (this.runtimeConfig.agentRuntimeMode !== "ollama") {
      return {
        whisper: null,
        trace: `Whisper reply skipped because runtime mode is ${this.runtimeConfig.agentRuntimeMode}.`
      };
    }

    const visibleState = computeVisibleStateForAgent(state, agentId);
    const compact = buildCompactContext(visibleState);

    try {
      const counterpartRelevantAnnouncements = compact.feasibleActions.relevantAnnouncements.filter(
        (announcement) => announcement.agentId === counterpartId
      );
      const response = await this.resolveWithInfoRequests(
        agentId,
        compact,
        `Return exactly one JSON object. Final actions: {"type":"pass"} or {"type":"whisper_reply","message":"short private reply","offer":{"giveItemIds":["repair-kit"],"requestItemIds":["amber-chip"],"cashFromProposer":0,"message":"Direct counteroffer if you want to close now."}}. Focus on the transcript and phaseContext.counterpartRelevantAnnouncements. If the counterpart posted a workable order, either match it with a concrete offer or say pass. Use only your own items on the give side. cashFromProposer may be negative when you expect ${counterpartId} to pay you.`,
        buildWhisperReplyActionSchema(true),
        buildWhisperReplyActionSchema(false),
        callbacks,
        { counterpartId, transcript, counterpartRelevantAnnouncements }
      );

      const normalized = await this.normalizeWhisperReplyResponse(agentId, compact, response);

      if (normalized.kind === "pass") {
        return { whisper: null, trace: "Whisper reply passed." };
      }

      return {
        whisper: {
          message: normalized.payload.message,
          offer: normalized.payload.offer
            ? {
                targetAgentId: counterpartId,
                ...normalized.payload.offer
              }
            : undefined
        },
        trace: normalized.repaired
          ? "Whisper reply translated from malformed Ollama output."
          : "Whisper reply generated by Ollama."
      };
    } catch (error) {
      callbacks?.onError?.(toMessage(error));
      return {
        whisper: null,
        trace: `Whisper reply failed: ${toMessage(error)}`
      };
    }
  }

  async generateTradeProposal(state: MarketState, agentId: string, callbacks?: StreamCallbacks): Promise<TradeProposalResult> {
    if (this.runtimeConfig.agentRuntimeMode !== "ollama") {
      return {
        kind: "pass",
        trace: `Trade proposal skipped because runtime mode is ${this.runtimeConfig.agentRuntimeMode}.`
      };
    }

    const visibleState = computeVisibleStateForAgent(state, agentId);
    const compact = buildCompactContext(visibleState);

    try {
      const response = await this.resolveWithInfoRequests(
        agentId,
        compact,
        'Return exactly one JSON object. Final actions: {"type":"done"}, {"type":"pass"}, or {"type":"trade_proposal","targetAgentId":"toma","giveItemIds":[...],"requestItemIds":[...],"cashFromProposer":0,"message":"..."}. Use this phase for a fresh public offer only when you did not already send the concrete deal in whispers. Only ensure the offer is valid from your own perspective.',
        buildTradeProposalActionSchema(true),
        buildTradeProposalActionSchema(false),
        callbacks
      );

      const normalized = await this.normalizeTradeProposalResponse(agentId, compact, response);

      if (normalized.kind === "done") {
        return {
          kind: "done",
          trace: "Agent declared done trading."
        };
      }

      if (normalized.kind === "pass") {
        return {
          kind: "pass",
          trace: "Trade proposal phase passed."
        };
      }

      return {
        kind: "proposal",
        proposal: {
          targetAgentId: normalized.payload.targetAgentId,
          giveItemIds: normalized.payload.giveItemIds,
          requestItemIds: normalized.payload.requestItemIds,
          cashFromProposer: normalized.payload.cashFromProposer,
          message: normalized.payload.message
        },
        trace: normalized.repaired
          ? "Trade proposal translated from malformed Ollama output."
          : "Trade proposal generated by Ollama."
      };
    } catch (error) {
      callbacks?.onError?.(toMessage(error));
      return {
        kind: "pass",
        trace: `Trade proposal failed: ${toMessage(error)}`
      };
    }
  }

  async generateTradeResponse(
    state: MarketState,
    targetAgentId: string,
    offer: {
      fromAgentId: string;
      giveItemIds: string[];
      requestItemIds: string[];
      cashFromProposer: number;
      message: string;
    },
    callbacks?: StreamCallbacks
  ): Promise<TradeResponseResult> {
    if (this.runtimeConfig.agentRuntimeMode !== "ollama") {
      return {
        decision: "reject",
        reason: `Trade response skipped because runtime mode is ${this.runtimeConfig.agentRuntimeMode}.`,
        trace: `Trade response skipped because runtime mode is ${this.runtimeConfig.agentRuntimeMode}.`
      };
    }

    const visibleState = computeVisibleStateForAgent(state, targetAgentId);
    const compact = buildCompactContext(visibleState);

    try {
      const responseGuidance = buildTradeResponseGuidance(compact, offer);
      const response = await this.resolveWithInfoRequests(
        targetAgentId,
        compact,
        'Return exactly one JSON object. Final actions: {"type":"accept"} or {"type":"reject","reason":"short rejection reason"}. Use phaseContext.responseGuidance. Positive cashFromProposer means they pay you; negative cashFromProposer means you would pay them. Reject if the blockers say you cannot complete settlement.',
        buildTradeResponseActionSchema(true),
        buildTradeResponseActionSchema(false),
        callbacks,
        { offer, responseGuidance }
      );

      const normalized = await this.normalizeTradeResponse(targetAgentId, compact, response);

      if (normalized.decision === "accept") {
        return {
          decision: "accept",
          reason: normalized.reason,
          trace: normalized.repaired
            ? "Trade response translated from malformed Ollama output."
            : "Trade response generated by Ollama."
        };
      }

      return {
        decision: "reject",
        reason: normalized.reason,
        trace: normalized.repaired
          ? "Trade response translated from malformed Ollama output."
          : "Trade response generated by Ollama."
      };
    } catch (error) {
      callbacks?.onError?.(toMessage(error));
      return {
        decision: "reject",
        reason: `Trade response failed: ${toMessage(error)}`,
        trace: `Trade response failed: ${toMessage(error)}`
      };
    }
  }

  private async resolveWithInfoRequests(
    agentId: string,
    visibleContext: CompactContext,
    finalInstruction: string,
    actionSchema: Record<string, unknown>,
    forcedActionSchema: Record<string, unknown>,
    callbacks?: StreamCallbacks,
    phaseContext?: unknown
  ) {
    const toolResults: string[] = [];
    const attemptedResponses: string[] = [];

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const prompt = buildActionPrompt(agentId, visibleContext, toolResults, finalInstruction, phaseContext);
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

      toolResults.push(executeInfoTool(visibleContext, agentId, infoRequest));
    }

    const forcedFinalPrompt = buildForcedFinalPrompt(agentId, visibleContext, toolResults, finalInstruction, phaseContext);
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

  private async normalizeAnnouncementResponse(agentId: string, visibleContext: CompactContext, response: string) {
    const payload = parseAnnouncementPayload(response);
    if (payload) {
      return {
        kind: "announcement" as const,
        payload,
        repaired: false
      };
    }

    if (isTypedAction(response, "pass") || isPass(response)) {
      return {
        kind: "pass" as const
      };
    }

    const repaired = await this.completePrompt(
      buildAnnouncementRecoveryPrompt(agentId, visibleContext, response),
      {
        systemPrompt: buildRecoverySystemPrompt(),
        temperature: 0.1
      }
    );

    if (isPass(repaired)) {
      return {
        kind: "pass" as const
      };
    }

    const repairedPayload = parseAnnouncementPayload(repaired);
    if (!repairedPayload) {
      throw new Error("Invalid announcement payload.");
    }

    return {
      kind: "announcement" as const,
      payload: repairedPayload,
      repaired: true
    };
  }

  private async normalizeWhisperStartResponse(agentId: string, visibleContext: CompactContext, response: string) {
    const payload = parseWhisperStartPayload(response);
    if (payload) {
      return {
        kind: "whisper" as const,
        payload,
        repaired: false
      };
    }

    if (isTypedAction(response, "pass") || isPass(response)) {
      return {
        kind: "pass" as const
      };
    }

    if (isTypedAction(response, "done") || isDone(response)) {
      return {
        kind: "done" as const
      };
    }

    const repaired = await this.completePrompt(
      buildWhisperStartRecoveryPrompt(agentId, visibleContext, response),
      {
        systemPrompt: buildRecoverySystemPrompt(),
        temperature: 0.1
      }
    );

    if (isPass(repaired)) {
      return {
        kind: "pass" as const
      };
    }

    if (isDone(repaired)) {
      return {
        kind: "done" as const
      };
    }

    const repairedPayload = parseWhisperStartPayload(repaired);
    if (!repairedPayload) {
      throw new Error("Invalid whisper start payload.");
    }

    return {
      kind: "whisper" as const,
      payload: repairedPayload,
      repaired: true
    };
  }

  private async normalizeWhisperReplyResponse(agentId: string, visibleContext: CompactContext, response: string) {
    const payload = parseWhisperReplyPayload(response);
    if (payload) {
      return {
        kind: "reply" as const,
        payload,
        repaired: false
      };
    }

    if (isTypedAction(response, "pass") || isPass(response)) {
      return {
        kind: "pass" as const
      };
    }

    const repaired = await this.completePrompt(
      buildWhisperReplyRecoveryPrompt(agentId, visibleContext, response),
      {
        systemPrompt: buildRecoverySystemPrompt(),
        temperature: 0.1
      }
    );

    if (isPass(repaired)) {
      return {
        kind: "pass" as const
      };
    }

    const repairedPayload = parseWhisperReplyPayload(repaired);
    if (!repairedPayload) {
      throw new Error("Invalid whisper reply payload.");
    }

    return {
      kind: "reply" as const,
      payload: repairedPayload,
      repaired: true
    };
  }

  private async normalizeTradeProposalResponse(agentId: string, visibleContext: CompactContext, response: string) {
    const payload = parseTradeProposalPayload(response);
    if (payload) {
      return {
        kind: "proposal" as const,
        payload,
        repaired: false
      };
    }

    if (isTypedAction(response, "done") || isDone(response)) {
      return {
        kind: "done" as const
      };
    }

    if (isTypedAction(response, "pass") || isPass(response)) {
      return {
        kind: "pass" as const
      };
    }

    const repaired = await this.completePrompt(
      buildTradeProposalRecoveryPrompt(agentId, visibleContext, response),
      {
        systemPrompt: buildRecoverySystemPrompt(),
        temperature: 0.1
      }
    );

    if (isDone(repaired)) {
      return {
        kind: "done" as const
      };
    }

    if (isPass(repaired)) {
      return {
        kind: "pass" as const
      };
    }

    const repairedPayload = parseTradeProposalPayload(repaired);
    if (!repairedPayload) {
      throw new Error("Invalid trade proposal payload.");
    }

    return {
      kind: "proposal" as const,
      payload: repairedPayload,
      repaired: true
    };
  }

  private async normalizeTradeResponse(agentId: string, visibleContext: CompactContext, response: string) {
    const exact = parseTradeResponseDecision(response);
    if (exact) {
      return {
        decision: exact.decision,
        reason: exact.reason ?? (exact.decision === "accept" ? "Accepted by Ollama." : "No reason provided."),
        repaired: false
      };
    }

    if (isTypedAction(response, "accept") || isAccept(response)) {
      return {
        decision: "accept" as const,
        reason: "Accepted by Ollama.",
        repaired: false
      };
    }

    const repaired = await this.completePrompt(
      buildTradeResponseRecoveryPrompt(agentId, visibleContext, response),
      {
        systemPrompt: buildRecoverySystemPrompt(),
        temperature: 0.1
      }
    );

    const repairedDecision = parseTradeResponseDecision(repaired);
    if (repairedDecision) {
      return {
        decision: repairedDecision.decision,
        reason:
          repairedDecision.reason ??
          (repairedDecision.decision === "accept" ? "Accepted by translated Ollama response." : "No reason provided."),
        repaired: true
      };
    }

    if (isAccept(repaired)) {
      return {
        decision: "accept" as const,
        reason: "Accepted by translated Ollama response.",
        repaired: true
      };
    }

    throw new Error("Invalid trade response payload.");
  }

  private async completePrompt(prompt: string, options: PromptOptions = {}) {
    const systemPrompt = options.systemPrompt ?? buildSystemPrompt();
    options.callbacks?.onStart?.();

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
    'For action phases, return exactly one JSON object with a "type" field that matches the requested schema.',
    "Any extra prose, labels, markdown fences, or multiple candidate outputs will be rejected.",
    "Inventories, budgets, and valuations are private.",
    "Announcements are public buy or sell orders only.",
    "Whispers are private between the two participants.",
    "You may bluff in dialogue.",
    "Be concise and stay in character.",
    "If you need more information, request a tool exactly in JSON.",
    "If a phase asks for JSON, return exactly one JSON object with no prose before or after it.",
    "Do not wrap JSON in markdown fences.",
    "When told to PASS, DONE, or ACCEPT, return exactly that word if that is your choice."
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
  const recentAnnouncements = visibleState.publicAnnouncements
    .slice(0, 8)
    .map((event) => parseAnnouncementEvent(event))
    .filter((event): event is NonNullable<typeof event> => Boolean(event));

  return {
    self: visibleState.self
      ? {
          id: visibleState.self.id,
          name: visibleState.self.name,
          budget: visibleState.self.budget,
          inventory: visibleState.self.inventory,
          wishlist: visibleState.self.wishlist,
          valuations: visibleState.self.valuations
        }
      : null,
    publicAgents: visibleState.publicAgents.map((agent) => ({
      id: agent.id,
      name: agent.name
    })),
    items: visibleState.items.map((item) => ({
      id: item.id,
      name: item.name
    })),
    openOffers: visibleState.openOffers.slice(0, 8).map((offer) => ({
      fromAgentId: offer.fromAgentId,
      toAgentId: offer.toAgentId,
      giveItemIds: offer.giveItemIds,
      requestItemIds: offer.requestItemIds,
      cashFromProposer: offer.cashFromProposer,
      message: offer.message
    })),
    recentAnnouncements,
    recentWhispers: visibleState.privateWhispers.slice(0, 8).map((event) => ({
      withAgentId: event.actorAgentId === visibleState.self?.id ? event.targetAgentId ?? "unknown" : event.actorAgentId ?? "unknown",
      text: event.content.replace(/^.+?:\s*/, "")
    })),
    recentTrades: visibleState.publicTradeEvents.slice(0, 8).map((event) => event.content),
    feasibleActions: buildFeasibleActions(visibleState, recentAnnouncements)
  };
}

function buildFeasibleActions(
  visibleState: AgentVisibleState,
  recentAnnouncements: AnnouncementContext[]
): CompactContext["feasibleActions"] {
  const self = visibleState.self;
  const itemNames = new Map(visibleState.items.map((item) => [item.id, item.name]));

  if (!self) {
    return {
      announcementBuyOptions: [],
      announcementSellOptions: [],
      relevantAnnouncements: []
    };
  }

  const inventorySet = new Set(self.inventory);
  const wishlistSet = new Set(self.wishlist);

  const announcementBuyOptions = self.wishlist
    .filter((itemId) => !inventorySet.has(itemId))
    .map((itemId) => ({
      itemId,
      itemName: itemNames.get(itemId) ?? itemId,
      maxPrice: Math.max(0, Math.min(self.budget, self.valuations[itemId] ?? self.budget)),
      reasoning: `Wanted item not in inventory. Never post above your cash or valuation cap.`
    }))
    .filter((option) => option.maxPrice > 0)
    .sort((left, right) => right.maxPrice - left.maxPrice);

  const announcementSellOptions = self.inventory
    .map((itemId) => ({
      itemId,
      itemName: itemNames.get(itemId) ?? itemId,
      minPrice: Math.max(0, self.valuations[itemId] ?? 0),
      reasoning: wishlistSet.has(itemId)
        ? "You already own this wanted item. Only sell if the price clearly beats keeping it."
        : "Owned item that can be sold if the market price is worth it."
    }))
    .sort((left, right) => right.minPrice - left.minPrice);

  const relevantAnnouncements: ActionableAnnouncementContext[] = [];

  for (const announcement of recentAnnouncements) {
    if (announcement.agentId === self.id) {
      continue;
    }

    const itemName = itemNames.get(announcement.itemId) ?? announcement.itemId;

    if (announcement.orderType === "buy" && inventorySet.has(announcement.itemId)) {
      relevantAnnouncements.push({
        agentId: announcement.agentId,
        orderType: announcement.orderType,
        itemId: announcement.itemId,
        itemName,
        price: announcement.price,
        note: announcement.note,
        responseMode: "sell-into-buy-order",
        reasoning: `You own ${announcement.itemId}, so you can sell into this posted buy order immediately.`,
        suggestedOffer: {
          giveItemIds: [announcement.itemId],
          requestItemIds: [],
          cashFromProposer: -announcement.price,
          message: `I can sell ${itemName} at your posted price.`
        }
      });
      continue;
    }

    if (announcement.orderType === "sell" && self.budget >= announcement.price) {
      relevantAnnouncements.push({
        agentId: announcement.agentId,
        orderType: announcement.orderType,
        itemId: announcement.itemId,
        itemName,
        price: announcement.price,
        note: announcement.note,
        responseMode: "buy-from-sell-order",
        reasoning: `You can afford this posted sell order right now.`,
        suggestedOffer: {
          giveItemIds: [],
          requestItemIds: [announcement.itemId],
          cashFromProposer: announcement.price,
          message: `I can buy ${itemName} at your posted price.`
        }
      });
    }
  }

  return {
    announcementBuyOptions,
    announcementSellOptions,
    relevantAnnouncements
  };
}

function buildTradeResponseGuidance(
  visibleContext: CompactContext,
  offer: {
    fromAgentId: string;
    giveItemIds: string[];
    requestItemIds: string[];
    cashFromProposer: number;
    message: string;
  }
): TradeResponseGuidance {
  const self = visibleContext.self;

  if (!self) {
    return {
      canAcceptNow: false,
      requestedItemIdsYouOwn: [],
      missingRequestedItemIds: offer.requestItemIds,
      cashDeltaToYou: offer.cashFromProposer,
      canCoverCashNow: false,
      valueYouReceive: 0,
      valueYouGive: 0,
      netValueEstimate: offer.cashFromProposer,
      blockers: ["Agent missing from visible context."]
    };
  }

  const inventorySet = new Set(self.inventory);
  const requestedItemIdsYouOwn = offer.requestItemIds.filter((itemId) => inventorySet.has(itemId));
  const missingRequestedItemIds = offer.requestItemIds.filter((itemId) => !inventorySet.has(itemId));
  const cashDeltaToYou = offer.cashFromProposer;
  const canCoverCashNow = cashDeltaToYou >= 0 || self.budget >= Math.abs(cashDeltaToYou);
  const valueYouReceive =
    offer.giveItemIds.reduce((total, itemId) => total + (self.valuations[itemId] ?? 0), 0) + cashDeltaToYou;
  const valueYouGive = offer.requestItemIds.reduce((total, itemId) => total + (self.valuations[itemId] ?? 0), 0);
  const blockers: string[] = [];

  if (missingRequestedItemIds.length > 0) {
    blockers.push(`You do not own: ${missingRequestedItemIds.join(", ")}.`);
  }

  if (!canCoverCashNow) {
    blockers.push(`You cannot cover the cash movement of $${Math.abs(cashDeltaToYou)}.`);
  }

  return {
    canAcceptNow: blockers.length === 0,
    requestedItemIdsYouOwn,
    missingRequestedItemIds,
    cashDeltaToYou,
    canCoverCashNow,
    valueYouReceive,
    valueYouGive,
    netValueEstimate: valueYouReceive - valueYouGive,
    blockers
  };
}

function buildActionPrompt(
  agentId: string,
  visibleContext: CompactContext,
  toolResults: string[],
  finalInstruction: string,
  phaseContext?: unknown
) {
  return [
    `Visible context:\n${JSON.stringify(visibleContext, null, 2)}`,
    phaseContext ? `Phase context:\n${JSON.stringify(phaseContext, null, 2)}` : null,
    toolResults.length > 0 ? `Tool results:\n${toolResults.join("\n\n")}` : "Tool results: none yet.",
    "Read self, feasibleActions, and phaseContext before choosing an action.",
    "Prefer feasibleActions and explicit phaseContext guidance over inventing facts or restating generic interest.",
    "Do not mention or offer items that are not grounded in self.inventory, feasibleActions, or the current offer.",
    "You may first request one of these tools, using JSON only:",
    '- {"type":"tool","tool":"announcement_mentions","query":"solar-lens"}',
    '- {"type":"tool","tool":"whisper_history","agentId":"toma"}',
    '- {"type":"tool","tool":"trade_feedback","query":"repair-kit"}',
    'Every action response must be one JSON object with a "type" field.',
    "Tool requests must be exact JSON with no surrounding prose.",
    "Return exactly one output only.",
    "Do not prefix with labels like JSON:, Answer:, Tool:, or Requesting tool:.",
    "Do not include explanations before or after the final JSON or keyword.",
    "Do not output multiple tool calls in one response.",
    "If you ask for a tool, do not also answer the phase in the same response.",
    "If you already have enough information, respond with the final action instead.",
    `Expected response format:\n${finalInstruction}`,
    buildIdentityFooter(agentId, visibleContext)
  ].filter(Boolean).join("\n\n");
}

function buildForcedFinalPrompt(
  agentId: string,
  visibleContext: CompactContext,
  toolResults: string[],
  finalInstruction: string,
  phaseContext?: unknown
) {
  return [
    `Visible context:\n${JSON.stringify(visibleContext, null, 2)}`,
    phaseContext ? `Phase context:\n${JSON.stringify(phaseContext, null, 2)}` : null,
    toolResults.length > 0 ? `Tool results:\n${toolResults.join("\n\n")}` : "Tool results: none yet.",
    "Your tool-request budget is exhausted.",
    "You must now choose the final action using only the information above.",
    "Use self, feasibleActions, and phaseContext as the source of truth.",
    "Do not ask for any tool.",
    'Return one JSON object with a "type" field.',
    "Return exactly one final output only.",
    "Do not include explanations before or after the final JSON or keyword.",
    `Expected response format:\n${finalInstruction}`,
    buildIdentityFooter(agentId, visibleContext)
  ].filter(Boolean).join("\n\n");
}

function executeInfoTool(visibleContext: CompactContext, agentId: string, request: InfoToolRequest) {
  switch (request.tool) {
    case "announcement_mentions": {
      const query = (request.query ?? "").toLowerCase().trim();
      const matches = visibleContext.recentAnnouncements
        .filter((event) =>
          [
            event.agentId,
            event.orderType,
            event.itemId,
            event.note ?? "",
            formatAnnouncementLine(event)
          ].some((field) => field.toLowerCase().includes(query))
        )
        .map((event) => formatAnnouncementLine(event));
      return formatToolResult(
        "announcement_mentions",
        matches
      );
    }
    case "whisper_history": {
      const targetAgentId = request.agentId ?? "";
      const matches = visibleContext.recentWhispers.filter(
        (event) => event.withAgentId === targetAgentId
      );
      return formatToolResult(
        "whisper_history",
        matches.map((event) => `${event.withAgentId}: ${event.text}`)
      );
    }
    case "trade_feedback": {
      const query = (request.query ?? request.agentId ?? agentId).toLowerCase().trim();
      const matches = visibleContext.recentTrades.filter((text) => text.toLowerCase().includes(query));
      return formatToolResult(
        "trade_feedback",
        matches
      );
    }
    default:
      return formatToolResult("unknown_tool", ["Unsupported tool request."]);
  }
}

function formatToolResult(tool: string, lines: string[]) {
  return [`Tool result: ${tool}`, ...(lines.length > 0 ? lines.slice(0, 6) : ["No recent matches found."])].join("\n");
}

function parseInfoToolRequest(value: string): InfoToolRequest | null {
  const payload = extractActionObject(value);

  if (!payload || payload.type !== "tool" || typeof payload.tool !== "string") {
    return null;
  }

  if (
    payload.tool !== "announcement_mentions" &&
    payload.tool !== "whisper_history" &&
    payload.tool !== "trade_feedback"
  ) {
    return null;
  }

  return {
    tool: payload.tool,
    query: typeof payload.query === "string" ? payload.query : undefined,
    agentId: typeof payload.agentId === "string" ? payload.agentId : undefined
  };
}

function parseAnnouncementPayload(value: string): AnnouncementPayload | null {
  const payload = extractActionObject(value);

  if (
    !payload ||
    payload.type !== "announcement" ||
    (payload.orderType !== "buy" && payload.orderType !== "sell") ||
    typeof payload.itemId !== "string"
  ) {
    return null;
  }

  const price = coerceNumber(payload.price);
  const itemId = payload.itemId.trim();
  const noteValue = typeof payload.note === "string" ? payload.note.trim() : "";

  if (price === null || price < 0 || !itemId) {
    return null;
  }

  return {
    orderType: payload.orderType,
    itemId,
    price,
    note: noteValue || null
  };
}

function parseWhisperStartPayload(value: string): WhisperStartPayload | null {
  const payload = extractActionObject(value);

  if (!payload || payload.type !== "whisper_start" || typeof payload.targetAgentId !== "string" || typeof payload.message !== "string") {
    return null;
  }

  const targetAgentId = payload.targetAgentId.trim();
  const message = payload.message.trim();

  if (!targetAgentId || !message) {
    return null;
  }

  if (payload.offer === undefined) {
    return { targetAgentId, message };
  }

  const offer = parseEmbeddedTradeOffer(payload.offer);
  if (!offer) {
    return null;
  }

  return { targetAgentId, message, offer };
}

function parseWhisperReplyPayload(value: string): WhisperReplyPayload | null {
  const payload = extractActionObject(value);

  if (!payload || payload.type !== "whisper_reply" || typeof payload.message !== "string") {
    return null;
  }

  const message = payload.message.trim();
  if (!message) {
    return null;
  }

  if (payload.offer === undefined) {
    return { message };
  }

  const offer = parseEmbeddedTradeOffer(payload.offer);
  if (!offer) {
    return null;
  }

  return { message, offer };
}

function parseTradeProposalPayload(value: string): TradeProposalPayload | null {
  const payload = extractActionObject(value);

  if (!payload || payload.type !== "trade_proposal" || typeof payload.targetAgentId !== "string" || typeof payload.message !== "string") {
    return null;
  }

  const cashFromProposer = coerceNumber(payload.cashFromProposer);
  if (cashFromProposer === null) {
    return null;
  }

  const giveItemIds = coerceStringArray(payload.giveItemIds);
  const requestItemIds = coerceStringArray(payload.requestItemIds);
  const targetAgentId = payload.targetAgentId.trim();
  const message = payload.message.trim();

  if (!targetAgentId || !message || !giveItemIds || !requestItemIds) {
    return null;
  }

  return {
    targetAgentId,
    giveItemIds,
    requestItemIds,
    cashFromProposer,
    message
  };
}

function parseEmbeddedTradeOffer(value: unknown): EmbeddedTradeOfferPayload | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const payload = value as Record<string, unknown>;
  const cashFromProposer = coerceNumber(payload.cashFromProposer);
  const giveItemIds = coerceStringArray(payload.giveItemIds);
  const requestItemIds = coerceStringArray(payload.requestItemIds);
  const message = typeof payload.message === "string" ? payload.message.trim() : "";

  if (cashFromProposer === null || !giveItemIds || !requestItemIds || !message) {
    return null;
  }

  return {
    giveItemIds,
    requestItemIds,
    cashFromProposer,
    message
  };
}

function parseAnnouncementEvent(event: { actorAgentId?: string; content: string }) {
  const payload = parseAnnouncementText(event.content);

  if (!payload || !event.actorAgentId) {
    return null;
  }

  return {
    agentId: event.actorAgentId,
    ...payload
  };
}

function parseAnnouncementText(content: string): AnnouncementPayload | null {
  const stripped = content.replace(/^.+? announced:\s*/, "").trim();
  const match = stripped.match(/^(BUY|SELL)\s+([a-z0-9-]+)\s+for\s+\$([0-9]+(?:\.[0-9]+)?)(?:\.\s*(.+))?$/i);

  if (!match) {
    return null;
  }

  const [, rawType, itemId, rawPrice, rawNote] = match;
  const price = Number(rawPrice);

  if (!Number.isFinite(price)) {
    return null;
  }

  return {
    orderType: rawType.toLowerCase() as "buy" | "sell",
    itemId,
    price,
    note: rawNote?.trim() || null
  };
}

function parseTradeResponseDecision(value: string) {
  const payload = extractActionObject(value);

  if (!payload) {
    return null;
  }

  if (payload.type === "accept") {
    return {
      decision: "accept" as const,
      reason: undefined
    };
  }

  if (payload.type !== "reject") {
    return null;
  }

  return {
    decision: "reject" as const,
    reason: typeof payload.reason === "string" ? payload.reason.trim() : undefined
  };
}

function isPass(value: string) {
  return matchesControlWord(value, "PASS");
}

function isDone(value: string) {
  return matchesControlWord(value, "DONE");
}

function isAccept(value: string) {
  return matchesControlWord(value, "ACCEPT");
}

function isTypedAction(value: string, expectedType: string) {
  const payload = extractActionObject(value);
  return payload?.type === expectedType;
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

function toMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown runtime error";
}

function sanitizeTraceSnippet(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 280) || "(empty response)";
}

function looksLikeToolRequest(value: string) {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("tool") ||
    normalized.includes("whisper history") ||
    normalized.includes("announcement mentions") ||
    normalized.includes("trade feedback") ||
    normalized.includes("announcement_mentions") ||
    normalized.includes("whisper_history") ||
    normalized.includes("trade_feedback")
  );
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

function buildToolRecoveryPrompt(agentId: string, visibleContext: CompactContext, candidate: string) {
  return [
    `Normalize ${agentId}'s candidate response into a tool request only if it is clearly asking for a tool.`,
    "Return exactly one of these outputs:",
    '{"type":"tool","tool":"announcement_mentions","query":"solar-lens"}',
    '{"type":"tool","tool":"whisper_history","agentId":"toma"}',
    '{"type":"tool","tool":"trade_feedback","query":"repair-kit"}',
    "FINAL",
    "Return FINAL if the candidate is not asking for one of the tools.",
    "Do not output multiple tool requests.",
    `Known agents:\n${formatAgentDirectory(visibleContext)}`,
    `Known items:\n${formatItemDirectory(visibleContext)}`,
    `Visible context:\n${JSON.stringify(visibleContext, null, 2)}`,
    `Candidate output:\n${candidate}`
  ].join("\n\n");
}

function buildAnnouncementRecoveryPrompt(agentId: string, visibleContext: CompactContext, candidate: string) {
  return [
    `Normalize ${agentId}'s announcement candidate into one allowed output.`,
    "Return exactly one of these outputs:",
    '{"type":"pass"}',
    '{"type":"announcement","orderType":"buy","itemId":"solar-lens","price":24,"note":"optional short public reason"}',
    "INVALID",
    "Announcements must be direct public buy or sell orders using exact item ids.",
    `Known items:\n${formatItemDirectory(visibleContext)}`,
    `Visible context:\n${JSON.stringify(visibleContext, null, 2)}`,
    `Candidate output:\n${candidate}`
  ].join("\n\n");
}

function buildWhisperStartRecoveryPrompt(agentId: string, visibleContext: CompactContext, candidate: string) {
  return [
    `Normalize ${agentId}'s whisper-start candidate into one allowed output.`,
    "Return exactly one of these outputs:",
    '{"type":"done"}',
    '{"type":"pass"}',
    '{"type":"whisper_start","targetAgentId":"iara","message":"I think we can help each other if you move quickly."}',
    '{"type":"whisper_start","targetAgentId":"iara","message":"I can close now if this works for you.","offer":{"giveItemIds":["reef-glass"],"requestItemIds":["solar-lens"],"cashFromProposer":2,"message":"Direct offer if you want to close now."}}',
    '{"type":"whisper_start","targetAgentId":"marlo","message":"I can fill your buy order if you still want it.","offer":{"giveItemIds":["solar-lens"],"requestItemIds":[],"cashFromProposer":-24,"message":"I will sell at your posted price."}}',
    "INVALID",
    "Use an exact public agent id for targetAgentId.",
    "If an offer is present, it targets the same whisper recipient and must use exact item ids.",
    "cashFromProposer may be negative when the counterpart should pay the proposer.",
    `Known agents:\n${formatAgentDirectory(visibleContext)}`,
    `Known items:\n${formatItemDirectory(visibleContext)}`,
    `Candidate output:\n${candidate}`
  ].join("\n\n");
}

function buildWhisperReplyRecoveryPrompt(agentId: string, visibleContext: CompactContext, candidate: string) {
  return [
    `Normalize ${agentId}'s whisper-reply candidate into one allowed output.`,
    "Return exactly one of these outputs:",
    '{"type":"pass"}',
    '{"type":"whisper_reply","message":"short private reply"}',
    '{"type":"whisper_reply","message":"I can close now if this works for you.","offer":{"giveItemIds":["repair-kit"],"requestItemIds":["amber-chip"],"cashFromProposer":0,"message":"Direct counteroffer if you want to close now."}}',
    '{"type":"whisper_reply","message":"I can fill your buy order at that number.","offer":{"giveItemIds":["amber-chip"],"requestItemIds":[],"cashFromProposer":-30,"message":"I will sell if you pay me."}}',
    "INVALID",
    "The message must stay short and private.",
    "If an offer is present, it targets the current counterpart and must use exact item ids.",
    "cashFromProposer may be negative when the counterpart should pay the proposer.",
    `Visible context:\n${JSON.stringify(visibleContext, null, 2)}`,
    `Candidate output:\n${candidate}`
  ].join("\n\n");
}

function buildTradeProposalRecoveryPrompt(agentId: string, visibleContext: CompactContext, candidate: string) {
  return [
    `Normalize ${agentId}'s trade proposal candidate into one allowed output.`,
    "Return exactly one of these outputs:",
    '{"type":"done"}',
    '{"type":"pass"}',
    '{"type":"trade_proposal","targetAgentId":"toma","giveItemIds":["saffron"],"requestItemIds":["repair-kit"],"cashFromProposer":8,"message":"Clean swap if you want speed."}',
    "INVALID",
    "Use exact public agent ids and exact item ids.",
    "Do not invent items or agents that are not listed below.",
    `Known agents:\n${formatAgentDirectory(visibleContext)}`,
    `Known items:\n${formatItemDirectory(visibleContext)}`,
    `Visible context:\n${JSON.stringify(visibleContext, null, 2)}`,
    `Candidate output:\n${candidate}`
  ].join("\n\n");
}

function buildTradeResponseRecoveryPrompt(agentId: string, visibleContext: CompactContext, candidate: string) {
  return [
    `Normalize ${agentId}'s trade-response candidate into one allowed output.`,
    "Return exactly one of these outputs:",
    '{"type":"accept"}',
    '{"type":"reject","reason":"short rejection reason"}',
    "INVALID",
    "Do not return plain text outside the JSON object.",
    `Visible context:\n${JSON.stringify(visibleContext, null, 2)}`,
    `Candidate output:\n${candidate}`
  ].join("\n\n");
}

function formatAgentDirectory(visibleContext: CompactContext) {
  return visibleContext.publicAgents.map((agent) => `- ${agent.id}: ${agent.name}`).join("\n");
}

function formatItemDirectory(visibleContext: CompactContext) {
  return visibleContext.items.map((item) => `- ${item.id}: ${item.name}`).join("\n");
}

function formatAnnouncementLine(announcement: CompactContext["recentAnnouncements"][number]) {
  const note = announcement.note ? `. ${announcement.note}` : "";
  return `${announcement.agentId}: ${announcement.orderType.toUpperCase()} ${announcement.itemId} for $${announcement.price}${note}`;
}

function buildIdentityFooter(agentId: string, visibleContext: CompactContext) {
  return [
    `Agent ID: ${agentId}`,
    `Agent Name: ${visibleContext.self?.name ?? agentId}`,
    "Complete the response as this exact agent."
  ].join("\n");
}

function buildAnnouncementActionSchema(includeTool: boolean) {
  return buildActionSchema(
    [
      {
        type: "announcement",
        properties: {
          orderType: { type: "string", enum: ["buy", "sell"] },
          itemId: { type: "string" },
          price: { type: "number" },
          note: { type: "string" }
        }
      },
      {
        type: "pass"
      }
    ],
    includeTool
  );
}

function buildWhisperStartActionSchema(includeTool: boolean) {
  return buildActionSchema(
    [
      {
        type: "done"
      },
      {
        type: "whisper_start",
        properties: {
          targetAgentId: { type: "string" },
          message: { type: "string" },
          offer: buildEmbeddedTradeOfferSchema()
        }
      },
      {
        type: "pass"
      }
    ],
    includeTool
  );
}

function buildWhisperReplyActionSchema(includeTool: boolean) {
  return buildActionSchema(
    [
      {
        type: "whisper_reply",
        properties: {
          message: { type: "string" },
          offer: buildEmbeddedTradeOfferSchema()
        }
      },
      {
        type: "pass"
      }
    ],
    includeTool
  );
}

function buildTradeProposalActionSchema(includeTool: boolean) {
  return buildActionSchema(
    [
      {
        type: "trade_proposal",
        properties: {
          targetAgentId: { type: "string" },
          ...buildStandaloneTradeOfferProperties()
        }
      },
      {
        type: "pass"
      },
      {
        type: "done"
      }
    ],
    includeTool
  );
}

function buildTradeResponseActionSchema(includeTool: boolean) {
  return buildActionSchema(
    [
      {
        type: "accept"
      },
      {
        type: "reject",
        properties: {
          reason: { type: "string" }
        }
      }
    ],
    includeTool
  );
}

function buildEmbeddedTradeOfferSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["giveItemIds", "requestItemIds", "cashFromProposer", "message"],
    properties: buildStandaloneTradeOfferProperties()
  };
}

function buildStandaloneTradeOfferProperties() {
  return {
    giveItemIds: { type: "array", items: { type: "string" } },
    requestItemIds: { type: "array", items: { type: "string" } },
    cashFromProposer: { type: "number" },
    message: { type: "string" }
  };
}

function buildActionSchema(
  finalActions: Array<{ type: string; properties?: Record<string, unknown> }>,
  includeTool: boolean
) {
  const properties: Record<string, unknown> = {};
  const typeValues = finalActions.map((action) => action.type);

  for (const action of finalActions) {
    Object.assign(properties, action.properties ?? {});
  }

  if (includeTool) {
    typeValues.push("tool");
    Object.assign(properties, {
      tool: {
        type: "string",
        enum: ["announcement_mentions", "whisper_history", "trade_feedback"]
      },
      query: { type: "string" },
      agentId: { type: "string" }
    });
  }

  return {
    type: "object",
    additionalProperties: false,
    required: ["type"],
    properties: {
      type: {
        type: "string",
        enum: typeValues
      },
      ...properties
    }
  };
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
