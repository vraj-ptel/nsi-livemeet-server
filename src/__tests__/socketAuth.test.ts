import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

// ── Mocks ─────────────────────────────────────────────────────────────────────

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

// ── Imports after mocks ───────────────────────────────────────────────────────

import { attachSocketAuth } from "../socketAuth";
import { jwtVerify } from "jose";
import { prisma } from "../db";

// ── Helpers ───────────────────────────────────────────────────────────────────

// Must match the fallback in auth.ts (module-level constant set at import time)
const TEST_SECRET = "nsi-zoom-dev-secret-change-me";

function signLocalToken(payload: object) {
  return jwt.sign(payload, TEST_SECRET, { expiresIn: "15m" });
}

function mockSocket(opts: {
  authToken?: string;
  cookieHeader?: string;
} = {}) {
  return {
    handshake: {
      auth: opts.authToken !== undefined ? { token: opts.authToken } : {},
      headers: { cookie: opts.cookieHeader ?? "" },
      authorization: undefined,
    },
    data: {} as Record<string, unknown>,
  };
}

// Capture the middleware registered via io.use()
function captureMiddleware(socket: ReturnType<typeof mockSocket>) {
  let capturedMiddleware: ((socket: any, next: (err?: Error) => void) => void) | null = null;
  const io = {
    use: (fn: typeof capturedMiddleware) => {
      capturedMiddleware = fn;
    },
  } as any;
  attachSocketAuth(io);
  return (next: (err?: Error) => void) => capturedMiddleware!(socket, next);
}

// ── Local mode ────────────────────────────────────────────────────────────────

describe("attachSocketAuth — local mode", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_MODE", "local");
    // JWT_SECRET is a module-level constant; tests sign with the same fallback value
  });
  afterEach(() => vi.unstubAllEnvs());

  it("authenticates a valid access token from cookie and sets socket.data.user", async () => {
    const token = signLocalToken({ userId: "u1", email: "a@b.com", role: "ADMIN", type: "access" });
    const socket = mockSocket({ cookieHeader: `nsi_access=${token}` });
    const run = captureMiddleware(socket);

    const next = vi.fn();
    await run(next);

    expect(next).toHaveBeenCalledWith(); // called with no error
    expect(socket.data.user).toMatchObject({ userId: "u1", email: "a@b.com", role: "ADMIN" });
  });

  it("calls next(Error) when no token is present", async () => {
    const socket = mockSocket();
    const run = captureMiddleware(socket);
    const next = vi.fn();
    await run(next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect((next.mock.calls[0]?.[0] as Error)?.message).toBe("Unauthorized");
  });

  it("calls next(Error) for an invalid token", async () => {
    const socket = mockSocket({ cookieHeader: "nsi_access=garbage.token.here" });
    const run = captureMiddleware(socket);
    const next = vi.fn();
    await run(next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

// ── IdP mode ──────────────────────────────────────────────────────────────────

describe("attachSocketAuth — idp mode", () => {
  const EXISTING_USER = { id: "local-id-1", email: "staff@nsi.com", name: "Staff", role: "MEMBER" as const, password: "", createdAt: new Date(), updatedAt: new Date() };

  beforeEach(() => {
    vi.stubEnv("AUTH_MODE", "idp");
    vi.stubEnv("JWKS_URI", "http://localhost:4001/.well-known/jwks.json");
    vi.stubEnv("JWT_ISSUER", "https://auth.app.growithnsi.com");
    vi.stubEnv("JWT_AUDIENCE", "nsi-ecosystem");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("authenticates via handshake.auth.token and sets socket.data.user", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: { realm: "STAFF", email: "staff@nsi.com", name: "Staff" },
      protectedHeader: { alg: "RS256" },
    } as any);
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(EXISTING_USER);

    const socket = mockSocket({ authToken: "valid.idp.token" });
    const run = captureMiddleware(socket);
    const next = vi.fn();
    await run(next);

    expect(next).toHaveBeenCalledWith();
    expect(socket.data.user).toMatchObject({ userId: "local-id-1", email: "staff@nsi.com", role: "MEMBER" });
  });

  it("calls next(Error) when handshake.auth.token is absent", async () => {
    const socket = mockSocket(); // no authToken
    const run = captureMiddleware(socket);
    const next = vi.fn();
    await run(next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it("calls next(Error) when jose rejects the token", async () => {
    vi.mocked(jwtVerify).mockRejectedValueOnce(new Error("JWTExpired"));

    const socket = mockSocket({ authToken: "expired.token" });
    const run = captureMiddleware(socket);
    const next = vi.fn();
    await run(next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it("calls next(Error) for DISTRIBUTOR realm", async () => {
    vi.mocked(jwtVerify).mockResolvedValueOnce({
      payload: { realm: "DISTRIBUTOR", email: "d@nsi.com" },
      protectedHeader: { alg: "RS256" },
    } as any);

    const socket = mockSocket({ authToken: "distributor.token" });
    const run = captureMiddleware(socket);
    const next = vi.fn();
    await run(next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});
