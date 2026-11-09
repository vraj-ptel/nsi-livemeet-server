/**
 * Turn one session's raw Participant rows into one row per person.
 *
 * Zoom gives the same person several participant keys within one session: a
 * signed-in email, `zoom:<participant_uuid>` per device, or a legacy user_id.
 * Reports list people, not keys, so rows are grouped here at read time:
 *   - rows with an email group by lowercase email;
 *   - rows without one group by normalised display name, and fold into the
 *     email person with the same name when there is exactly one;
 *   - time is the union of all join segments, so two devices never double it.
 */

export interface JoinSegment {
  joinTime: string;
  leaveTime: string | null;
}

export interface RawParticipant {
  id: string;
  email: string;
  name: string;
  userId: string | null;
  isHost: boolean;
  status: string;
  joinTime: Date;
  leaveTime: Date | null;
  duration: number;
  joinHistory: unknown;
}

export interface RawRegistrant {
  email: string;
  name: string;
  sixABonus: string;
}

export type PersonRole = "HOST" | "REGISTRANT" | "GUEST";

export interface Person {
  id: string | null;
  email: string;
  name: string;
  role: PersonRole;
  isHost: boolean;
  isRegistrant: boolean;
  status: string;
  sixABonus: string;
  /** First time this person joined the session. */
  joinTime: Date | null;
  /** Last time they left; null while they are still in the meeting. */
  leaveTime: Date | null;
  /** Time in the meeting in ms, overlapping devices counted once. */
  duration: number;
  /** How many times they joined (every device and rejoin). */
  joinCount: number;
  joinHistory: JoinSegment[];
}

interface HostInfo {
  hostId?: string | null | undefined;
  hostEmail?: string | null | undefined;
}

export function normaliseName(name: string): string {
  return name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function isEmail(value: string): boolean {
  return value.includes("@");
}

function segmentsOf(p: RawParticipant): JoinSegment[] {
  const history = Array.isArray(p.joinHistory)
    ? (p.joinHistory as JoinSegment[]).filter((s) => s && s.joinTime)
    : [];
  if (history.length > 0) return history;
  return [
    {
      joinTime: p.joinTime.toISOString(),
      leaveTime: p.leaveTime ? p.leaveTime.toISOString() : null,
    },
  ];
}

/**
 * Total covered time of the segments, with overlaps counted once. An open
 * segment runs to `now` while the person is in the meeting; otherwise it is
 * treated as zero length (a missed leave event must not grow forever).
 */
export function unionDurationMs(
  segments: JoinSegment[],
  inMeeting: boolean,
  now: number = Date.now()
): number {
  const intervals = segments
    .map((s) => {
      const start = new Date(s.joinTime).getTime();
      const end = s.leaveTime
        ? new Date(s.leaveTime).getTime()
        : inMeeting
          ? now
          : start;
      return [start, Math.max(start, end)] as const;
    })
    .filter(([start]) => Number.isFinite(start))
    .sort((a, b) => a[0] - b[0]);

  let total = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [start, end] of intervals) {
    if (start > curEnd) {
      if (curEnd > curStart) total += curEnd - curStart;
      curStart = start;
      curEnd = end;
    } else if (end > curEnd) {
      curEnd = end;
    }
  }
  if (curEnd > curStart) total += curEnd - curStart;
  return total;
}

function rowIsHost(p: RawParticipant, host: HostInfo): boolean {
  if (p.isHost) return true;
  if (host.hostId && p.userId === host.hostId) return true;
  if (host.hostEmail && p.email.toLowerCase() === host.hostEmail.toLowerCase()) return true;
  return false;
}

