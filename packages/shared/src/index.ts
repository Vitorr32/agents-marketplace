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

export type TradeOffer = {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  giveItemIds: string[];
  requestItemIds: string[];
  cashFromProposer: number;
  status: "open" | "accepted" | "rejected";
  message: string;
  createdAt: string;
};

export type MarketEvent = {
  id: string;
  round: number;
  type: "system" | "announce" | "whisper" | "offer" | "trade" | "decision";
  visibility: "public" | "private";
  actorAgentId?: string;
  targetAgentId?: string;
  content: string;
  createdAt: string;
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
  offers: TradeOffer[];
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

export type SimulationAction =
  | {
      type: "announce";
      agentId: string;
      content: string;
    }
  | {
      type: "whisper";
      agentId: string;
      toAgentId: string;
      content: string;
    }
  | {
      type: "propose_trade";
      agentId: string;
      toAgentId: string;
      giveItemIds: string[];
      requestItemIds: string[];
      cashFromProposer: number;
      message: string;
    }
  | {
      type: "accept_trade";
      agentId: string;
      offerId: string;
    }
  | {
      type: "reject_trade";
      agentId: string;
      offerId: string;
      reason: string;
    }
  | {
      type: "pass";
      agentId: string;
      reasoning: string;
    };
