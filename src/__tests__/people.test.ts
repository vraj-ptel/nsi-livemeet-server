import { describe, it, expect } from "vitest";
import {
  mergePeople,
  peakConcurrent,
  unionDurationMs,
  type RawParticipant,
} from "../people";

const T = (hhmm: string) => `2026-10-31T${hhmm}:00.000Z`;
const NOW = new Date(T("05:00")).getTime();
let seq = 0;

function row(
  email: string,
  name: string,
  segments: [string, string | null][],
  extra: Partial<RawParticipant> = {}
): RawParticipant {
  const history = segments.map(([j, l]) => ({ joinTime: T(j), leaveTime: l ? T(l) : null }));
  const last = history[history.length - 1]!;
  return {
    id: `p${++seq}`,
    email,
    name,
    userId: null,
    isHost: false,
    status: last.leaveTime ? "LEFT" : "IN_MEETING",
    joinTime: new Date(last.joinTime),
    leaveTime: last.leaveTime ? new Date(last.leaveTime) : null,
    duration: 0,
    joinHistory: history,
    ...extra,
  };
}

describe("unionDurationMs", () => {
  it("counts overlapping segments once", () => {
    const ms = unionDurationMs(
      [
        { joinTime: T("02:00"), leaveTime: T("03:00") },
        { joinTime: T("02:30"), leaveTime: T("03:30") },
        { joinTime: T("04:00"), leaveTime: T("04:10") },
      ],
      false
    );
    expect(ms).toBe((90 + 10) * 60_000);
  });

  it("runs an open segment to now only while in the meeting", () => {
    const seg = [{ joinTime: T("04:00"), leaveTime: null }];
    expect(unionDurationMs(seg, true, NOW)).toBe(60 * 60_000);
    expect(unionDurationMs(seg, false, NOW)).toBe(0);
  });
});

describe("mergePeople", () => {
  it("gives one row per person with a join count", () => {
    const people = mergePeople(
      [row("zoom:A", "Renu Bala", [["02:00", "02:30"], ["02:40", "03:00"]])],
      [],
      {},
      NOW
    );
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({
      name: "Renu Bala",
      joinCount: 2,
      duration: 50 * 60_000,
      status: "LEFT",
      role: "GUEST",
    });
    expect(people[0]!.joinTime?.toISOString()).toBe(T("02:00"));
    expect(people[0]!.leaveTime?.toISOString()).toBe(T("03:00"));
  });

  it("merges two devices with the same name and does not double the time", () => {
    const people = mergePeople(
      [
        row("zoom:PHONE", "Anil  Kashyap", [["02:00", "04:00"]]),
        row("zoom:LAPTOP", "anil kashyap", [["03:00", "04:30"]]),
      ],
      [],
      {},
      NOW
    );
    expect(people).toHaveLength(1);
    expect(people[0]!.joinCount).toBe(2);
    expect(people[0]!.duration).toBe(150 * 60_000);
  });

  it("folds a guest row into the signed-in person with the same name", () => {
    const people = mergePeople(
      [
        row("amit@example.com", "NSI-AMIT", [["02:00", "02:20"]]),
        row("zoom:X", "NSI-AMIT", [["02:30", null]]),
      ],
      [],
      {},
      NOW
    );
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({
      email: "amit@example.com",
      status: "IN_MEETING",
      joinCount: 2,
      leaveTime: null,
    });
  });

  it("keeps two signed-in people apart even when their names match", () => {
    const people = mergePeople(
      [
        row("a@example.com", "Priya", [["02:00", "03:00"]]),
        row("b@example.com", "Priya", [["02:00", "03:00"]]),
        row("zoom:G", "Priya", [["02:00", "03:00"]]),
      ],
      [],
      {},
      NOW
    );
    // The guest cannot be told apart, so it stays its own row.
    expect(people).toHaveLength(3);
  });

  it("matches registrants by email in any case and lists those who never joined", () => {
    const people = mergePeople(
      [row("Sneha@Example.com", "Sneha", [["02:00", "03:00"]])],
      [
        { email: "sneha@example.com", name: "Sneha Rao", sixABonus: "6A2" },
        { email: "ravi@example.com", name: "Ravi", sixABonus: "" },
      ],
      {},
      NOW
    );
    expect(people).toHaveLength(2);
    const sneha = people.find((p) => p.name === "Sneha Rao")!;
    expect(sneha).toMatchObject({ isRegistrant: true, role: "REGISTRANT", sixABonus: "6A2" });
    expect(people.find((p) => p.email === "ravi@example.com")).toMatchObject({
      status: "NOT_JOINED",
      joinCount: 0,
    });
  });

  it("marks the host from the meeting's host email and lists the host first", () => {
    const people = mergePeople(
      [
        row("guest@example.com", "Aaron", [["02:00", "03:00"]]),
        row("host@example.com", "NSI Team", [["01:55", "03:10"]]),
      ],
      [],
      { hostEmail: "HOST@example.com" },
      NOW
    );
    expect(people[0]).toMatchObject({ name: "NSI Team", isHost: true, role: "HOST" });
  });
});

describe("peakConcurrent", () => {
  it("counts each person once at the busiest moment", () => {
    const people = mergePeople(
      [
        row("zoom:A", "A", [["02:00", "03:00"]]),
        row("zoom:A2", "A", [["02:30", "02:45"]]), // same person, second device
        row("zoom:B", "B", [["02:40", "03:30"]]),
        row("zoom:C", "C", [["03:00", "03:10"]]), // joins as A leaves
      ],
      [],
      {},
      NOW
    );
    expect(peakConcurrent(people, NOW)).toBe(2);
  });
});
