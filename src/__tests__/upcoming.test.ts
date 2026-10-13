import { describe, it, expect, vi } from "vitest";

vi.mock("../db", () => ({ prisma: {} }));
vi.mock("../zoom", () => ({}));
vi.mock("../auth", () => ({ requireAuth: vi.fn() }));

import { mergeUpcoming } from "../api";

const meeting = { topic: "NSI Team's Zoom Meeting", joinUrl: "https://zoom.us/j/1" };

function session(id: string, start: string, status: string, occurrenceId: string | null = null) {
  return {
    id,
    meetingId: "83708978922",
    occurrenceId,
    scheduledStart: new Date(start),
    duration: 60,
    status,
    meeting,
  };
}

describe("mergeUpcoming", () => {
  it("shows today's LIVE session of a reused one-time meeting listed by Zoom with an old start date", () => {
    const zoom = [{
      id: "83708978922", uuid: "83708978922", occurrenceId: null,
      topic: meeting.topic, startTime: "2026-09-19T08:30:00Z", duration: 60, joinUrl: meeting.joinUrl,
    }];
    const db = [
      session("old", "2026-10-02T01:29:30Z", "ENDED"),
      session("live", "2026-10-13T02:00:03Z", "LIVE"),
    ];

    const result = mergeUpcoming(zoom, db);

    expect(result[0]).toMatchObject({ id: "83708978922", status: "LIVE", startTime: "2026-10-13T02:00:03.000Z" });
    // The stale Zoom entry must not borrow a status from an unrelated session.
    expect(result.find((r) => r.startTime === "2026-09-19T08:30:00Z")?.status).toBe("SCHEDULED");
    expect(result.filter((r) => r.status === "ENDED")).toHaveLength(1);
  });

  it("matches recurring occurrences by occurrenceId without duplicating them", () => {
    const zoom = [{
      id: "83708978922", uuid: "1760", occurrenceId: "1760",
      topic: meeting.topic, startTime: "2026-10-13T02:00:00Z", duration: 60, joinUrl: meeting.joinUrl,
    }];
    const db = [session("s1", "2026-10-13T02:00:00Z", "LIVE", "1760")];

    const result = mergeUpcoming(zoom, db);

    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe("LIVE");
  });

  it("prefers the LIVE session when several sessions are near the scheduled time", () => {
    const zoom = [{
      id: "83708978922", uuid: "x", occurrenceId: null,
      topic: meeting.topic, startTime: "2026-10-13T02:00:00Z", duration: 60, joinUrl: meeting.joinUrl,
    }];
    const db = [
      session("ended", "2026-10-13T01:50:00Z", "ENDED"),
      session("live", "2026-10-13T02:05:00Z", "LIVE"),
    ];

    const result = mergeUpcoming(zoom, db);

    expect(result[0]?.status).toBe("LIVE");
    expect(result).toHaveLength(2);
  });
});
