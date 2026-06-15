import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { prisma } from "./db";
import { createWebhookHandler } from "./webhook";
import apiRouter from "./api";
import authRouter from "./authRoutes";

const app = express();
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, { cors: { origin: "*" } });

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ── Config ──────────────────────────────────────────────────────────────────
const ZOOM_WEBHOOK_SECRET = process.env.ZOOM_WEBHOOK_SECRET!;

function verifyZoomWebhook(req: any): boolean {
  const ts = req.headers["x-zm-request-timestamp"];
  const sig = req.headers["x-zm-signature"];
  if (!ts || !sig) return false;
  const message = `v0:${ts}:${req.rawBody}`;
  const hash = crypto
    .createHmac("sha256", ZOOM_WEBHOOK_SECRET)
    .update(message)
    .digest("hex");
  return `v0=${hash}` === sig;
}

// ── Webhook endpoint ────────────────────────────────────────────────────────
const handleWebhook = createWebhookHandler(io);

app.post("/api/zoom/webhook", async (req, res) => {
  // URL validation challenge from Zoom
  if (req.body.event === "endpoint.url_validation") {
    const hash = crypto
      .createHmac("sha256", ZOOM_WEBHOOK_SECRET)
      .update(req.body.payload.plainToken)
      .digest("hex");
    return res.json({
      plainToken: req.body.payload.plainToken,
      encryptedToken: hash,
    });
  }

  if (!verifyZoomWebhook(req)) {
    console.warn("[WEBHOOK] Invalid signature");
    return res.status(401).send("Unauthorized");
  }

  await handleWebhook(req, res);
});

// ── REST API ────────────────────────────────────────────────────────────────
app.use("/api/auth", authRouter);
app.use("/api", apiRouter);

app.get("/", (_req, res) => res.send("NSI Zoom Server ✓"));

// ── Socket.IO ───────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  socket.on("subscribe-meeting", async (meetingId: string) => {
    socket.join(`meeting-${meetingId}`);
    console.log(`Socket ${socket.id} → room meeting-${meetingId}`);


  });

  socket.on("disconnect", () => {
    console.log("Socket disconnected:", socket.id);
  });
});

// ── Start ───────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 8000;
httpServer.listen(PORT, () => {
  console.log(`\n🚀 NSI Zoom Server running on port ${PORT}`);
  console.log(
    `📡 Webhook: ${process.env.NGROK_URL ?? "http://localhost:" + PORT}/api/zoom/webhook`
  );
  console.log(`🗄️  Database: ${process.env.DATABASE_URL?.split("@")[1] ?? "configured"}\n`);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
 