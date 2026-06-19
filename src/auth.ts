import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { UserRole } from "@prisma/client";
import { prisma } from "./db";
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearAuthCookies,
  setAccessCookie,
  setRefreshCookie,
} from "./cookies";

const JWT_SECRET = process.env.JWT_SECRET ?? "nsi-zoom-dev-secret-change-me";
const SALT = process.env.PASSWORD_SALT ?? "nsi-zoom-salt";

const ACCESS_TTL = "15m";
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type { UserRole };

export interface AuthUser {
  userId: string;
  email: string;
  role: UserRole;
}

export function hashPassword(password: string): string {
  return crypto.scryptSync(password, SALT, 64).toString("hex");
}

export function verifyPassword(password: string, hash: string): boolean {
  const incoming = hashPassword(password);
  try {
    return crypto.timingSafeEqual(
      Buffer.from(incoming, "hex"),
      Buffer.from(hash, "hex")
    );
  } catch {
    return false;
  }
}

export function signAccessToken(
  userId: string,
  email: string,
  role: UserRole
): string {
  return jwt.sign({ userId, email, role, type: "access" }, JWT_SECRET, {
    expiresIn: ACCESS_TTL,
  });
}

export function verifyAccessToken(token: string): AuthUser | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as Partial<
      AuthUser & { type?: string }
    >;
    if (payload?.type !== "access") return null;
    if (!payload?.userId || !payload?.email) return null;
    return {
      userId: payload.userId,
      email: payload.email,
      role: payload.role === "ADMIN" ? "ADMIN" : "MEMBER",
    };
  } catch {
    return null;
  }
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createRefreshToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export async function createAuthSession(userId: string) {
  const refreshToken = createRefreshToken();
  const refreshHash = hashRefreshToken(refreshToken);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);

  await prisma.authSession.create({
    data: { userId, refreshHash, expiresAt },
  });

  return refreshToken;
}

const refreshRotations = new Map<
  string,
  ReturnType<typeof doRotateAuthSession>
>();

export async function rotateAuthSession(refreshToken: string) {
  const refreshHash = hashRefreshToken(refreshToken);
  const inFlight = refreshRotations.get(refreshHash);
  if (inFlight) {
    return inFlight;
  }

  const rotation = doRotateAuthSession(refreshToken).finally(() => {
    refreshRotations.delete(refreshHash);
  });
  refreshRotations.set(refreshHash, rotation);
  return rotation;
}

async function doRotateAuthSession(refreshToken: string) {
  const refreshHash = hashRefreshToken(refreshToken);
  const session = await prisma.authSession.findUnique({
    where: { refreshHash },
    include: { user: true },
  });

  if (!session || session.expiresAt < new Date()) {
    if (session) {
      await prisma.authSession.delete({ where: { id: session.id } });
    }
    return null;
  }

  await prisma.authSession.delete({ where: { id: session.id } });
  const newRefreshToken = await createAuthSession(session.userId);

  return {
    user: session.user,
    refreshToken: newRefreshToken,
    accessToken: signAccessToken(
      session.user.id,
      session.user.email,
      session.user.role
    ),
  };
}

export async function revokeAuthSession(refreshToken: string | undefined) {
  if (!refreshToken) return;
  const refreshHash = hashRefreshToken(refreshToken);
  await prisma.authSession.deleteMany({ where: { refreshHash } });
}

export async function revokeAllUserSessions(userId: string) {
  await prisma.authSession.deleteMany({ where: { userId } });
}

export function setAuthCookies(
  res: Response,
  user: { id: string; email: string; role: UserRole },
  refreshToken: string
) {
  setAccessCookie(res, signAccessToken(user.id, user.email, user.role));
  setRefreshCookie(res, refreshToken);
}

export function extractAccessToken(req: Request): string | null {
  const fromCookie = req.cookies?.[ACCESS_COOKIE];
  if (typeof fromCookie === "string" && fromCookie.length > 0) {
    return fromCookie;
  }

  const header = req.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice(7);
  }

  return null;
}

export function extractRefreshToken(req: Request): string | null {
  const fromCookie = req.cookies?.[REFRESH_COOKIE];
  if (typeof fromCookie === "string" && fromCookie.length > 0) {
    return fromCookie;
  }
  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractAccessToken(req);
  if (!token) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const payload = verifyAccessToken(token);
  if (!payload) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
  (req as Request & { user?: AuthUser }).user = payload;
  next();
}

export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authUser = (req as Request & { user?: AuthUser }).user;
  if (!authUser) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const user = await prisma.user.findUnique({
    where: { id: authUser.userId },
    select: { role: true },
  });

  if (!user || user.role !== "ADMIN") {
    return res.status(403).json({ error: "Admin access required" });
  }

  next();
}

export async function logoutUser(req: Request, res: Response) {
  const refreshToken = extractRefreshToken(req);
  await revokeAuthSession(refreshToken ?? undefined);
  clearAuthCookies(res);
  res.json({ ok: true });
}
