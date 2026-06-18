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
import teamRouter from "./teamRoutes";
import { getAllowedOrigins } from "./cors";
import { attachSocketAuth, registerMeetingSubscriptions } from "./socketAuth";

const app = express();
const httpServer = http.createServer(app);
const allowedOrigins = getAllowedOrigins();

const io = new SocketIOServer(httpServer, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
});

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);
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
app.use("/api/team", teamRouter);
app.use("/api", apiRouter);

app.get("/", (_req, res) => res.send("NSI Live Meet Server ✓"));

// ── Socket.IO (JWT required) ────────────────────────────────────────────────
attachSocketAuth(io);
registerMeetingSubscriptions(io);

// ── Start ───────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 8000;
httpServer.listen(PORT, () => {
  console.log(`\n🚀 NSI Live Meet Server running on port ${PORT}`);
  console.log(`🗄️  Database: ${process.env.DATABASE_URL?.split("@")[1] ?? "configured"}\n`);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
 