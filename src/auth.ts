import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { UserRole } from "@prisma/client";
import { prisma } from "./db";

const JWT_SECRET = process.env.JWT_SECRET ?? "nsi-zoom-dev-secret-change-me";
const SALT = process.env.PASSWORD_SALT ?? "nsi-zoom-salt";

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

export function signToken(userId: string, email: string, role: UserRole): string {
  return jwt.sign({ userId, email, role }, JWT_SECRET, { expiresIn: "7d" });
}

export function verifyToken(token: string): AuthUser | null {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as Partial<AuthUser>;
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

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = header.slice(7);
  const payload = verifyToken(token);
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
