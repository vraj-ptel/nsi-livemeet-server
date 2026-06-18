import { Router } from "express";
import { UserRole } from "@prisma/client";
import { prisma } from "./db";
import { hashPassword, requireAuth, requireAdmin } from "./auth";

const router = Router();

router.use(requireAuth, requireAdmin);

function publicUser(user: {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// GET /api/team
router.get("/", async (_req, res) => {
  const users = await prisma.user.findMany({
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  });
  res.json({ members: users.map(publicUser) });
});

// POST /api/team
router.post("/", async (req, res) => {
  const { email, password, name, role } = req.body as {
    email?: string;
    password?: string;
    name?: string;
    role?: UserRole;
  };

  if (!email?.trim() || !password || !name?.trim()) {
    return res.status(400).json({ error: "Name, email, and password are required" });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }

  const normalizedEmail = normalizeEmail(email);
  if (!isValidEmail(normalizedEmail)) {
    return res.status(400).json({ error: "Invalid email address" });
  }

  const memberRole: UserRole = role === "ADMIN" ? "ADMIN" : "MEMBER";

  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    return res.status(409).json({ error: "A user with this email already exists" });
  }

  const user = await prisma.user.create({
    data: {
      email: normalizedEmail,
      name: name.trim(),
      password: hashPassword(password),
      role: memberRole,
    },
  });

  res.status(201).json({ member: publicUser(user) });
});

// PATCH /api/team/:id
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { email, password, name, role } = req.body as {
    email?: string;
    password?: string;
    name?: string;
    role?: UserRole;
  };

  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: "Team member not found" });
  }

  const data: {
    email?: string;
    name?: string;
    password?: string;
    role?: UserRole;
  } = {};

  if (name !== undefined) {
    if (!name.trim()) {
      return res.status(400).json({ error: "Name cannot be empty" });
    }
    data.name = name.trim();
  }

  if (email !== undefined) {
    const normalizedEmail = normalizeEmail(email);
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: "Invalid email address" });
    }
    if (normalizedEmail !== existing.email) {
      const duplicate = await prisma.user.findUnique({
        where: { email: normalizedEmail },
      });
      if (duplicate) {
        return res.status(409).json({ error: "A user with this email already exists" });
      }
      data.email = normalizedEmail;
    }
  }

  if (password !== undefined && password !== "") {
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    data.password = hashPassword(password);
  }

  if (role !== undefined) {
    data.role = role === "ADMIN" ? "ADMIN" : "MEMBER";
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: "No changes provided" });
  }

  if (existing.role === "ADMIN" && data.role === "MEMBER") {
    const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
    if (adminCount <= 1) {
      return res.status(400).json({ error: "Cannot demote the last admin" });
    }
  }

  const user = await prisma.user.update({ where: { id }, data });
  res.json({ member: publicUser(user) });
});

// DELETE /api/team/:id
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  const authUser = (req as typeof req & { user: { userId: string } }).user;

  if (id === authUser.userId) {
    return res.status(400).json({ error: "You cannot delete your own account" });
  }

  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) {
    return res.status(404).json({ error: "Team member not found" });
  }

  if (existing.role === "ADMIN") {
    const adminCount = await prisma.user.count({ where: { role: "ADMIN" } });
    if (adminCount <= 1) {
      return res.status(400).json({ error: "Cannot delete the last admin" });
    }
  }

  await prisma.user.delete({ where: { id } });
  res.json({ success: true });
});

export default router;
