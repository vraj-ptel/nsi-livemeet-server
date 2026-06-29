import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// ── Mocks (hoisted before imports that use them) ──────────────────────────────

vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => Symbol("jwks-mock")),
  jwtVerify: vi.fn(),
}));

vi.mock("../db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock("../cookies", () => ({
  ACCESS_COOKIE: "nsi_access",
  REFRESH_COOKIE: "nsi_refresh",
  clearAuthCookies: vi.fn(),
  setAccessCookie: vi.fn(),
  setRefreshCookie: vi.fn(),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { requireAuth, verifyIdpToken } from "../auth";
import { jwtVerify } from "jose";
import { prisma } from "../db";

// ── Helpers ───────────────────────────────────────────────────────────────────

// Must match the fallback in auth.ts (module-level constant set at import time)
const TEST_SECRET = "nsi-zoom-dev-secret-change-me";

function signLocalToken(payload: object, secret = TEST_SECRET, expiresIn = "15m") {
  return jwt.sign(payload, secret, { expiresIn } as jwt.SignOptions);
}

function mockReq(opts: {
  cookie?: string;
  authHeader?: string;
} = {}): Request {
  return {
    cookies: opts.cookie ? { nsi_access: opts.cookie } : {},
    headers: { authorization: opts.authHeader },
  } as unknown as Request;
}

function mockRes(): { res: Response; statusMock: ReturnType<typeof vi.fn>; jsonMock: ReturnType<typeof vi.fn> } {
  const jsonMock = vi.fn().mockReturnThis();
  const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
  const res = { status: statusMock, json: jsonMock } as unknown as Response;
  return { res, statusMock, jsonMock };
}

function mockNext(): NextFunction {
  return vi.fn() as unknown as NextFunction;
}

// ── Local mode ────────────────────────────────────────────────────────────────

describe("requireAuth — local mode (AUTH_MODE=local)", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_MODE", "local");
    // JWT_SECRET is a module-level constant; tests sign with the same fallback value
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a valid access token from cookie and sets req.user", async () => {
    const token = signLocalToken({ userId: "user-1", email: "a@b.com", role: "ADMIN", type: "access" });
    const req = mockReq({ cookie: token });
    const { res, statusMock } = mockRes();
    const next = mockNext();

    await requireAuth(req, res, next);

    expect(statusMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    expect((req as any).user).toEqual({ userId: "user-1", email: "a@b.com", role: "ADMIN" });
  });

  it("accepts a valid access token from Authorization header", async () => {
    const token = signLocalToken({ userId: "user-2", email: "b@c.com", role: "MEMBER", type: "access" });
    const req = mockReq({ authHeader: `Bearer ${token}` });
    const { res, statusMock } = mockRes();
    const next = mockNext();

    await requireAuth(req, res, next);

    expect(statusMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    expect((req as any).user).toMatchObject({ userId: "user-2", email: "b@c.com", role: "MEMBER" });
  });

  it("returns 401 when no token is provided", async () => {
    const req = mockReq();
    const { res, statusMock, jsonMock } = mockRes();
    const next = mockNext();

    await requireAuth(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith({ error: "Unauthorized" });
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 for an expired token", async () => {
    const token = signLocalToken({ userId: "u", email: "e@f.com", role: "MEMBER", type: "access" }, TEST_SECRET, "-1s");
    const req = mockReq({ cookie: token });
    const { res, statusMock } = mockRes();
    const next = mockNext();

    await requireAuth(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 for a token signed with wrong secret", async () => {
    const token = signLocalToken({ userId: "u", email: "e@f.com", role: "MEMBER", type: "access" }, "wrong-secret");
    const req = mockReq({ cookie: token });
    const { res, statusMock } = mockRes();
    const next = mockNext();

    await requireAuth(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 for a refresh token used as access token (wrong type)", async () => {
    const token = signLocalToken({ userId: "u", email: "e@f.com", role: "MEMBER", type: "refresh" });
    const req = mockReq({ cookie: token });
    const { res, statusMock } = mockRes();
    const next = mockNext();

    await requireAuth(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

// ── IdP mode ──────────────────────────────────────────────────────────────────

describe("requireAuth — idp mode (AUTH_MODE=idp)", () => {
  const EXISTING_USER = { id: "local-id-1", email: "staff@nsi.com", name: "Staff User", role: "ADMIN" as const, password: "", createdAt: new Date(), updatedAt: new Date() };

  beforeEach(() => {
    vi.stubEnv("AUTH_MODE", "idp");
    vi.stubEnv("JWKS_URI", "http://localhost:4001/.well-known/jwks.json");
    vi.stubEnv("JWT_ISSUER", "https://auth.app.growithnsi.com");
    vi.stubEnv("JWT_AUDIENCE", "nsi-ecosystem");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a valid STAFF token, resolves existing local user", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: { realm: "STAFF", email: "staff@nsi.com", name: "Staff User" },
      protectedHeader: { alg: "RS256" },
    } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(EXISTING_USER);

    const req = mockReq({ authHeader: "Bearer idp.token.here" });
    const { res, statusMock } = mockRes();
    const next = mockNext();

    await requireAuth(req, res, next);

    expect(statusMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    expect((req as any).user).toEqual({ userId: "local-id-1", email: "staff@nsi.com", role: "ADMIN" });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("JIT-creates a MEMBER user when email is unknown", async () => {
    const newUser = { id: "new-id-99", email: "new@nsi.com", name: "New Person", role: "MEMBER" as const, password: "", createdAt: new Date(), updatedAt: new Date() };
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: { realm: "STAFF", email: "new@nsi.com", name: "New Person" },
      protectedHeader: { alg: "RS256" },
    } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.user.create).mockResolvedValueOnce(newUser);

    const req = mockReq({ authHeader: "Bearer idp.token.here" });
    const { res, statusMock } = mockRes();
    const next = mockNext();

    await requireAuth(req, res, next);

    expect(statusMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    expect((req as any).user).toEqual({ userId: "new-id-99", email: "new@nsi.com", role: "MEMBER" });
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: { email: "new@nsi.com", name: "New Person", role: "MEMBER", password: "" },
    });
  });

  it("JIT-create uses email as name fallback when token has no name claim", async () => {
    const newUser = { id: "x", email: "noname@nsi.com", name: "noname@nsi.com", role: "MEMBER" as const, password: "", createdAt: new Date(), updatedAt: new Date() };
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: { realm: "STAFF", email: "noname@nsi.com" },
      protectedHeader: { alg: "RS256" },
    } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);
    vi.mocked(prisma.user.create).mockResolvedValueOnce(newUser);

    const req = mockReq({ authHeader: "Bearer token" });
    const { res } = mockRes();
    const next = mockNext();

    await requireAuth(req, res, next);

    expect(prisma.user.create).toHaveBeenCalledWith({
      data: { email: "noname@nsi.com", name: "noname@nsi.com", role: "MEMBER", password: "" },
    });
  });

  it("never modifies an existing user (read-then-create only)", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: { realm: "STAFF", email: "staff@nsi.com" },
      protectedHeader: { alg: "RS256" },
    } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(EXISTING_USER);

    const req = mockReq({ authHeader: "Bearer token" });
    await requireAuth(req, mockRes().res, mockNext());

    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("rejects a DISTRIBUTOR realm token with 401", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: { realm: "DISTRIBUTOR", email: "dist@nsi.com" },
      protectedHeader: { alg: "RS256" },
    } as any);

    const req = mockReq({ authHeader: "Bearer distributor.token" });
    const { res, statusMock } = mockRes();
    const next = mockNext();

    await requireAuth(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns 401 when jose throws (invalid/expired token)", async () => {
    vi.mocked(jwtVerify).mockRejectedValueOnce(new Error("JWTExpired"));

    const req = mockReq({ authHeader: "Bearer bad.token" });
    const { res, statusMock } = mockRes();
    const next = mockNext();

    await requireAuth(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("returns 401 when no token is provided", async () => {
    const req = mockReq();
    const { res, statusMock } = mockRes();
    const next = mockNext();

    await requireAuth(req, res, next);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(jwtVerify).not.toHaveBeenCalled();
  });
});
