# Agents Marketplace

A local multi-agent trading sandbox where AI agents negotiate over scarce items, budgets, and perceived value. Agents can announce publicly, whisper privately, bluff in dialogue, and settle trades through deterministic backend rules.

## Stack

- `apps/web`: React + Vite dashboard
- `apps/server`: Fastify + Socket.IO simulation server
- `packages/shared`: shared contracts
- `packages/engine`: deterministic market engine and fallback agent logic
- `apps/server/data/agents-marketplace.db`: local SQLite database created automatically by the server

## Local startup

Install dependencies once:

```bash
npm install
```

Start the full stack from the repo root:

```bash
npm run dev
```

That one command starts:

- web app on `http://localhost:5173`
- server on `http://localhost:3001`
- SQLite persistence automatically inside `apps/server/data/agents-marketplace.db`

## Ollama

The server is wired for Ollama by default. Run Ollama separately and make sure the model exists:

```bash
ollama run llama3.2
```

Environment settings live in `.env.example`.

If Ollama is unavailable or returns malformed output, the server falls back to a heuristic agent so the simulation still runs.

## Current behavior

- seeded with 4 agents and 8 items
- supports `announce`, `whisper`, `propose_trade`, `accept_trade`, `reject_trade`, and `pass`
- uses a turn-based simulation loop
- broadcasts live state over WebSockets to the UI
- persists sessions and replayable event logs in local SQLite
- ends a session at 1000 ticks or when every agent passes in sequence and the market goes inactive

## Replay

Each session is stored with:

- the latest snapshot of market state
- an append-only event log for replay

The UI can browse saved sessions, and the backend exposes replay data through `/api/sessions/:sessionId/replay`.

## Next useful additions

- richer utility functions and collection bonuses
- hidden memory per agent
- human-in-the-loop bidding
- export/import of saved sessions
