import { Router } from "express";
import rateLimit from "express-rate-limit";
import { prisma } from "./db";
import {
  clearAuthCookies,
  setAccessCookie,
  setRefreshCookie,
} from "./cookies";
import {
  verifyPassword,
  requireAuth,
  createAuthSession,
  setAuthCookies,
  rotateAuthSession,
  logoutUser,
  extractRefreshToken,
} from "./auth";

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again later." },
});

router.post("/login", loginLimiter, async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });
  if (!user || !verifyPassword(password, user.password)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const refreshToken = await createAuthSession(user.id);
  setAuthCookies(res, user, refreshToken);

  res.json({
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  });
});

router.post("/refresh", async (req, res) => {
  const refreshToken = extractRefreshToken(req);
  if (!refreshToken) {
    clearAuthCookies(res);
    return res.status(401).json({ error: "Session expired" });
  }

  const rotated = await rotateAuthSession(refreshToken);
  if (!rotated) {
    clearAuthCookies(res);
    return res.status(401).json({ error: "Session expired" });
  }

  setAccessCookie(res, rotated.accessToken);
  setRefreshCookie(res, rotated.refreshToken);

  res.json({
    user: {
      id: rotated.user.id,
      email: rotated.user.email,
      name: rotated.user.name,
      role: rotated.user.role,
    },
  });
});

router.post("/logout", async (req, res) => {
  await logoutUser(req, res);
});

router.get("/me", requireAuth, async (req, res) => {
  const { userId } = (req as typeof req & { user: { userId: string } }).user;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, role: true },
  });
  if (!user) {
    clearAuthCookies(res);
    return res.status(404).json({ error: "User not found" });
  }
  res.json({ user });
});

export default router;
