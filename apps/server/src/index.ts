import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { Server as SocketServer } from "socket.io";
import { config } from "./config.js";
import { SimulationService } from "./services/simulation.js";

const app = Fastify({
  logger: true
});

const simulation = new SimulationService();

await app.register(cors, {
  origin: config.webOrigin,
  credentials: true
});

app.get("/api/health", async () => ({
  ok: true,
  runtimeMode: config.agentRuntimeMode,
  model: config.ollamaModel
}));

app.get("/api/simulation", async () => simulation.getState());
app.post("/api/simulation/reset", async () => simulation.reset());
app.post("/api/simulation/step", async () => simulation.step());
app.post("/api/simulation/toggle-run", async () => simulation.toggleRun());

const address = await app.listen({
  port: config.port,
  host: config.host
});

const io = new SocketServer(app.server, {
  cors: {
    origin: config.webOrigin
  }
});

io.on("connection", (socket) => {
  socket.emit("simulation:update", { state: simulation.getState() });
});

simulation.attachIo(io);
app.log.info(`Server listening on ${address}`);
