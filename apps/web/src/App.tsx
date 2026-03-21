import { useEffect, useState } from "react";
import { io } from "socket.io-client";
import type { MarketState, SessionReplay, SessionSummary } from "@agents-marketplace/shared";

type SimulationUpdate = {
  state: MarketState;
};

type LlmStreamUpdate = {
  streamId: string;
  agentId: string;
  tickCount: number;
  stage: "announcement" | "whisper-init" | "whisper-reply" | "trade-proposal" | "trade-response";
  phase: "started" | "delta" | "completed" | "error";
  content: string;
};

type LiveStream = LlmStreamUpdate & {
  updatedAt: number;
};

const socket = io({
  autoConnect: false
});

export function App() {
  const [state, setState] = useState<MarketState | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedReplay, setSelectedReplay] = useState<SessionReplay | null>(null);
  const [liveStreams, setLiveStreams] = useState<Record<string, LiveStream>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void Promise.all([loadInitialState(), loadSessions()]);

    socket.connect();
    socket.on("simulation:update", (update: SimulationUpdate) => {
      setState(update.state);

      if (update.state.tickCount % 5 === 0 || update.state.status === "completed") {
        void loadSessions();
      }
    });
    socket.on("simulation:llm-stream", (update: LlmStreamUpdate) => {
      setLiveStreams((current) => {
        const next = {
          ...current,
          [update.streamId]: {
            ...update,
            updatedAt: Date.now()
          }
        };

        return Object.fromEntries(
          Object.entries(next)
            .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
            .slice(0, 12)
        );
      });
    });

    return () => {
      socket.off("simulation:update");
      socket.off("simulation:llm-stream");
      socket.disconnect();
    };
  }, []);

  async function loadInitialState() {
    const response = await fetch("/api/simulation");
    const snapshot = (await response.json()) as MarketState;
    setState(snapshot);
    await loadReplay(snapshot.sessionId);
  }

  async function loadSessions() {
    const response = await fetch("/api/sessions");
    const payload = (await response.json()) as SessionSummary[];
    setSessions(payload);
  }

  async function loadReplay(sessionId: string) {
    const response = await fetch(`/api/sessions/${sessionId}/replay`);

    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as SessionReplay;
    setSelectedReplay(payload);
  }

  async function post(path: string) {
    setBusy(true);
    try {
      const response = await fetch(path, { method: "POST" });
      const snapshot = (await response.json()) as MarketState;
      setState(snapshot);
      await loadSessions();
      await loadReplay(snapshot.sessionId);
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return <main className="shell">Loading simulation...</main>;
  }

  const orderedStreams = Object.values(liveStreams).sort((left, right) => right.updatedAt - left.updatedAt);

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <p className="eyebrow">Multi-agent barter sandbox</p>
          <h1>Agents Marketplace</h1>
          <p className="lede">
            Every tick, all agents act under imperfect information and the backend settles accepted trades.
          </p>
        </div>

        <div className="hero-panel">
          <div className="stat">
            <span>Round</span>
            <strong>{state.round}</strong>
          </div>
          <div className="stat">
            <span>Ticks</span>
            <strong>
              {state.tickCount}/{state.maxTicks}
            </strong>
          </div>
          <div className="stat">
            <span>Phase</span>
            <strong>{state.turnAgentId}</strong>
          </div>
          <div className="stat">
            <span>Status</span>
            <strong>{state.status}</strong>
          </div>
        </div>
      </section>

      {state.completionReason ? <p className="banner">{state.completionReason}</p> : null}

      <section className="controls">
        <button disabled={busy || state.status === "completed"} onClick={() => void post("/api/simulation/step")}>
          Step
        </button>
        <button disabled={busy || state.status === "completed"} onClick={() => void post("/api/simulation/toggle-run")}>
          {state.isRunning ? "Pause" : "Run"}
        </button>
        <button disabled={busy} onClick={() => void post("/api/simulation/reset")}>
          New Session
        </button>
      </section>

      <section className="grid">
        <article className="panel">
          <div className="panel-head">
            <h2>Agents</h2>
            <span>
              {state.agents.length} active, {state.doneAgentIds.length} done this tick
            </span>
          </div>

          <div className="agent-list">
            {state.agents.map((agent) => (
              <div className="agent-card" key={agent.id}>
                <div className="agent-row">
                  <h3>{agent.name}</h3>
                  <span className="badge">${agent.budget}</span>
                </div>
                <p>{agent.persona}</p>
                <div className="meta">
                  <span>Inventory: {agent.inventory.length}</span>
                  <span>Wishlist: {agent.wishlist.slice(0, 2).join(", ")}</span>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="panel">
          <div className="panel-head">
            <h2>Open Offers</h2>
            <span>{state.offers.filter((offer) => offer.status === "open").length} live</span>
          </div>

          <div className="offer-list">
            {state.offers.length === 0 && <p className="empty">No trade offers yet.</p>}

            {state.offers.map((offer) => (
              <div className="offer-card" key={offer.id}>
                <div className="agent-row">
                  <strong>
                    {offer.fromAgentId} -&gt; {offer.toAgentId}
                  </strong>
                  <span className={`badge badge-${offer.status}`}>{offer.status}</span>
                </div>
                <p>{offer.message}</p>
                <div className="meta">
                  <span>Gives: {offer.giveItemIds.join(", ") || "nothing"}</span>
                  <span>Wants: {offer.requestItemIds.join(", ") || "nothing"}</span>
                  <span>Cash: ${offer.cashFromProposer}</span>
                </div>
              </div>
            ))}
          </div>
        </article>

        <article className="panel">
          <div className="panel-head">
            <h2>Market Feed</h2>
            <span>{state.events.length} live events</span>
          </div>

          <div className="feed">
            {orderedStreams.map((stream) => (
              <div className="feed-item stream-item" key={stream.streamId}>
                <div className="agent-row">
                  <strong>
                    {stream.agentId} {stream.stage}
                  </strong>
                  <span className={`badge badge-${stream.phase}`}>{stream.phase}</span>
                </div>
                <p className="stream-meta">Tick {stream.tickCount}</p>
                <pre className="stream-content">{stream.content || "Waiting for tokens..."}</pre>
              </div>
            ))}

            {state.events.map((event) => (
              <div className="feed-item" key={event.id}>
                <div className="agent-row">
                  <strong>{event.type}</strong>
                  <span>R{event.round}</span>
                </div>
                <p>{event.content}</p>
              </div>
            ))}
          </div>
        </article>

        <article className="panel">
          <div className="panel-head">
            <h2>Saved Sessions</h2>
            <span>{sessions.length} stored</span>
          </div>

          <div className="feed">
            {sessions.map((session) => (
              <button
                className={`session-card ${selectedReplay?.session.id === session.id ? "session-card-active" : ""}`}
                key={session.id}
                onClick={() => void loadReplay(session.id)}
                type="button"
              >
                <div className="agent-row">
                  <strong>{session.name}</strong>
                  <span className={`badge badge-${session.status}`}>{session.status}</span>
                </div>
                <div className="meta">
                  <span>
                    Ticks: {session.tickCount}/{session.maxTicks}
                  </span>
                  <span>Round: {session.round}</span>
                </div>
              </button>
            ))}
          </div>
        </article>

        <article className="panel replay-panel">
          <div className="panel-head">
            <h2>Replay Log</h2>
            <span>{selectedReplay?.events.length ?? 0} persisted events</span>
          </div>

          {selectedReplay ? (
            <div className="feed">
              <div className="feed-item">
                <div className="agent-row">
                  <strong>{selectedReplay.session.name}</strong>
                  <span>{selectedReplay.session.status}</span>
                </div>
                <p>
                  {selectedReplay.session.tickCount}/{selectedReplay.session.maxTicks} ticks
                </p>
                {selectedReplay.session.completionReason ? <p>{selectedReplay.session.completionReason}</p> : null}
              </div>

              {selectedReplay.events.map((event) => (
                <div className="feed-item" key={event.id}>
                  <div className="agent-row">
                    <strong>{event.type}</strong>
                    <span>{event.createdAt}</span>
                  </div>
                  <p>{event.content}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty">Select a stored session to inspect its replay log.</p>
          )}
        </article>
      </section>
    </main>
  );
}
