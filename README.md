# Agents Marketplace

A local multi-agent trading sandbox where AI agents negotiate over scarce items, budgets, and perceived value. Agents can announce publicly, whisper privately, bluff in dialogue, and settle trades through deterministic backend rules.

## Stack

- `apps/web`: React + Vite dashboard
- `apps/server`: Fastify + Socket.IO simulation server
- `packages/shared`: shared contracts
- `packages/engine`: deterministic market engine and fallback agent logic

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

## Next useful additions

- persistent sessions with Postgres
- richer utility functions and collection bonuses
- hidden memory per agent
- replayable transcripts
- human-in-the-loop bidding
