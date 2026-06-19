import { parse as parseCookie } from "cookie";
import type { Server, Socket } from "socket.io";
import { ACCESS_COOKIE } from "./cookies";
import { verifyAccessToken, type AuthUser } from "./auth";

export interface AuthenticatedSocketData {
  user: AuthUser;
}

function extractSocketToken(socket: Socket): string | null {
  const raw = socket.handshake.headers.cookie;
  if (typeof raw === "string" && raw.length > 0) {
    const parsed = parseCookie(raw);
    const fromCookie = parsed[ACCESS_COOKIE];
    if (typeof fromCookie === "string" && fromCookie.length > 0) {
      return fromCookie;
    }
  }

  const authToken = socket.handshake.auth?.token;
  if (typeof authToken === "string" && authToken.length > 0) {
    return authToken;
  }

  const header = socket.handshake.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice(7);
  }

  return null;
}

export function attachSocketAuth(io: Server) {
  io.use((socket, next) => {
    const token = extractSocketToken(socket);
    if (!token) {
      return next(new Error("Unauthorized"));
    }

    const user = verifyAccessToken(token);
    if (!user) {
      return next(new Error("Unauthorized"));
    }

    (socket.data as AuthenticatedSocketData).user = user;
    next();
  });
}

export function registerMeetingSubscriptions(io: Server) {
  io.on("connection", (socket) => {
    const user = (socket.data as AuthenticatedSocketData).user;
    console.log(`Socket connected: ${socket.id} (${user.email})`);

    socket.on("subscribe-meeting", (meetingId: unknown) => {
      if (typeof meetingId !== "string" || !meetingId.trim()) {
        socket.emit("error", { message: "Invalid meeting id" });
        return;
      }

      const id = meetingId.trim();
      socket.join(`meeting-${id}`);
      console.log(`Socket ${socket.id} (${user.email}) → room meeting-${id}`);
    });

    socket.on("disconnect", () => {
      console.log(`Socket disconnected: ${socket.id}`);
    });
  });
}
