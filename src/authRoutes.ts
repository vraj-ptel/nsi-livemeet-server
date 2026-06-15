import { Router } from "express";
import { prisma } from "./db";
import { verifyPassword, signToken, requireAuth } from "./auth";

const router = Router();

router.post("/login", async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password required" });
  }

  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || !verifyPassword(password, user.password)) {
    return res.status(401).json({ error: "Invalid email or password" });
  }

  const token = signToken(user.id, user.email);
  res.json({
    token,
    user: { id: user.id, email: user.email, name: user.name },
  });
});

router.get("/me", requireAuth, async (req, res) => {
  const { userId } = (req as typeof req & { user: { userId: string } }).user;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true },
  });
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ user });
});

export default router;