export function mergePeople(
  participants: RawParticipant[],
  registrants: RawRegistrant[],
  host: HostInfo = {},
  now: number = Date.now()
): Person[] {
  // 1. Group participant rows into people.
  const groups = new Map<string, RawParticipant[]>();
  const add = (key: string, p: RawParticipant) => {
    const list = groups.get(key);
    if (list) list.push(p);
    else groups.set(key, [p]);
  };

  // Names that belong to exactly one email person, so guest rows can join them.
  const emailKeysByName = new Map<string, Set<string>>();
  for (const p of participants) {
    if (!isEmail(p.email)) continue;
    const name = normaliseName(p.name);
    if (!name) continue;
    const set = emailKeysByName.get(name) ?? new Set<string>();
    set.add(`e:${p.email.toLowerCase()}`);
    emailKeysByName.set(name, set);
  }

  for (const p of participants) {
    if (isEmail(p.email)) {
      add(`e:${p.email.toLowerCase()}`, p);
      continue;
    }
    const name = normaliseName(p.name);
    if (!name) {
      add(`k:${p.email}`, p);
      continue;
    }
    const emailKeys = emailKeysByName.get(name);
    if (emailKeys && emailKeys.size === 1) add([...emailKeys][0]!, p);
    else add(`n:${name}`, p);
  }

  // 2. Match registrants: by email, then by name to a guest-only group.
  const registrantByKey = new Map<string, RawRegistrant>();
  const unmatched: RawRegistrant[] = [];
  for (const r of registrants) {
    const emailKey = `e:${r.email.toLowerCase()}`;
    if (groups.has(emailKey)) {
      registrantByKey.set(emailKey, r);
      continue;
    }
    const nameKey = `n:${normaliseName(r.name)}`;
    if (r.name && groups.has(nameKey) && !registrantByKey.has(nameKey)) {
      registrantByKey.set(nameKey, r);
      continue;
    }
    unmatched.push(r);
  }

  // 3. Build one person per group.
  const people: Person[] = [];
  for (const [key, rows] of groups) {
    const reg = registrantByKey.get(key);
    const inMeeting = rows.some((r) => r.status === "IN_MEETING");
    const segments = rows
      .flatMap(segmentsOf)
      .sort((a, b) => a.joinTime.localeCompare(b.joinTime));
    const isHost = rows.some((r) => rowIsHost(r, host));
    const emailRow = rows.find((r) => isEmail(r.email));
    const leaveTimes = segments
      .map((s) => s.leaveTime)
      .filter((t): t is string => !!t)
      .sort();
    const firstJoin = segments[0]?.joinTime;
    const lastLeave = leaveTimes[leaveTimes.length - 1];

    people.push({
      id: (emailRow ?? rows[0])!.id,
      email: reg?.email ?? emailRow?.email ?? rows[0]!.email,
      name:
        reg?.name ||
        emailRow?.name ||
        rows.reduce((best, r) => (r.name.length > best.length ? r.name : best), ""),
      role: isHost ? "HOST" : reg ? "REGISTRANT" : "GUEST",
      isHost,
      isRegistrant: !!reg,
      status: inMeeting ? "IN_MEETING" : "LEFT",
      sixABonus: reg?.sixABonus ?? "",
      joinTime: firstJoin ? new Date(firstJoin) : null,
      leaveTime: !inMeeting && lastLeave ? new Date(lastLeave) : null,
      duration: unionDurationMs(segments, inMeeting, now),
      joinCount: segments.length,
      joinHistory: segments,
    });
  }

  // 4. Registrants who never joined.
  for (const r of unmatched) {
    people.push({
      id: null,
      email: r.email,
      name: r.name,
      role: "REGISTRANT",
      isHost: false,
      isRegistrant: true,
      status: "NOT_JOINED",
      sixABonus: r.sixABonus || "",
      joinTime: null,
      leaveTime: null,
      duration: 0,
      joinCount: 0,
      joinHistory: [],
    });
  }

  people.sort((a, b) => {
    if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
    if (a.status === "IN_MEETING" && b.status !== "IN_MEETING") return -1;
    if (b.status === "IN_MEETING" && a.status !== "IN_MEETING") return 1;
    return a.name.localeCompare(b.name);
  });

  return people;
}

/** Most people in the meeting at the same moment (each person counted once). */
export function peakConcurrent(people: Person[], now: number = Date.now()): number {
  const events: [number, number][] = [];
  for (const person of people) {
    if (person.joinCount === 0) continue;
    // Union this person's segments first so one person never counts twice.
    const inMeeting = person.status === "IN_MEETING";
    const intervals = person.joinHistory
      .map((s) => {
        const start = new Date(s.joinTime).getTime();
        const end = s.leaveTime ? new Date(s.leaveTime).getTime() : inMeeting ? now : start;
        return [start, Math.max(start, end)] as [number, number];
      })
      .sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const iv of intervals) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    }
    for (const [start, end] of merged) {
      if (end <= start) continue;
      events.push([start, 1], [end, -1]);
    }
  }
  // Leaves before joins at the same instant, so a hand-off is not a peak.
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of events) {
    current += delta;
    if (current > peak) peak = current;
  }
  return peak;
}
