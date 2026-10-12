import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// ── Mocks (hoisted before imports that use them) ──────────────────────────────

const rows = new Map<string, any>(); // `${sessionId}|${email}` → participant

vi.mock("../db", () => {
  const key = (w: any) =>
    `${w.sessionId_email.sessionId}|${w.sessionId_email.email}`;
  return {
    prisma: {
      meeting: { upsert: vi.fn() },
      meetingSession: {
        findFirst: vi.fn(),
        create: vi.fn(),
        upsert: vi.fn(),
      },
      participant: {
        findUnique: vi.fn(async ({ where }: any) => rows.get(key(where)) ?? null),
        upsert: vi.fn(async ({ where, create, update }: any) => {
          const k = key(where);
          const row = rows.has(k)
            ? { ...rows.get(k), ...update }
            : { id: `p${rows.size + 1}`, ...create };
          rows.set(k, row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          for (const [k, row] of rows) {
            if (row.id === where.id) {
              rows.set(k, { ...row, ...data });
              return rows.get(k);
            }
          }
          throw new Error("not found");
        }),
      },
    },
  };
});

vi.mock("../api", () => ({ seedSessionsForMeeting: vi.fn() }));

vi.mock("fs", async (orig) => {
  const actual = await orig<typeof import("fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      promises: { mkdir: vi.fn(async () => {}), appendFile: vi.fn(async () => {}) },
    },
  };
});

// ── Import after mocks ────────────────────────────────────────────────────────

import { prisma } from "../db";
import { createWebhookHandler, participantKey } from "../webhook";

const io = { to: () => ({ emit: vi.fn() }) } as any;
const handle = createWebhookHandler(io);

function mockRes() {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.send = vi.fn(() => res);
  return res as Response & { status: ReturnType<typeof vi.fn> };
}

async function send(event: string, object: Record<string, any>) {
  const res = mockRes();
  await handle({ body: { event, payload: { object } } } as Request, res);
  return res;
}

const SESSION = { id: "s1", meetingId: "123", status: "LIVE", uuid: "u1" };

beforeEach(() => {
  rows.clear();
  vi.mocked(prisma.meetingSession.findFirst).mockResolvedValue(SESSION as any);
});

describe("participantKey", () => {
  it("prefers email, then participant_uuid, then user_id", () => {
    expect(participantKey({ email: "a@b.c", participant_uuid: "X", user_id: "1" })).toBe("a@b.c");
    expect(participantKey({ email: "", participant_uuid: "X", user_id: "1" })).toBe("zoom:X");
    expect(participantKey({ email: "", user_id: "1" })).toBe("1");
  });
});

describe("participant join/leave", () => {
  it("merges a guest rejoin (new user_id, same participant_uuid) into one row", async () => {
    const guest = { email: "", participant_uuid: "G1", user_name: "Guest" };
    await send("meeting.participant_joined", {
      id: 123, uuid: "u1",
      participant: { ...guest, user_id: "100", join_time: "2026-10-12T02:00:00Z" },
    });
    await send("meeting.participant_left", {
      id: 123, uuid: "u1",
      participant: { ...guest, user_id: "100", leave_time: "2026-10-12T02:10:00Z" },
    });
    await send("meeting.participant_joined", {
      id: 123, uuid: "u1",
      participant: { ...guest, user_id: "200", join_time: "2026-10-12T02:20:00Z" },
    });
    await send("meeting.participant_left", {
      id: 123, uuid: "u1",
      participant: { ...guest, user_id: "200", leave_time: "2026-10-12T02:25:00Z" },
    });

    expect(rows.size).toBe(1);
    const row = rows.get("s1|zoom:G1");
    expect(row.joinHistory).toHaveLength(2);
    expect(row.status).toBe("LEFT");
    expect(row.duration).toBe(15 * 60 * 1000);
  });

  it("closes an open segment when a rejoin arrives before the leave", async () => {
    const guest = { email: "", participant_uuid: "G2", user_name: "Guest" };
    await send("meeting.participant_joined", {
      id: 123, uuid: "u1",
      participant: { ...guest, user_id: "1", join_time: "2026-10-12T02:00:00Z" },
    });
    await send("meeting.participant_joined", {
      id: 123, uuid: "u1",
      participant: { ...guest, user_id: "2", join_time: "2026-10-12T02:05:00Z" },
    });
    const row = rows.get("s1|zoom:G2");
    expect(row.joinHistory[0].leaveTime).toBe("2026-10-12T02:05:00.000Z");
    expect(row.joinHistory[1].leaveTime).toBeNull();
  });

  it("finds rows keyed by legacy user_id when a leave arrives after deploy", async () => {
    rows.set("s1|555", {
      id: "legacy", email: "555", status: "IN_MEETING",
      joinHistory: [{ joinTime: "2026-10-12T02:00:00Z", leaveTime: null }],
    });
    await send("meeting.participant_left", {
      id: 123, uuid: "u1",
      participant: { email: "", participant_uuid: "G3", user_id: "555", leave_time: "2026-10-12T02:30:00Z" },
    });
    expect(rows.get("s1|555").status).toBe("LEFT");
  });
});

describe("meeting.created (one-time)", () => {
  it("creates a session without the null-key upsert", async () => {
    vi.mocked(prisma.meetingSession.findFirst).mockResolvedValue(null);
    const res = await send("meeting.created", { id: 999, topic: "Instant", type: 1 });
    expect(prisma.meetingSession.upsert).not.toHaveBeenCalled();
    expect(prisma.meetingSession.create).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe("event handling", () => {
  it("acks ignored events without touching the database", async () => {
    const res = await send("meeting.participant_jbh_waiting", { id: 1 });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(prisma.meetingSession.findFirst).not.toHaveBeenCalled();
  });

  it("returns 500 so Zoom retries when a handler throws", async () => {
    vi.mocked(prisma.meetingSession.findFirst).mockRejectedValue(new Error("db down"));
    const res = await send("meeting.ended", { id: 1, uuid: "u1" });
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
