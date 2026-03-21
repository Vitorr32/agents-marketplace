import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import type { MarketEvent, MarketState, SessionReplay, SessionSummary } from "@agents-marketplace/shared";

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

type ViewMode = "market" | "sessions";

type WhisperWindow = {
  id: string;
  leftAgentId: string;
  rightAgentId: string;
  events: MarketEvent[];
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
  const [view, setView] = useState<ViewMode>("market");

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
            ...(current[update.streamId] ?? {}),
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

  async function deleteSession(sessionId: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });

      if (!response.ok) {
        return;
      }

      if (selectedReplay?.session.id === sessionId) {
        setSelectedReplay(null);
      }

      await Promise.all([loadSessions(), loadInitialState()]);
    } finally {
      setBusy(false);
    }
  }

  async function downloadSession(sessionId: string) {
    const response = await fetch(`/api/sessions/${sessionId}/replay`);

    if (!response.ok) {
      return;
    }

    const payload = (await response.json()) as SessionReplay;
    downloadJson(`session-${sessionId}.json`, payload);
  }

  function downloadFeed() {
    if (!state) {
      return;
    }

    downloadJson(`live-feed-${state.sessionId}.json`, {
      sessionId: state.sessionId,
      round: state.round,
      tickCount: state.tickCount,
      exportedAt: new Date().toISOString(),
      events: state.events,
      liveStreams: Object.values(liveStreams)
    });
  }

  const orderedStreams = useMemo(
    () => Object.values(liveStreams).sort((left, right) => right.updatedAt - left.updatedAt),
    [liveStreams]
  );

  const whisperWindows = useMemo(() => {
    if (!state) {
      return [];
    }

    const grouped = new Map<string, WhisperWindow>();

    for (const event of state.events) {
      if (event.type !== "whisper" || !event.actorAgentId || !event.targetAgentId) {
        continue;
      }

      const [leftAgentId, rightAgentId] = [event.actorAgentId, event.targetAgentId].sort();
      const id = `${leftAgentId}::${rightAgentId}`;
      const existing = grouped.get(id);

      if (existing) {
        existing.events.push(event);
      } else {
        grouped.set(id, {
          id,
          leftAgentId,
          rightAgentId,
          events: [event]
        });
      }
    }

    return [...grouped.values()]
      .map((window) => ({
        ...window,
        events: window.events.sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(-8)
      }))
      .sort((left, right) => {
        const leftTimestamp = left.events[left.events.length - 1]?.createdAt ?? "";
        const rightTimestamp = right.events[right.events.length - 1]?.createdAt ?? "";
        return rightTimestamp.localeCompare(leftTimestamp);
      })
      .slice(0, 3);
  }, [state]);

  if (!state) {
    return <main className="shell">Loading simulation...</main>;
  }

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

      <section className="topbar">
        <div className="tabbar">
          <button
            className={view === "market" ? "tab-button tab-button-active" : "tab-button"}
            onClick={() => setView("market")}
            type="button"
          >
            Live Market
          </button>
          <button
            className={view === "sessions" ? "tab-button tab-button-active" : "tab-button"}
            onClick={() => setView("sessions")}
            type="button"
          >
            Session Library
          </button>
        </div>

        <div className="top-actions">
          <button onClick={downloadFeed} type="button">
            Download Feed
          </button>
        </div>
      </section>

      {view === "market" ? (
        <>
          <section className="controls">
            <button disabled={busy || state.status === "completed"} onClick={() => void post("/api/simulation/step")}>
              Step
            </button>
            <button
              disabled={busy || state.status === "completed"}
              onClick={() => void post("/api/simulation/toggle-run")}
            >
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
          </section>
        </>
      ) : (
        <section className="library-layout">
          <article className="panel">
            <div className="panel-head">
              <h2>Session Library</h2>
              <span>{sessions.length} stored</span>
            </div>

            <div className="feed">
              {sessions.map((session) => (
                <div className="session-library-card" key={session.id}>
                  <button
                    className={`session-card ${selectedReplay?.session.id === session.id ? "session-card-active" : ""}`}
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

                  <div className="session-actions">
                    <button onClick={() => void downloadSession(session.id)} type="button">
                      Download
                    </button>
                    <button className="danger-button" disabled={busy} onClick={() => void deleteSession(session.id)} type="button">
                      Delete
                    </button>
                  </div>
                </div>
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
      )}

      <section className="whisper-dock">
        {whisperWindows.map((window) => (
          <aside className="whisper-window" key={window.id}>
            <div className="whisper-head">
              <strong>
                {window.leftAgentId} / {window.rightAgentId}
              </strong>
              <span>DM</span>
            </div>

            <div className="whisper-messages">
              {window.events.map((event) => {
                const isLeft = event.actorAgentId === window.leftAgentId;

                return (
                  <div className={isLeft ? "whisper-bubble whisper-bubble-left" : "whisper-bubble whisper-bubble-right"} key={event.id}>
                    <span className="whisper-author">{event.actorAgentId}</span>
                    <p>{event.content.replace(/^.+?: /, "")}</p>
                  </div>
                );
              })}
            </div>
          </aside>
        ))}
      </section>
    </main>
  );
}

function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
