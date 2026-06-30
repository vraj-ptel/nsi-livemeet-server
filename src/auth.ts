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
import { createRemoteJWKSet, jwtVerify } from "jose";

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

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (getAuthMode() === "idp") {
    const token = extractAccessToken(req);
    if (!token) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      (req as Request & { user?: AuthUser }).user = await verifyIdpToken(token);
      next();
    } catch {
      res.status(401).json({ error: "Unauthorized" });
    }
    return;
  }

  // local mode — synchronous path, unchanged
  const token = extractAccessToken(req);
  if (!token) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const payload = verifyAccessToken(token);
  if (!payload) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
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

  // IdP mode: role already resolved by verifyIdpToken (SUPER_ADMIN → "ADMIN").
  // Skip the DB lookup — there is no local User row keyed by the IdP sub.
  if (authUser.role === "ADMIN") {
    next();
    return;
  }

  // Local mode: verify role from DB (source of truth for local-auth users).
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

// ── IdP auth (central identity provider) ─────────────────────────────────────

export function getAuthMode(): "local" | "idp" {
  return process.env.AUTH_MODE === "idp" ? "idp" : "local";
}

let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let _jwksUri = "";

function getJWKS(): ReturnType<typeof createRemoteJWKSet> {
  const uri = process.env.JWKS_URI;
  if (!uri) throw new Error("[auth] AUTH_MODE=idp requires JWKS_URI");
  if (!_jwks || _jwksUri !== uri) {
    _jwks = createRemoteJWKSet(new URL(uri));
    _jwksUri = uri;
  }
  return _jwks;
}

export async function verifyIdpToken(token: string): Promise<AuthUser> {
  const issuer = process.env.JWT_ISSUER;
  const audience = process.env.JWT_AUDIENCE;
  if (!issuer || !audience) {
    throw new Error("[auth] AUTH_MODE=idp requires JWT_ISSUER and JWT_AUDIENCE");
  }

  const { payload } = await jwtVerify<{
    realm?: string;
    phone?: string;
    platformRole?: string;
  }>(token, getJWKS(), {
    issuer,
    audience,
    algorithms: ["RS256"],
  });

  // Accept both STAFF (dashboard admins) and DISTRIBUTOR (morning-call attendees)
  if (payload.realm !== "STAFF" && payload.realm !== "DISTRIBUTOR") {
    throw new Error("Forbidden: STAFF or DISTRIBUTOR realm required");
  }

  const sub = payload.sub;
  if (!sub) throw new Error("Token missing sub claim");

  // SUPER_ADMIN gets livemeet ADMIN; everyone else is MEMBER
  const role: "ADMIN" | "MEMBER" =
    payload.platformRole === "SUPER_ADMIN" ? "ADMIN" : "MEMBER";

  return {
    userId: sub,
    email: (payload.phone as string | undefined) ?? sub,
    role,
  };
}
