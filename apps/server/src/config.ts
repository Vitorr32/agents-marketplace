export const config = {
  port: Number(process.env.PORT ?? 3001),
  host: process.env.HOST ?? "0.0.0.0",
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
  ollamaModel: process.env.OLLAMA_MODEL ?? "llama3.2",
  agentRuntimeMode: process.env.AGENT_RUNTIME_MODE ?? "ollama",
  stepIntervalMs: Number(process.env.STEP_INTERVAL_MS ?? 2500)
} as const;
