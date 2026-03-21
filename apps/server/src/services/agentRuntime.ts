import {
  canAgentAffordCash,
  chooseFallbackAction,
  computeVisibleStateForAgent,
  findAgentById,
  isAgentAction,
  type MarketState,
  type SimulationAction
} from "@agents-marketplace/engine";

type RuntimeConfig = {
  agentRuntimeMode: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
};

type RuntimeResult = {
  action: SimulationAction;
  trace: string;
};

export class AgentRuntime {
  constructor(private readonly runtimeConfig: RuntimeConfig) {}

  async chooseAction(state: MarketState, agentId: string): Promise<RuntimeResult> {
    const agent = findAgentById(state, agentId);

    if (!agent) {
      return {
        action: { type: "pass", agentId, reasoning: "Agent no longer exists." },
        trace: "Agent missing from state."
      };
    }

    if (this.runtimeConfig.agentRuntimeMode !== "ollama") {
      return {
        action: chooseFallbackAction(state, agentId),
        trace: "Heuristic runtime selected via configuration."
      };
    }

    const visibleState = computeVisibleStateForAgent(state, agentId);
    const prompt = buildPrompt(visibleState);

    try {
      const response = await fetch(`${this.runtimeConfig.ollamaBaseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.runtimeConfig.ollamaModel,
          prompt,
          stream: false,
          format: "json",
          options: {
            temperature: 0.9
          }
        })
      });

      if (!response.ok) {
        throw new Error(`Ollama returned ${response.status}`);
      }

      const payload = (await response.json()) as { response?: string };
      const parsed = JSON.parse(payload.response ?? "{}") as unknown;

      if (!isAgentAction(parsed, agentId)) {
        throw new Error("Model produced invalid action schema.");
      }

      if ("cashFromProposer" in parsed && !canAgentAffordCash(state, agentId, parsed.cashFromProposer)) {
        throw new Error("Model proposed unaffordable cash offer.");
      }

      return {
        action: parsed,
        trace: "Ollama action accepted."
      };
    } catch (error) {
      const fallback = chooseFallbackAction(state, agentId);
      const message = error instanceof Error ? error.message : "Unknown runtime error";

      return {
        action: fallback,
        trace: `Fell back to heuristic runtime: ${message}`
      };
    }
  }
}

function buildPrompt(visibleState: ReturnType<typeof computeVisibleStateForAgent>) {
  return [
    "You are negotiating in a simulated trading market.",
    "You may bluff, lie, and scheme in announce and whisper messages.",
    "You may not invent inventory, cash, or offers in the structured action.",
    "Return JSON only with one of these actions:",
    JSON.stringify(
      {
        announce: {
          type: "announce",
          agentId: visibleState.self?.id,
          content: "public message"
        },
        whisper: {
          type: "whisper",
          agentId: visibleState.self?.id,
          toAgentId: "target-agent-id",
          content: "private message"
        },
        propose_trade: {
          type: "propose_trade",
          agentId: visibleState.self?.id,
          toAgentId: "target-agent-id",
          giveItemIds: ["item-id-you-own"],
          requestItemIds: ["item-id-they-own"],
          cashFromProposer: 0,
          message: "persuasive pitch"
        },
        accept_trade: {
          type: "accept_trade",
          agentId: visibleState.self?.id,
          offerId: "open-offer-id"
        },
        reject_trade: {
          type: "reject_trade",
          agentId: visibleState.self?.id,
          offerId: "open-offer-id",
          reason: "short reason"
        },
        pass: {
          type: "pass",
          agentId: visibleState.self?.id,
          reasoning: "why you wait"
        }
      },
      null,
      2
    ),
    "Market snapshot:",
    JSON.stringify(visibleState, null, 2)
  ].join("\n\n");
}
