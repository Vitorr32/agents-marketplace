import React, { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";
import {
  Activity, Archive, ArrowLeftRight, BookOpen, Check, ChevronRight,
  CircleDot, Clock, Cpu, Download, Loader2, MessageSquare, Pause,
  Play, RefreshCw, RotateCcw, Search, Send, SkipForward, Trash2,
  Users, X,
} from "lucide-react";
import type { MarketState, SessionReplay, SessionSummary } from "@agents-marketplace/shared";

// --- types -------------------------------------------------------------------

type SimulationUpdate = { state: MarketState };

type LlmStreamUpdate = {
  streamId: string;
  agentId: string;
  tickCount: number;
  stage: "active";
  phase: "started" | "delta" | "completed" | "error";
  content: string;
  systemPrompt?: string;
  userPrompt?: string;
};

type LiveStream = LlmStreamUpdate & { updatedAt: number };

type ViewMode = "market" | "sessions";

// --- design tokens -----------------------------------------------------------

const PANEL =
  "backdrop-blur-xl bg-slate-900/80 border border-white/10 rounded-3xl shadow-2xl";

const CARD =
  "rounded-[18px] bg-white/5 border border-white/[0.08] p-3.5";

const BTN =
  "inline-flex items-center gap-1.5 rounded-full px-5 py-3 bg-gradient-to-br from-amber-400 to-orange-500 text-slate-900 font-bold text-sm cursor-pointer border-0 disabled:opacity-50 disabled:cursor-wait shrink-0";

const BTN_GHOST =
  "inline-flex items-center gap-1.5 rounded-full px-4 py-2.5 bg-white/[0.07] text-[#f4efe8] font-semibold text-sm cursor-pointer border-0 hover:bg-white/[0.12] transition-colors shrink-0";

const BTN_DANGER =
  "inline-flex items-center gap-1.5 rounded-full px-4 py-2.5 bg-gradient-to-br from-rose-500 to-orange-500 text-slate-900 font-bold text-sm cursor-pointer border-0 disabled:opacity-50 shrink-0";

const SIDEBAR_TAB =
  "flex flex-row items-center justify-start gap-2.5 px-3 py-5 min-h-[180px] w-11 rounded-3xl backdrop-blur-xl bg-slate-900/80 border border-white/10 shadow-2xl text-slate-400 text-[0.68rem] font-semibold uppercase tracking-[0.08em] cursor-pointer hover:bg-white/[0.08] hover:text-white transition-colors [writing-mode:vertical-rl]";

// --- helpers -----------------------------------------------------------------

const socket = io({ autoConnect: false });

function badgeClass(status?: string) {
  const base = "text-xs px-2 py-0.5 rounded-full font-medium shrink-0";
  switch (status) {
    case "open":
    case "started":
    case "delta":
    case "paused":
      return `${base} bg-sky-400/15 text-sky-300`;
    case "accepted":
    case "settled":
    case "completed":
      return `${base} bg-green-400/15 text-green-300`;
    case "rejected":
    case "invalid":
    case "error":
      return `${base} bg-red-400/20 text-red-300`;
    default:
      return `${base} bg-amber-400/20 text-amber-300`;
  }
}

function formatCash(cashFromProposer: number) {
  if (cashFromProposer === 0) return "Cash: none";
  if (cashFromProposer > 0) return `Proposer pays $${cashFromProposer}`;
  return `Counterpart pays $${Math.abs(cashFromProposer)}`;
}

function itemName(items: { id: string; name: string }[], id: string) {
  return items.find((i) => i.id === id)?.name ?? id;
}

function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function parseStreamContent(content: string): { type: string | null; message: string | null } {
  if (!content.trim()) return { type: null, message: null };
  try {
    const obj = JSON.parse(content) as Record<string, unknown>;
    return {
      type: typeof obj.type === "string" ? obj.type : null,
      message: typeof obj.message === "string" ? (obj.message as string).trim() : null,
    };
  } catch {
    return { type: null, message: null };
  }
}

function actionMeta(type: string | null): { label: string; color: string; icon: React.ReactNode } {
  switch (type) {
    case "pass":
      return { label: "Passed", color: "text-slate-400", icon: <ArrowLeftRight size={11} /> };
    case "make_offer":
      return { label: "Making offer", color: "text-sky-300", icon: <Send size={11} /> };
    case "accept":
      return { label: "Accepted", color: "text-green-300", icon: <Check size={11} /> };
    case "reject":
      return { label: "Rejected", color: "text-red-300", icon: <X size={11} /> };
    case "counter":
      return { label: "Counter-offer", color: "text-amber-300", icon: <RotateCcw size={11} /> };
    case "tool":
      return { label: "Using tool", color: "text-purple-300", icon: <Search size={11} /> };
    default:
      return { label: type ?? "", color: "text-slate-400", icon: null };
  }
}

function EventTypeIcon({ type }: { type: string }) {
  const sz = 13;
  switch (type) {
    case "offer":     return <ArrowLeftRight size={sz} className="shrink-0 text-sky-400" />;
    case "trade":     return <Check          size={sz} className="shrink-0 text-green-400" />;
    case "order":     return <Send           size={sz} className="shrink-0 text-amber-400" />;
    case "decision":  return <MessageSquare  size={sz} className="shrink-0 text-slate-500" />;
    case "tick":      return <Clock          size={sz} className="shrink-0 text-slate-600" />;
    default:          return <CircleDot      size={sz} className="shrink-0 text-slate-600" />;
  }
}

// --- StreamCard --------------------------------------------------------------

function StreamCard({ stream }: { stream: LiveStream }) {
  const parsed = useMemo(() => parseStreamContent(stream.content), [stream.content]);
  const meta = actionMeta(parsed.type);
  const isLive = stream.phase === "started" || stream.phase === "delta";

  return (
    <div className={`${CARD} !border-sky-400/25`}>

      {/* Header */}
      <div className="flex justify-between items-start gap-2 mb-2">
        <div className="flex items-center gap-1.5">
          <Cpu size={13} className="text-sky-400 shrink-0" />
          <strong className="text-sm">{stream.agentId}</strong>
        </div>
        <div className="flex items-center gap-1.5">
          {isLive && <Loader2 size={12} className="text-sky-400 animate-spin" />}
          <span className={badgeClass(stream.phase)}>{stream.phase}</span>
          <span className="text-slate-600 text-[0.65rem]">T{stream.tickCount}</span>
        </div>
      </div>

      {/* Body */}
      {stream.phase === "error" ? (
        <p className="m-0 mb-2 text-sm text-red-300">{stream.content}</p>
      ) : isLive ? (
        <p className="m-0 mb-2 text-[0.75rem] text-slate-500 italic">Agent is thinking…</p>
      ) : parsed.message ? (
        <div className="mb-2.5">
          {parsed.type && (
            <div className={`flex items-center gap-1 mb-1 text-[0.7rem] font-medium ${meta.color}`}>
              {meta.icon}
              {meta.label}
            </div>
          )}
          <p className="m-0 text-sm text-slate-200 leading-relaxed">
            {parsed.message}
          </p>
        </div>
      ) : parsed.type ? (
        <div className={`flex items-center gap-1 mb-2 text-sm font-medium ${meta.color}`}>
          {meta.icon}
          {meta.label}
        </div>
      ) : null}

      {/* Collapsible: raw LLM response */}
      {stream.content && (
        <details className="group">
          <summary className="list-none flex items-center gap-1 text-[0.7rem] text-slate-600 cursor-pointer hover:text-slate-400 select-none">
            <ChevronRight size={11} className="transition-transform group-open:rotate-90" />
            Raw LLM response
          </summary>
          <pre className="mt-1.5 whitespace-pre-wrap break-words font-mono text-[0.76rem] leading-relaxed text-sky-200/80 bg-black/30 rounded-xl p-2.5 overflow-x-auto">
            {stream.content}
          </pre>
        </details>
      )}

      {/* Collapsible: debug prompt */}
      {(stream.userPrompt || stream.systemPrompt) && (
        <details className="group mt-1">
          <summary className="list-none flex items-center gap-1 text-[0.7rem] text-slate-600 cursor-pointer hover:text-slate-400 select-none">
            <ChevronRight size={11} className="transition-transform group-open:rotate-90" />
            Debug: Prompt
          </summary>
          <div className="mt-1.5 flex flex-col gap-2">
            {stream.systemPrompt && (
              <div>
                <p className="m-0 mb-1 text-[0.62rem] uppercase tracking-wider text-slate-600">System</p>
                <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[0.74rem] leading-relaxed text-slate-400 bg-black/25 rounded-xl p-2">{stream.systemPrompt}</pre>
              </div>
            )}
            {stream.userPrompt && (
              <div>
                <p className="m-0 mb-1 text-[0.62rem] uppercase tracking-wider text-slate-600">User</p>
                <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[0.74rem] leading-relaxed text-slate-400 bg-black/25 rounded-xl p-2">{stream.userPrompt}</pre>
              </div>
            )}
          </div>
        </details>
      )}
    </div>
  );
}

// --- app ---------------------------------------------------------------------

export function App() {
  const [state, setState] = useState<MarketState | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedReplay, setSelectedReplay] = useState<SessionReplay | null>(null);
  const [liveStreams, setLiveStreams] = useState<Record<string, LiveStream>>({});
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<ViewMode>("market");
  const [agentsOpen, setAgentsOpen] = useState(true);
  const [offersOpen, setOffersOpen] = useState(true);

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
      setLiveStreams((cur) => {
        const next = {
          ...cur,
          [update.streamId]: { ...(cur[update.streamId] ?? {}), ...update, updatedAt: Date.now() },
        };
        return Object.fromEntries(
          Object.entries(next)
            .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
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
    const res = await fetch("/api/simulation");
    const snap = (await res.json()) as MarketState;
    setState(snap);
    await loadReplay(snap.sessionId);
  }

  async function loadSessions() {
    const res = await fetch("/api/sessions");
    setSessions((await res.json()) as SessionSummary[]);
  }

  async function loadReplay(sessionId: string) {
    const res = await fetch(`/api/sessions/${sessionId}/replay`);
    if (!res.ok) return;
    setSelectedReplay((await res.json()) as SessionReplay);
  }

  async function post(path: string) {
    setBusy(true);
    try {
      const res = await fetch(path, { method: "POST" });
      const snap = (await res.json()) as MarketState;
      setState(snap);
      await Promise.all([loadSessions(), loadReplay(snap.sessionId)]);
    } finally {
      setBusy(false);
    }
  }

  async function deleteSession(sessionId: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}`, { method: "DELETE" });
      if (!res.ok) return;
      if (selectedReplay?.session.id === sessionId) setSelectedReplay(null);
      await Promise.all([loadSessions(), loadInitialState()]);
    } finally {
      setBusy(false);
    }
  }

  async function downloadSession(sessionId: string) {
    const res = await fetch(`/api/sessions/${sessionId}/replay`);
    if (!res.ok) return;
    downloadJson(`session-${sessionId}.json`, await res.json());
  }

  function downloadFeed() {
    if (!state) return;
    downloadJson(`live-feed-${state.sessionId}.json`, {
      sessionId: state.sessionId,
      round: state.round,
      tickCount: state.tickCount,
      exportedAt: new Date().toISOString(),
      events: state.events,
      liveStreams: Object.values(liveStreams),
    });
  }

  const orderedStreams = useMemo(
    () => Object.values(liveStreams).sort((a, b) => b.updatedAt - a.updatedAt),
    [liveStreams]
  );

  if (!state) {
    return (
      <main className="flex items-center justify-center min-h-screen text-slate-400 text-lg">
        Loading simulation…
      </main>
    );
  }

  const stats: { label: string; value: string; icon: React.ReactNode }[] = [
    { label: "Round",  value: String(state.round),                    icon: <Play     size={12} /> },
    { label: "Ticks",  value: `${state.tickCount}/${state.maxTicks}`, icon: <Clock    size={12} /> },
    { label: "Turn",   value: state.turnAgentId,                      icon: <Activity size={12} /> },
    { label: "Status", value: state.status,                           icon: <CircleDot size={12} /> },
  ];

  return (
    <main className="w-full max-w-[1280px] mx-auto px-4 py-8">

      {/* Hero */}
      <section className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-4 items-end mb-6">
        <div>
          <p className="m-0 mb-2 text-[0.75rem] uppercase tracking-[0.14em] text-amber-400">
            Multi-agent barter sandbox
          </p>
          <h1 className="m-0 text-[clamp(2.2rem,5vw,4rem)] font-bold leading-[0.95]">
            Agents Marketplace
          </h1>
          <p className="mt-3 mb-0 text-slate-400 text-sm leading-relaxed max-w-xl">
            Every tick, agents make offers to each other, negotiate across ticks, and settle accepted trades immediately.
          </p>
        </div>

        <div className={`${PANEL} grid grid-cols-2 sm:grid-cols-4 gap-px overflow-hidden`}>
          {stats.map(({ label, value, icon }) => (
            <div className="px-4 py-3 bg-slate-900/60" key={label}>
              <span className="flex items-center gap-1 text-[0.7rem] uppercase tracking-wider text-slate-500">
                {icon} {label}
              </span>
              <strong className="block mt-1 text-base font-bold truncate">{value}</strong>
            </div>
          ))}
        </div>
      </section>

      {/* Completion banner */}
      {state.completionReason && (
        <p className="m-0 mb-4 px-4 py-3 rounded-2xl bg-amber-400/10 border border-amber-400/25 text-sm">
          {state.completionReason}
        </p>
      )}

      {/* Top bar */}
      <section className="flex flex-wrap justify-between items-center gap-3 mb-4">
        <div className="flex gap-2">
          <button className={view === "market" ? BTN : BTN_GHOST} onClick={() => setView("market")} type="button">
            <Activity size={14} /> Live Market
          </button>
          <button className={view === "sessions" ? BTN : BTN_GHOST} onClick={() => setView("sessions")} type="button">
            <Archive size={14} /> Sessions
          </button>
        </div>
        <button className={BTN_GHOST} onClick={downloadFeed} type="button">
          <Download size={14} /> Download Feed
        </button>
      </section>

      {view === "market" ? (
        <>
          {/* Controls */}
          <section className="flex flex-wrap gap-2 mb-5">
            <button
              className={BTN}
              disabled={busy || state.status === "completed"}
              onClick={() => void post("/api/simulation/step")}
              type="button"
            >
              <SkipForward size={14} /> Step
            </button>
            <button
              className={BTN}
              disabled={busy || state.status === "completed"}
              onClick={() => void post("/api/simulation/toggle-run")}
              type="button"
            >
              {state.isRunning ? <><Pause size={14} /> Pause</> : <><Play size={14} /> Run</>}
            </button>
            <button
              className={BTN}
              disabled={busy}
              onClick={() => void post("/api/simulation/reset")}
              type="button"
            >
              <RefreshCw size={14} /> New Session
            </button>
          </section>

          {/* 3-column layout */}
          <section className="grid grid-cols-1 lg:grid-cols-[auto_1fr_auto] gap-4 items-start">

            {/* Left: Agents */}
            {agentsOpen ? (
              <article className={`${PANEL} p-4 w-full lg:w-[280px]`}>
                <div className="flex justify-between items-center mb-4">
                  <h2 className="m-0 text-base font-bold flex items-center gap-2">
                    <Users size={15} className="text-slate-400"/> Agents
                  </h2>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-400 text-xs">{state.agents.length} active</span>
                    <button
                      className={BTN_GHOST}
                      onClick={() => setAgentsOpen(false)}
                      title="Collapse"
                      type="button"
                    >
                      <ChevronRight size={14} className="rotate-180" />
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-3">
                  {state.agents.map((agent) => {
                    const inventory = agent.inventory.map((id) => itemName(state.items, id));
                    const wishlist = agent.wishlist.map((id) => itemName(state.items, id));
                    const initial = state.initialAgents?.find((a) => a.id === agent.id);
                    const currentUtility = agent.inventory.reduce((s, id) => s + (agent.valuations[id] ?? 0), 0) + agent.budget;
                    const startUtility = initial
                      ? initial.inventory.reduce((s, id) => s + (initial.valuations[id] ?? 0), 0) + initial.budget
                      : currentUtility;
                    const utilityDelta = currentUtility - startUtility;
                    return (
                      <div className={CARD} key={agent.id}>
                        <div className="flex justify-between items-start gap-2 mb-1">
                          <h3 className="m-0 text-sm font-bold leading-snug">{agent.name}</h3>
                          <span className={badgeClass()}>${agent.budget}</span>
                        </div>
                        <p className="m-0 mb-2.5 text-[0.75rem] text-slate-400 leading-snug">{agent.persona}</p>
                        <div className="flex flex-col gap-1">
                          {[
                            { label: "Hold", items: inventory, empty: "empty" },
                            { label: "Want", items: wishlist,  empty: "none" },
                          ].map(({ label, items, empty }) => (
                            <div className="flex gap-2 text-[0.73rem]" key={label}>
                              <span className="w-[3.5rem] shrink-0 text-[0.62rem] uppercase tracking-wider font-semibold text-slate-500 pt-px">
                                {label}
                              </span>
                              <span className="text-slate-300">
                                {items.length > 0 ? items.join(", ") : <em className="text-slate-500">{empty}</em>}
                              </span>
                            </div>
                          ))}
                        </div>

                        {/* Utility bar */}
                        <div className="mt-2 flex items-center gap-2 text-[0.7rem]">
                          <span className="text-slate-500 font-semibold uppercase text-[0.6rem] tracking-wider">Utility</span>
                          <span className="text-slate-300 font-mono">${currentUtility}</span>
                          {utilityDelta !== 0 && (
                            <span className={utilityDelta > 0 ? "text-green-400 font-mono" : "text-red-400 font-mono"}>
                              {utilityDelta > 0 ? "+" : ""}{utilityDelta}
                            </span>
                          )}
                          {utilityDelta === 0 && <span className="text-slate-600 font-mono">+0</span>}
                        </div>

                        {/* Expandable details */}
                        <details className="group mt-2">
                          <summary className="list-none flex items-center gap-1 text-[0.7rem] text-slate-600 cursor-pointer hover:text-slate-400 select-none">
                            <ChevronRight size={11} className="transition-transform group-open:rotate-90" />
                            Valuations & Details
                          </summary>
                          <div className="mt-2 flex flex-col gap-1">
                            <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 gap-y-0.5 text-[0.68rem]">
                              <span className="text-slate-500 font-semibold uppercase text-[0.58rem] tracking-wider">Item</span>
                              <span className="text-slate-500 font-semibold uppercase text-[0.58rem] tracking-wider text-right">Value</span>
                              <span className="text-slate-500 font-semibold uppercase text-[0.58rem] tracking-wider text-right">Status</span>
                              {state.items.map((item) => {
                                const val = agent.valuations[item.id] ?? 0;
                                const owns = agent.inventory.includes(item.id);
                                const wants = agent.wishlist.includes(item.id);
                                const status = owns ? "held" : wants ? "wanted" : "—";
                                const statusColor = owns ? "text-green-400" : wants ? "text-amber-400" : "text-slate-600";
                                return (
                                  <React.Fragment key={item.id}>
                                    <span className="text-slate-300">{item.name}</span>
                                    <span className="text-slate-300 font-mono text-right">${val}</span>
                                    <span className={`${statusColor} text-right`}>{status}</span>
                                  </React.Fragment>
                                );
                              })}
                            </div>
                            {initial && (
                              <div className="mt-2 text-[0.65rem] text-slate-500 flex flex-col gap-0.5">
                                <span>Start: {initial.inventory.map((id) => itemName(state.items, id)).join(", ")} + ${initial.budget} = ${startUtility}</span>
                                <span>Now: {inventory.join(", ") || "empty"} + ${agent.budget} = ${currentUtility}</span>
                              </div>
                            )}
                          </div>
                        </details>
                      </div>
                    );
                  })}
                </div>
              </article>
            ) : (
              <button
                className={SIDEBAR_TAB}
                onClick={() => setAgentsOpen(true)}
                title="Expand agents"
                type="button"
                style={{textOrientation: "upright"}}
              >
                <span className="text-amber-400 font-bold text-sm [writing-mode:horizontal-tb]">
                  {state.agents.length}
                </span>
                <span>Agents</span>
              </button>
            )}

            {/* Center: Feed */}
            <article className={`${PANEL} p-4`}>
              <div className="flex justify-between items-baseline mb-4">
                <h2 className="m-0 text-base font-bold flex items-center gap-2">
                  <Activity size={15} className="text-slate-400" /> Market Feed
                </h2>
                <span className="text-slate-400 text-xs">{state.events.length} events</span>
              </div>

              <div className="flex flex-col gap-3 overflow-y-auto max-h-[70vh] pr-1">
                {orderedStreams.map((stream) => (
                  <StreamCard key={stream.streamId} stream={stream} />
                ))}

                {state.events.map((event) => (
                  <div className={CARD} key={event.id}>
                    <div className="flex items-center gap-2 mb-1">
                      <EventTypeIcon type={event.type} />
                      <strong className="text-sm capitalize flex-1">{event.type}</strong>
                      <span className="text-[0.7rem] text-slate-500 shrink-0">R{event.round}</span>
                    </div>
                    <p className="m-0 text-sm text-slate-300 leading-relaxed">{event.content}</p>
                  </div>
                ))}
              </div>
            </article>

            {/* Right: Offers */}
            {offersOpen ? (
              <article className={`${PANEL} p-4 w-full lg:w-[280px]`}>
                <div className="flex justify-between items-center mb-4">
                  <h2 className="m-0 text-base font-bold flex items-center gap-2">
                    <ArrowLeftRight size={15} className="text-slate-400" /> Offers
                  </h2>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-400 text-xs">
                      {state.offers.filter((o) => o.status === "open").length} open
                    </span>
                    <button
                      className={BTN_GHOST}
                      onClick={() => setOffersOpen(false)}
                      title="Collapse"
                      type="button"
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                </div>

                <div className="flex flex-col gap-3">
                  {state.offers.length === 0 && (
                    <p className="m-0 text-slate-500 text-sm">No offers yet.</p>
                  )}
                  {state.offers.map((offer) => (
                    <div className={CARD} key={offer.id}>
                      <div className="flex justify-between items-start gap-2 mb-1">
                        <strong className="text-sm leading-snug">
                          {offer.fromAgentId} → {offer.toAgentId}
                        </strong>
                        <span className={badgeClass(offer.status)}>{offer.status}</span>
                      </div>
                      {offer.message && (
                        <p className="m-0 mb-2 text-sm text-slate-300 leading-snug italic">{offer.message}</p>
                      )}
                      <div className="flex flex-col gap-0.5 text-[0.72rem] text-slate-400">
                        <span>Gives: {offer.giveItemIds.map((id) => itemName(state.items, id)).join(", ") || "nothing"}</span>
                        <span>Wants: {offer.requestItemIds.map((id) => itemName(state.items, id)).join(", ") || "nothing"}</span>
                        <span>{formatCash(offer.cashFromProposer)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </article>
            ) : (
              <button
                className={SIDEBAR_TAB}
                onClick={() => setOffersOpen(true)}
                title="Expand offers"
                type="button"
                style={{ textOrientation: "upright"}}
              >
                <span className="text-amber-400 font-bold text-sm [writing-mode:horizontal-tb]">
                  {state.offers.filter((o) => o.status === "open").length}
                </span>
                <span>Offers</span>
              </button>
            )}
          </section>
        </>
      ) : (
        /* Session Library */
        <section className="grid grid-cols-1 lg:grid-cols-[minmax(300px,400px)_1fr] gap-4">

          <article className={`${PANEL} p-4`}>
            <div className="flex justify-between items-baseline mb-4">
              <h2 className="m-0 text-base font-bold flex items-center gap-2">
                <Archive size={15} className="text-slate-400" /> Session Library
              </h2>
              <span className="text-slate-400 text-xs">{sessions.length} stored</span>
            </div>

            <div className="flex flex-col gap-3">
              {sessions.map((session) => (
                <div className="flex flex-col gap-2" key={session.id}>
                  <button
                    className={`${CARD} text-left w-full cursor-pointer hover:bg-white/10 transition-colors ${
                      selectedReplay?.session.id === session.id ? "!border-amber-400/60" : ""
                    }`}
                    onClick={() => void loadReplay(session.id)}
                    type="button"
                  >
                    <div className="flex justify-between items-start gap-2 mb-1">
                      <strong className="text-sm">{session.name}</strong>
                      <span className={badgeClass(session.status)}>{session.status}</span>
                    </div>
                    <div className="flex gap-3 text-[0.72rem] text-slate-400">
                      <span>Ticks: {session.tickCount}/{session.maxTicks}</span>
                      <span>Round: {session.round}</span>
                    </div>
                  </button>

                  <div className="flex gap-2">
                    <button className={BTN_GHOST} onClick={() => void downloadSession(session.id)} type="button">
                      <Download size={13} /> Download
                    </button>
                    <button className={BTN_DANGER} disabled={busy} onClick={() => void deleteSession(session.id)} type="button">
                      <Trash2 size={13} /> Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </article>

          <article className={`${PANEL} p-4`}>
            <div className="flex justify-between items-baseline mb-4">
              <h2 className="m-0 text-base font-bold flex items-center gap-2">
                <BookOpen size={15} className="text-slate-400" /> Replay Log
              </h2>
              <span className="text-slate-400 text-xs">{selectedReplay?.events.length ?? 0} events</span>
            </div>

            {selectedReplay ? (
              <div className="flex flex-col gap-3 overflow-y-auto max-h-[70vh]">
                <div className={CARD}>
                  <div className="flex justify-between items-start gap-2 mb-1">
                    <strong className="text-sm">{selectedReplay.session.name}</strong>
                    <span className={badgeClass(selectedReplay.session.status)}>
                      {selectedReplay.session.status}
                    </span>
                  </div>
                  <p className="m-0 text-[0.72rem] text-slate-400">
                    {selectedReplay.session.tickCount}/{selectedReplay.session.maxTicks} ticks
                  </p>
                  {selectedReplay.session.completionReason && (
                    <p className="mt-1 mb-0 text-[0.72rem] text-slate-400">
                      {selectedReplay.session.completionReason}
                    </p>
                  )}
                </div>

                {selectedReplay.events.map((event) => (
                  <div className={CARD} key={event.id}>
                    <div className="flex items-center gap-2 mb-1">
                      <EventTypeIcon type={event.type} />
                      <strong className="text-sm capitalize flex-1">{event.type}</strong>
                      <span className="text-[0.68rem] text-slate-500 shrink-0">{event.createdAt}</span>
                    </div>
                    <p className="m-0 text-sm text-slate-300 leading-relaxed">{event.content}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-slate-400 text-sm m-0">
                Select a session on the left to inspect its replay log.
              </p>
            )}
          </article>
        </section>
      )}
    </main>
  );
}