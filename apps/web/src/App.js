import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from "react";
import { io } from "socket.io-client";
const socket = io({
    autoConnect: false
});
export function App() {
    const [state, setState] = useState(null);
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        void loadInitialState();
        socket.connect();
        socket.on("simulation:update", (update) => {
            setState(update.state);
        });
        return () => {
            socket.off("simulation:update");
            socket.disconnect();
        };
    }, []);
    async function loadInitialState() {
        const response = await fetch("/api/simulation");
        const snapshot = (await response.json());
        setState(snapshot);
    }
    async function post(path) {
        setBusy(true);
        try {
            const response = await fetch(path, { method: "POST" });
            const snapshot = (await response.json());
            setState(snapshot);
        }
        finally {
            setBusy(false);
        }
    }
    if (!state) {
        return _jsx("main", { className: "shell", children: "Loading simulation..." });
    }
    return (_jsxs("main", { className: "shell", children: [_jsxs("section", { className: "hero", children: [_jsxs("div", { children: [_jsx("p", { className: "eyebrow", children: "Multi-agent barter sandbox" }), _jsx("h1", { children: "Agents Marketplace" }), _jsx("p", { className: "lede", children: "Agents negotiate, bluff, whisper, and trade under deterministic market rules." })] }), _jsxs("div", { className: "hero-panel", children: [_jsxs("div", { className: "stat", children: [_jsx("span", { children: "Round" }), _jsx("strong", { children: state.round })] }), _jsxs("div", { className: "stat", children: [_jsx("span", { children: "Turn" }), _jsx("strong", { children: state.turnAgentId })] }), _jsxs("div", { className: "stat", children: [_jsx("span", { children: "Mode" }), _jsx("strong", { children: state.isRunning ? "Running" : "Paused" })] })] })] }), _jsxs("section", { className: "controls", children: [_jsx("button", { disabled: busy, onClick: () => void post("/api/simulation/step"), children: "Step" }), _jsx("button", { disabled: busy, onClick: () => void post("/api/simulation/toggle-run"), children: state.isRunning ? "Pause" : "Run" }), _jsx("button", { disabled: busy, onClick: () => void post("/api/simulation/reset"), children: "Reset" })] }), _jsxs("section", { className: "grid", children: [_jsxs("article", { className: "panel", children: [_jsxs("div", { className: "panel-head", children: [_jsx("h2", { children: "Agents" }), _jsxs("span", { children: [state.agents.length, " active negotiators"] })] }), _jsx("div", { className: "agent-list", children: state.agents.map((agent) => (_jsxs("div", { className: "agent-card", children: [_jsxs("div", { className: "agent-row", children: [_jsx("h3", { children: agent.name }), _jsxs("span", { className: "badge", children: ["$", agent.budget] })] }), _jsx("p", { children: agent.persona }), _jsxs("div", { className: "meta", children: [_jsxs("span", { children: ["Inventory: ", agent.inventory.length] }), _jsxs("span", { children: ["Wishlist: ", agent.wishlist.slice(0, 2).join(", ")] })] })] }, agent.id))) })] }), _jsxs("article", { className: "panel", children: [_jsxs("div", { className: "panel-head", children: [_jsx("h2", { children: "Open Offers" }), _jsxs("span", { children: [state.offers.filter((offer) => offer.status === "open").length, " live"] })] }), _jsxs("div", { className: "offer-list", children: [state.offers.length === 0 && _jsx("p", { className: "empty", children: "No trade offers yet." }), state.offers.map((offer) => (_jsxs("div", { className: "offer-card", children: [_jsxs("div", { className: "agent-row", children: [_jsxs("strong", { children: [offer.fromAgentId, " \u2192 ", offer.toAgentId] }), _jsx("span", { className: `badge badge-${offer.status}`, children: offer.status })] }), _jsx("p", { children: offer.message }), _jsxs("div", { className: "meta", children: [_jsxs("span", { children: ["Gives: ", offer.giveItemIds.join(", ") || "nothing"] }), _jsxs("span", { children: ["Wants: ", offer.requestItemIds.join(", ") || "nothing"] }), _jsxs("span", { children: ["Cash: $", offer.cashFromProposer] })] })] }, offer.id)))] })] }), _jsxs("article", { className: "panel", children: [_jsxs("div", { className: "panel-head", children: [_jsx("h2", { children: "Market Feed" }), _jsxs("span", { children: [state.events.length, " events"] })] }), _jsx("div", { className: "feed", children: state.events.map((event) => (_jsxs("div", { className: "feed-item", children: [_jsxs("div", { className: "agent-row", children: [_jsx("strong", { children: event.type }), _jsxs("span", { children: ["R", event.round] })] }), _jsx("p", { children: event.content })] }, event.id))) })] })] })] }));
}
