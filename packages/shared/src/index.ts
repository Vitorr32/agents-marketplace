export type AgentProfile = {
  id: string;
  name: string;
  persona: string;
  budget: number;
  inventory: string[];
  wishlist: string[];
  valuations: Record<string, number>;
};

export type Item = {
  id: string;
  name: string;
  description: string;
  category: string;
};

export type TradeOfferStatus = "open" | "accepted" | "rejected" | "settled" | "invalid";

export type TradeOffer = {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  giveItemIds: string[];
  requestItemIds: string[];
  cashFromProposer: number;
  status: TradeOfferStatus;
  message: string;
  createdAt: string;
  respondedAt?: string;
  settledAt?: string;
  inResponseToOfferId?: string;
};

export type MarketOrderStatus = "open" | "filled" | "cancelled";

export type MarketOrder = {
  id: string;
  agentId: string;
  type: "buy" | "sell";
  itemId: string;
  price: number;
  status: MarketOrderStatus;
  createdAt: string;
};

export type MarketEvent = {
  id: string;
  round: number;
  type: "system" | "tick" | "announce" | "whisper" | "offer" | "trade" | "decision" | "order";
  visibility: "public" | "private";
  actorAgentId?: string;
  targetAgentId?: string;
  content: string;
  createdAt: string;
};

export type OfferResponseIntent = {
  offerId: string;
  decision: "accept" | "reject";
  reason: string;
};

export type TradeOfferIntent = {
  toAgentId: string;
  giveItemIds: string[];
  requestItemIds: string[];
  cashFromProposer: number;
  message: string;
};

export type WhisperIntent = {
  toAgentId: string;
  content: string;
};

export type AgentTickPlan = {
  agentId: string;
  announce?: string;
  whispers: WhisperIntent[];
  offer?: TradeOfferIntent;
  responses: OfferResponseIntent[];
  doneTrading: boolean;
  reasoning: string;
};

export type MarketState = {
  sessionId: string;
  sessionName: string;
  round: number;
  tickCount: number;
  maxTicks: number;
  isRunning: boolean;
  status: "paused" | "running" | "completed";
  completionReason?: string;
  turnAgentId: string;
  doneAgentIds: string[];
  items: Item[];
  agents: AgentProfile[];
  initialAgents?: AgentProfile[];
  offers: TradeOffer[];
  orders: MarketOrder[];
  events: MarketEvent[];
};

export type SessionSummary = {
  id: string;
  name: string;
  round: number;
  tickCount: number;
  maxTicks: number;
  status: "paused" | "running" | "completed";
  completionReason?: string;
  createdAt: string;
  updatedAt: string;
};

export type SessionReplay = {
  session: SessionSummary;
  events: MarketEvent[];
};
