import { Router } from "express";
import { prisma } from "./db";
import {
  type ZoomOccurrence,
  getUpcomingMeetings,
  getMeetingDetails,
  getZoomToken,
  listMeetingRegistrants,
} from "./zoom";
import {
  normalizeZoomRegistrant,
  upsertRegistrant,
} from "./registrants";
import { requireAuth } from "./auth";
import { asyncRoute } from "./http";
import { getLastWebhookAt } from "./health";
import { mergePeople, peakConcurrent, unionDurationMs, type JoinSegment } from "./people";
import axios from "axios";

const router = Router();
router.use(requireAuth);

// ── Helper: seed MeetingSessions from Zoom API for a given meeting ────────────
// Called when we fetch upcoming meetings and find a recurring meeting that has
// no sessions in DB yet (i.e., meeting.created webhook was never received).
export async function seedSessionsForMeeting(
  meetingId: string,
  topic: string,
  type: number,
  joinUrl: string,
  timezone?: string
) {
  await prisma.meeting.upsert({
    where: { id: meetingId },
    create: { id: meetingId, topic, type, joinUrl, timezone: timezone ?? null },
    update: { topic, joinUrl },
  });

  if (type !== 8) return; // only recurring needs occurrence seeding

  try {
    const token = await getZoomToken();
    const detail = await axios.get(
      `https://api.zoom.us/v2/meetings/${meetingId}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { show_previous_occurrences: false },
      }
    );

    const occurrences: any[] = detail.data.occurrences ?? [];
    for (const occ of occurrences) {
      if (occ.status === "deleted") continue;
      await prisma.meetingSession.upsert({
        where: {
          meetingId_occurrenceId: {
            meetingId,
            occurrenceId: occ.occurrence_id,
          },
        },
        create: {
          meetingId,
          occurrenceId: occ.occurrence_id,
          scheduledStart: new Date(occ.start_time),
          duration: occ.duration,
          status: "SCHEDULED",
        },
        update: { duration: occ.duration },
      });
    }
    console.log(
      `[SEED] Seeded ${occurrences.length} sessions for meeting ${meetingId}`
    );
  } catch (err: any) {
    console.error(
      `[SEED ERROR] meeting ${meetingId}:`,
      err.response?.data ?? err.message
    );
  }
}

const SESSION_MATCH_MS = 45 * 60 * 1000;

export type UpcomingOccurrence = {
  id: string;
  uuid: string;
  occurrenceId: string | null;
  topic: string;
  startTime: string;
  duration: number;
  joinUrl: string;
  status: string;
  /** The DB session this row is, when there is one (open attendance with it). */
  sessionId: string | null;
};

type DbSessionForMerge = {
  id: string;
  meetingId: string;
  occurrenceId: string | null;
  scheduledStart: Date;
  duration: number;
  status: string;
  meeting: { topic: string; joinUrl: string | null };
};

/**
 * Pick the DB session a Zoom list entry refers to. Recurring occurrences match
 * by occurrenceId; everything else by scheduled time. One-time meetings that are
 * reused daily share occurrenceId=null across many sessions, so a null-id match
 * alone would pick an arbitrary old session.
 */
function matchSession(
  occ: { id: string; occurrenceId?: string | null; startTime: string },
  byMeeting: Map<string, DbSessionForMerge[]>
) {
  const dbSessions = byMeeting.get(occ.id) ?? [];
  if (occ.occurrenceId) {
    const exact = dbSessions.find(
      (s) => s.meetingId === occ.id && s.occurrenceId === occ.occurrenceId
    );
    if (exact) return exact;
  }

  const startMs = new Date(occ.startTime).getTime();
  const near = dbSessions.filter(
    (s) =>
      s.meetingId === occ.id &&
      Math.abs(s.scheduledStart.getTime() - startMs) < SESSION_MATCH_MS
  );
  return near.find((s) => s.status === "LIVE") ?? near[0] ?? null;
}

/**
 * Merge Zoom's scheduled list with LIVE/ENDED sessions from the DB. Any DB
 * session not matched to a Zoom entry is added on its own — this is how live
 * sessions of reused one-time meetings (whose Zoom start_time is the original
 * scheduled date) show up.
 */
export function mergeUpcoming(
  occurrences: {
    id: string;
    uuid: string;
    occurrenceId?: string | null;
    topic: string;
    startTime: string;
    duration: number;
    joinUrl: string;
  }[],
  dbSessions: DbSessionForMerge[]
): UpcomingOccurrence[] {
  const matched = new Set<string>();
  const byMeeting = new Map<string, DbSessionForMerge[]>();
  for (const session of dbSessions) {
    const list = byMeeting.get(session.meetingId);
    if (list) list.push(session);
    else byMeeting.set(session.meetingId, [session]);
  }

  const result: UpcomingOccurrence[] = occurrences.map((occ) => {
    const session = matchSession(occ, byMeeting);
    if (session) matched.add(session.id);
    return {
      id: occ.id,
      uuid: occ.uuid,
      occurrenceId: occ.occurrenceId ?? null,
      topic: occ.topic,
      startTime: occ.startTime,
      duration: occ.duration,
      joinUrl: occ.joinUrl,
      status: session?.status ?? "SCHEDULED",
      sessionId: session?.id ?? null,
    };
  });

  for (const session of dbSessions) {
    if (matched.has(session.id)) continue;
    result.push({
      id: session.meetingId,
      uuid: session.occurrenceId ?? session.meetingId,
      occurrenceId: session.occurrenceId,
      topic: session.meeting.topic,
      startTime: session.scheduledStart.toISOString(),
      duration: session.duration,
      joinUrl: session.meeting.joinUrl ?? "",
      status: session.status,
      sessionId: session.id,
    });
  }

  // LIVE meetings first, then by start time
  result.sort((a, b) => {
    if (a.status === "LIVE" && b.status !== "LIVE") return -1;
    if (b.status === "LIVE" && a.status !== "LIVE") return 1;
    return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
  });

  return result;
}

// ── Zoom list cache ───────────────────────────────────────────────────────────
// The Zoom list takes several Zoom calls; every open tab polls it. Share one
// fetch per minute across all requests, and serve the last good list if Zoom
// fails.
const ZOOM_LIST_TTL_MS = 60 * 1000;
let zoomListCache: { at: number; data: ZoomOccurrence[] } | null = null;
let zoomListInFlight: Promise<ZoomOccurrence[]> | null = null;

/** Add meetings the DB has never seen, and any new recurring occurrences. */
async function seedFromZoomList(occurrences: ZoomOccurrence[]) {
  const byMeeting = new Map<string, ZoomOccurrence[]>();
  for (const occ of occurrences) {
    const list = byMeeting.get(occ.id);
    if (list) list.push(occ);
    else byMeeting.set(occ.id, [occ]);
  }

  const existing = new Set(
    (
      await prisma.meeting.findMany({
        where: { id: { in: [...byMeeting.keys()] } },
        select: { id: true },
      })
    ).map((m) => m.id)
  );

  for (const [meetingId, occs] of byMeeting) {
    const first = occs[0]!;
    if (!existing.has(meetingId)) {
      await prisma.meeting.create({
        data: { id: meetingId, topic: first.topic, type: first.type, joinUrl: first.joinUrl },
      });
    }
    const recurring = occs.filter((o) => o.occurrenceId);
    if (recurring.length > 0) {
      await prisma.meetingSession.createMany({
        data: recurring.map((o) => ({
          meetingId,
          occurrenceId: o.occurrenceId!,
          scheduledStart: new Date(o.startTime),
          duration: o.duration ?? 60,
          status: "SCHEDULED" as const,
        })),
        skipDuplicates: true,
      });
    }
  }
}

async function getZoomList(): Promise<ZoomOccurrence[]> {
  // Local development without Zoom credentials: only the database is shown.
  if (!process.env.ZOOM_ACCOUNT_ID) return [];
  if (zoomListCache && Date.now() - zoomListCache.at < ZOOM_LIST_TTL_MS) {
    return zoomListCache.data;
  }
  if (!zoomListInFlight) {
    zoomListInFlight = (async () => {
      try {
        const data = await getUpcomingMeetings();
        await seedFromZoomList(data);
        zoomListCache = { at: Date.now(), data };
        return data;
      } catch (err: any) {
        console.error("[ZOOM] List failed:", err.response?.data ?? err.message);
        if (zoomListCache) return zoomListCache.data; // stale beats nothing
        throw err;
      } finally {
        zoomListInFlight = null;
      }
    })();
  }
  return zoomListInFlight;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 60;

/** `YYYY-MM-DD` (IST calendar day) → Date at the start of that day, or null. */
function parseDay(value: unknown, endOfDay = false): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const start = new Date(`${value}T00:00:00+05:30`);
  if (Number.isNaN(start.getTime())) return null;
  return endOfDay ? new Date(start.getTime() + DAY_MS) : start;
}

/** People per session, counted the way mergePeople groups them (close enough for a list). */
async function peopleCounts(sessionIds: string[]): Promise<Map<string, number>> {
  if (sessionIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<{ sessionId: string; people: number }[]>`
    SELECT "sessionId",
           COUNT(DISTINCT CASE WHEN position('@' in email) > 0 THEN lower(email)
                               ELSE lower(regexp_replace(btrim(name), '[[:space:]]+', ' ', 'g')) END)::int AS people
    FROM "Participant"
    WHERE "sessionId" = ANY(${sessionIds})
    GROUP BY "sessionId"`;
  return new Map(rows.map((r) => [r.sessionId, Number(r.people)]));
}

// ── GET /api/meetings/upcoming ────────────────────────────────────────────────
// Query: from, to (YYYY-MM-DD, IST). Live and ended sessions outside the range
// are left out (live ones always included); defaults to the last 60 days.
router.get("/meetings/upcoming", asyncRoute(async (req, res) => {
  let occurrences: ZoomOccurrence[];
  try {
    occurrences = await getZoomList();
  } catch {
    res.status(502).json({ error: "Failed to fetch meetings from Zoom" });
    return;
  }

  const from = parseDay(req.query.from) ?? new Date(Date.now() - DEFAULT_WINDOW_DAYS * DAY_MS);
  const to = parseDay(req.query.to, true);

  // Zoom omits in-progress and past occurrences; those come from the DB.
  const dbSessions = await prisma.meetingSession.findMany({
    where: {
      OR: [
        { status: "LIVE" },
        {
          status: "ENDED",
          scheduledStart: { gte: from, ...(to ? { lt: to } : {}) },
        },
      ],
    },
    include: { meeting: { select: { topic: true, joinUrl: true } } },
  });

  const result = mergeUpcoming(occurrences, dbSessions);
  const counts = await peopleCounts(
    result.map((r) => r.sessionId).filter((id): id is string => !!id)
  );

  res.json(
    result.map((r) => ({
      ...r,
      people: r.sessionId ? (counts.get(r.sessionId) ?? 0) : null,
    }))
  );
}));

// ── GET /api/meetings/history ─────────────────────────────────────────────────
// Optional ?sessionsPerMeeting=N keeps the newest N sessions per meeting.
router.get("/meetings/history", asyncRoute(async (req, res) => {
  const limit = Number(req.query.sessionsPerMeeting);
  const take = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : undefined;
  const meetings = await prisma.meeting.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      sessions: { orderBy: { scheduledStart: "desc" }, ...(take ? { take } : {}) },
      _count: { select: { registrants: true } },
    },
  });

  res.json(
    meetings.map((m) => ({
      id: m.id,
      topic: m.topic,
      type: m.type,
      joinUrl: m.joinUrl,
      timezone: m.timezone,
      createdAt: m.createdAt,
      totalRegistrants: m._count.registrants,
      sessions: m.sessions.map((s) => ({
        id: s.id,
        occurrenceId: s.occurrenceId,
        scheduledStart: s.scheduledStart,
        duration: s.duration,
        status: s.status,
        endTime: s.endTime,
      })),
    }))
  );
}));

// ── GET /api/dashboard/overview ───────────────────────────────────────────────
router.get("/dashboard/overview", asyncRoute(async (_req, res) => {
  const [
    totalMeetings,
    totalRegistrants,
    totalSessions,
    sessionStatusGroups,
    sixAGroups,
    topMeetingsRaw,
  ] = await Promise.all([
    prisma.meeting.count(),
    prisma.registrant.count(),
    prisma.meetingSession.count(),
    prisma.meetingSession.groupBy({
      by: ["status"],
      _count: { _all: true },
    }),
    prisma.registrant.groupBy({
      by: ["sixABonus"],
      _count: { _all: true },
      where: { sixABonus: { not: "" } },
      orderBy: { _count: { sixABonus: "desc" } },
      take: 8,
    }),
    prisma.meeting.findMany({
      take: 5,
      orderBy: { registrants: { _count: "desc" } },
      include: { _count: { select: { registrants: true, sessions: true } } },
    }),
  ]);

  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);

  // One row per session that actually ran in the last 12 months, counted in
  // the database instead of loading every registrant and participant row.
  const held = await prisma.$queryRaw<
    {
      sessionId: string;
      meetingId: string;
      scheduledStart: Date;
      topic: string;
      registered: number;
      joined: number;
      people: number;
      durationMs: bigint | number;
    }[]
  >`
    SELECT s.id AS "sessionId", s."meetingId", s."scheduledStart", m.topic,
           COALESCE(rc.n, 0)::int AS registered,
           (SELECT COUNT(DISTINCT lower(p.email))
              FROM "Participant" p
              JOIN "Registrant" r ON r."meetingId" = s."meetingId" AND lower(r.email) = lower(p.email)
             WHERE p."sessionId" = s.id)::int AS joined,
           (SELECT COUNT(DISTINCT CASE WHEN position('@' in p.email) > 0 THEN lower(p.email)
                                       ELSE lower(regexp_replace(btrim(p.name), '[[:space:]]+', ' ', 'g')) END)
              FROM "Participant" p WHERE p."sessionId" = s.id)::int AS people,
           (SELECT COALESCE(SUM(p.duration), 0)
              FROM "Participant" p WHERE p."sessionId" = s.id AND NOT p."isHost") AS "durationMs"
      FROM "MeetingSession" s
      JOIN "Meeting" m ON m.id = s."meetingId"
      LEFT JOIN (SELECT "meetingId", COUNT(*) AS n FROM "Registrant" GROUP BY "meetingId") rc
             ON rc."meetingId" = s."meetingId"
     WHERE s.status <> 'SCHEDULED' AND s."scheduledStart" >= ${twelveMonthsAgo}
     ORDER BY s."scheduledStart" ASC`;

  const recentSessions = held.slice(-30);

  let totalRegisteredInSessions = 0;
  let totalJoinedInSessions = 0;
  let totalGuestsInSessions = 0;

  const series = recentSessions.map((row) => {
    const registered = Number(row.registered);
    const joined = Number(row.joined);
    const people = Number(row.people);
    const guests = Math.max(0, people - joined);
    totalRegisteredInSessions += registered;
    totalJoinedInSessions += joined;
    totalGuestsInSessions += guests;
    return {
      sessionId: row.sessionId,
      meetingId: row.meetingId,
      topic: row.topic,
      label: row.scheduledStart.toISOString(),
      registered,
      joined,
      notJoined: Math.max(0, registered - joined),
      guests,
      people,
      durationMs: Number(row.durationMs),
    };
  });

  const monthlyMap = new Map<
    string,
    { month: string; sessions: number; registered: number; joined: number; people: number }
  >();
  for (const row of held) {
    const monthKey = row.scheduledStart.toLocaleDateString("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
    });
    const existing = monthlyMap.get(monthKey) ?? {
      month: row.scheduledStart.toLocaleDateString("en-IN", {
        timeZone: "Asia/Kolkata",
        month: "short",
        year: "numeric",
      }),
      sessions: 0,
      registered: 0,
      joined: 0,
      people: 0,
    };
    existing.sessions += 1;
    existing.registered += Number(row.registered);
    existing.joined += Number(row.joined);
    existing.people += Number(row.people);
    monthlyMap.set(monthKey, existing);
  }

  const monthly = [...monthlyMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, value]) => value);

  const attendanceRate =
    totalRegisteredInSessions > 0
      ? Math.round((totalJoinedInSessions / totalRegisteredInSessions) * 100)
      : 0;

  const sessionStatus = {
    SCHEDULED: 0,
    LIVE: 0,
    ENDED: 0,
  };
  for (const group of sessionStatusGroups) {
    sessionStatus[group.status] = group._count._all;
  }
  const liveSessions = sessionStatus.LIVE;
  const endedSessions = sessionStatus.ENDED;
  const scheduledSessions = sessionStatus.SCHEDULED;

  res.json({
    totals: {
      meetings: totalMeetings,
      registrants: totalRegistrants,
      sessions: totalSessions,
      liveSessions,
      endedSessions,
      scheduledSessions,
      attendanceRate,
      guests: totalGuestsInSessions,
      notJoined: Math.max(0, totalRegisteredInSessions - totalJoinedInSessions),
      avgRegistrantsPerMeeting:
        totalMeetings > 0 ? Math.round(totalRegistrants / totalMeetings) : 0,
    },
    sessionStatus,
    monthly,
    sixADistribution: sixAGroups.map((g) => ({
      rank: g.sixABonus || "Unknown",
      count: g._count._all,
    })),
    topMeetings: topMeetingsRaw.map((m) => ({
      meetingId: m.id,
      topic: m.topic,
      registrants: m._count.registrants,
      sessions: m._count.sessions,
    })),
    series,
  });
}));

function resolveIsHost(
  p: { isHost: boolean; userId: string | null; email: string },
  meetingHostId: string | null | undefined,
  meetingHostEmail: string | null | undefined
) {
  if (p.isHost) return true;
  if (meetingHostId && p.userId === meetingHostId) return true;
  if (meetingHostEmail && p.email === meetingHostEmail) return true;
  return false;
}

// ── GET /api/users/:email/profile ─────────────────────────────────────────────
router.get("/users/:email/profile", asyncRoute<{ email: string }>(async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const meetingFilter = req.query.meetingId as string | undefined;
  const fromDate = req.query.fromDate as string | undefined;
  const toDate = req.query.toDate as string | undefined;

  const [registrants, participants] = await Promise.all([
    prisma.registrant.findMany({
      where: { email },
      include: { meeting: { select: { id: true, topic: true, type: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.participant.findMany({
      where: {
        email,
        ...(meetingFilter
          ? { session: { meetingId: meetingFilter } }
          : {}),
      },
      include: {
        session: {
          include: {
            meeting: { select: { id: true, topic: true, type: true, hostId: true, hostEmail: true } },
          },
        },
      },
      orderBy: { joinTime: "desc" },
    }),
  ]);

  const regByMeeting = new Map(registrants.map((r) => [r.meetingId, r]));
  const joinedMeetingIds = new Set<string>();

  type ActivityRow = {
    id: string;
    meetingId: string;
    meetingTopic: string;
    sessionId: string | null;
    occurrenceId: string | null;
    scheduledStart: string | null;
    sessionStatus: string | null;
    role: "HOST" | "REGISTRANT" | "GUEST";
    isHost: boolean;
    isRegistrant: boolean;
    attendanceStatus: string;
    sixABonus: string;
    registeredAt: string | null;
    registrationStatus: string | null;
    joinTime: string | null;
    leaveTime: string | null;
    durationMs: number;
    joinCount: number;
    segmentIndex: number;
    totalSegments: number;
  };

  const activityLog: ActivityRow[] = [];

  for (const p of participants) {
    const reg = regByMeeting.get(p.session.meeting.id);
    const isHost = resolveIsHost(
      p,
      p.session.meeting.hostId,
      p.session.meeting.hostEmail
    );
    const isRegistrant = !!reg;
    const role: ActivityRow["role"] = isHost
      ? "HOST"
      : isRegistrant
        ? "REGISTRANT"
        : "GUEST";

    joinedMeetingIds.add(p.session.meeting.id);

    const history = Array.isArray(p.joinHistory)
      ? (p.joinHistory as unknown as JoinSegment[])
      : [];
    const segments: JoinSegment[] =
      history.length > 0
        ? [...history].sort((x, y) => x.joinTime.localeCompare(y.joinTime))
        : [
            {
              joinTime: p.joinTime.toISOString(),
              leaveTime: p.leaveTime?.toISOString() ?? null,
            },
          ];
    const inMeeting = p.status === "IN_MEETING";
    const leaves = segments
      .map((seg) => seg.leaveTime)
      .filter((t): t is string => !!t)
      .sort();

    // One row per session: first join, last leave, total time, number of joins.
    activityLog.push({
      id: p.id,
      meetingId: p.session.meeting.id,
      meetingTopic: p.session.meeting.topic,
      sessionId: p.session.id,
      occurrenceId: p.session.occurrenceId,
      scheduledStart: p.session.scheduledStart.toISOString(),
      sessionStatus: p.session.status,
      role,
      isHost,
      isRegistrant,
      attendanceStatus: p.status,
      sixABonus: reg?.sixABonus ?? "",
      registeredAt: reg?.createdAt.toISOString() ?? null,
      registrationStatus: reg?.status ?? null,
      joinTime: segments[0]?.joinTime ?? null,
      leaveTime: inMeeting ? null : (leaves[leaves.length - 1] ?? null),
      durationMs: unionDurationMs(segments, inMeeting),
      joinCount: segments.length,
      // Kept for API compatibility: one row now covers every join.
      segmentIndex: 1,
      totalSegments: segments.length,
    });
  }

  // Registrations where user never joined any session for that meeting
  for (const reg of registrants) {
    if (meetingFilter && reg.meetingId !== meetingFilter) continue;
    if (joinedMeetingIds.has(reg.meetingId)) continue;

    activityLog.push({
      id: `reg-${reg.id}`,
      meetingId: reg.meetingId,
      meetingTopic: reg.meeting.topic,
      sessionId: null,
      occurrenceId: null,
      scheduledStart: null,
      sessionStatus: null,
      role: "REGISTRANT",
      isHost: false,
      isRegistrant: true,
      attendanceStatus: "NOT_JOINED",
      sixABonus: reg.sixABonus,
      registeredAt: reg.createdAt.toISOString(),
      registrationStatus: reg.status,
      joinTime: null,
      leaveTime: null,
      durationMs: 0,
      joinCount: 0,
      segmentIndex: 0,
      totalSegments: 0,
    });
  }

  let filteredLog = activityLog;

  if (meetingFilter) {
    filteredLog = filteredLog.filter((r) => r.meetingId === meetingFilter);
  }

  if (fromDate || toDate) {
    filteredLog = filteredLog.filter((r) => {
      const dateKey = (r.joinTime ?? r.registeredAt ?? r.scheduledStart)?.slice(0, 10);
      if (!dateKey) return true;
      if (fromDate && dateKey < fromDate) return false;
      if (toDate && dateKey > toDate) return false;
      return true;
    });
  }

  filteredLog.sort((a, b) => {
    const aTime = new Date(a.joinTime ?? a.registeredAt ?? 0).getTime();
    const bTime = new Date(b.joinTime ?? b.registeredAt ?? 0).getTime();
    return bTime - aTime;
  });

  const joinedRows = filteredLog.filter((r) => r.joinTime);
  const totalDurationMs = joinedRows.reduce((sum, r) => sum + r.durationMs, 0);
  const name =
    registrants[0]?.name ||
    participants[0]?.name ||
    email.split("@")[0];
  const sixABonus = registrants.find((r) => r.sixABonus)?.sixABonus ?? "";

  res.json({
    email,
    name,
    sixABonus,
    totalDurationMs,
    totalMeetingsJoined: new Set(joinedRows.map((r) => r.meetingId)).size,
    totalSessions: joinedRows.length,
    totalRegistrations: registrants.length,
    activityLog: filteredLog,
  });
}));

// ── POST /api/meetings/:meetingId/registrants/sync ───────────────────────────
router.post("/meetings/:meetingId/registrants/sync", asyncRoute<{ meetingId: string }>(async (req, res) => {
  const { meetingId } = req.params;
  const occurrenceId = req.query.occurrenceId as string | undefined;

  let meeting = await prisma.meeting.findUnique({ where: { id: meetingId } });

  if (!meeting) {
    try {
      const detail = await getMeetingDetails(meetingId);
      meeting = await prisma.meeting.upsert({
        where: { id: meetingId },
        create: {
          id: meetingId,
          topic: detail.topic,
          timezone: detail.timezone ?? null,
          type: detail.type,
          joinUrl: detail.join_url ?? null,
        },
        update: {
          topic: detail.topic,
          joinUrl: detail.join_url ?? null,
        },
      });
    } catch (err: any) {
      const status = err.response?.status;
      console.error(
        `[SYNC] Failed to fetch meeting ${meetingId}:`,
        err.response?.data ?? err.message
      );
      if (status === 404) {
        return res.status(404).json({ error: "Meeting not found on Zoom" });
      }
      return res.status(502).json({ error: "Failed to fetch meeting from Zoom" });
    }
  }

  try {
    const zoomRegistrants = await listMeetingRegistrants(meetingId, occurrenceId);
    let created = 0;
    let updated = 0;

    for (const raw of zoomRegistrants) {
      const data = normalizeZoomRegistrant(raw);
      const result = await upsertRegistrant(meetingId, data);
      if (result === "created") created++;
      else updated++;
    }

    console.log(
      `[SYNC] Meeting ${meetingId}: ${zoomRegistrants.length} registrant(s) — ${created} created, ${updated} updated`
    );

    res.json({
      synced: zoomRegistrants.length,
      created,
      updated,
      total: zoomRegistrants.length,
    });
  } catch (err: any) {
    const status = err.response?.status;
    const zoomCode = err.response?.data?.code;
    const zoomMessage =
      err.response?.data?.message ?? err.response?.data?.code ?? err.message;
    console.error(
      `[SYNC] Failed to fetch registrants for ${meetingId}:`,
      err.response?.data ?? err.message
    );

    // Zoom deletes instant meetings once they end.
    if (zoomCode === 3001) {
      return res.status(404).json({
        error:
          "This meeting no longer exists on Zoom (instant meetings are removed after they end). Attendance already recorded is unaffected.",
      });
    }
    if (typeof zoomMessage === "string" && /registration has not been enabled/i.test(zoomMessage)) {
      return res.status(400).json({
        error:
          "Registration is not enabled for this meeting, so there are no registrants to fetch. Everyone who joins still appears as a guest.",
      });
    }

    if (status === 404) {
      return res.status(404).json({
        error: "Meeting not found or registration is not enabled",
      });
    }
    if (status === 400) {
      return res.status(400).json({
        error: zoomMessage || "Unable to list registrants for this meeting",
      });
    }
    return res.status(502).json({
      error: "Failed to fetch registrants from Zoom",
    });
  }
}));

// ── GET /api/meetings/:meetingId/attendance ───────────────────────────────────
// One row per person (see people.ts). Pick the session by sessionId, else by
// occurrenceId, else the LIVE one, else the most recent.
router.get("/meetings/:meetingId/attendance", asyncRoute<{ meetingId: string }>(async (req, res) => {
  const { meetingId } = req.params;
  const occurrenceId = req.query.occurrenceId as string | undefined;
  const sessionId = req.query.sessionId as string | undefined;

  const findSession = async () => {
    if (sessionId) {
      return prisma.meetingSession.findFirst({ where: { id: sessionId, meetingId } });
    }
    if (occurrenceId) {
      return prisma.meetingSession.findFirst({ where: { meetingId, occurrenceId } });
    }
    return (
      (await prisma.meetingSession.findFirst({ where: { meetingId, status: "LIVE" } })) ??
      (await prisma.meetingSession.findFirst({
        where: { meetingId, status: { not: "SCHEDULED" } },
        orderBy: { scheduledStart: "desc" },
      })) ??
      prisma.meetingSession.findFirst({
        where: { meetingId },
        orderBy: { scheduledStart: "desc" },
      })
    );
  };

  const [meeting, registrants, session] = await Promise.all([
    prisma.meeting.findUnique({ where: { id: meetingId } }),
    prisma.registrant.findMany({ where: { meetingId } }),
    findSession(),
  ]);

  const participants = session
    ? await prisma.participant.findMany({ where: { sessionId: session.id } })
    : [];

  const now = Date.now();
  const people = mergePeople(
    participants,
    registrants,
    { hostId: meeting?.hostId, hostEmail: meeting?.hostEmail },
    now
  );

  const registrantsJoined = people.filter(
    (p) => p.isRegistrant && p.status !== "NOT_JOINED"
  ).length;
  const notJoined = people.filter((p) => p.status === "NOT_JOINED").length;
  const joinedPeople = people.filter((p) => p.status !== "NOT_JOINED");
  const attendees = joinedPeople.filter((p) => !p.isHost);

  const sixARanks = [
    ...new Set(
      registrants.map((r) => r.sixABonus).filter((v) => v && v.trim() !== "")
    ),
  ].sort();

  res.json({
    meetingId,
    topic: meeting?.topic ?? "Meeting",
    occurrenceId: session?.occurrenceId ?? occurrenceId ?? null,
    sessionId: session?.id ?? null,
    status: session?.status ?? "SCHEDULED",
    startTime: session?.scheduledStart ?? null,
    endTime: session?.endTime ?? null,
    totalRegistered: registrants.length,
    registrantsJoined,
    notJoined,
    totalInMeeting: people.filter((p) => p.status === "IN_MEETING").length,
    totalPeople: people.length,
    totalJoined: joinedPeople.length,
    peakInMeeting: peakConcurrent(joinedPeople, now),
    avgDurationMs:
      attendees.length > 0
        ? Math.round(attendees.reduce((sum, p) => sum + p.duration, 0) / attendees.length)
        : 0,
    sixARanks,
    people,
  });
}));

// ── GET /api/status ───────────────────────────────────────────────────────────
// Is Zoom still reaching us, and is any meeting being waited on but never
// started on this Zoom account (e.g. the host now uses another account)?
const STALE_WAIT_MS = 12 * 60 * 60 * 1000;

router.get("/status", asyncRoute(async (_req, res) => {
  const [waitedMeetings, lastStarts] = await Promise.all([
    prisma.meeting.findMany({
      where: { lastWaitingAt: { not: null } },
      select: { id: true, topic: true, lastWaitingAt: true },
    }),
    prisma.meetingSession.groupBy({
      by: ["meetingId"],
      where: { status: { not: "SCHEDULED" } },
      _max: { scheduledStart: true },
    }),
  ]);

  const lastStartByMeeting = new Map(
    lastStarts.map((g) => [g.meetingId, g._max.scheduledStart])
  );

  const meetings = waitedMeetings
    .map((m) => {
      const lastStartedAt = lastStartByMeeting.get(m.id) ?? null;
      const waitedAt = m.lastWaitingAt!;
      const notStarted =
        !lastStartedAt || waitedAt.getTime() - lastStartedAt.getTime() > STALE_WAIT_MS;
      return {
        meetingId: m.id,
        topic: m.topic,
        lastWaitingAt: waitedAt,
        lastStartedAt,
        notStarted,
      };
    })
    .sort((a, b) => b.lastWaitingAt.getTime() - a.lastWaitingAt.getTime());

  res.json({
    lastWebhookAt: getLastWebhookAt(),
    meetings,
  });
}));

// ── GET /api/registrations ────────────────────────────────────────────────────
router.get("/registrations", asyncRoute(async (req, res) => {
  const meetingId = req.query.meetingId as string | undefined;
  const sixA = req.query.sixA as string | undefined;
  const search = req.query.search as string | undefined;

  const registrants = await prisma.registrant.findMany({
    where: {
      ...(meetingId ? { meetingId } : {}),
      ...(sixA ? { sixABonus: sixA } : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { email: { contains: search, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    include: {
      meeting: { select: { id: true, topic: true, type: true } },
    },
  });

  const sixARanks = [
    ...new Set(
      (
        await prisma.registrant.findMany({
          where: { sixABonus: { not: "" } },
          select: { sixABonus: true },
          distinct: ["sixABonus"],
        })
      ).map((r) => r.sixABonus)
    ),
  ].sort();

  res.json({
    total: registrants.length,
    sixARanks,
    registrations: registrants.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      firstName: r.firstName,
      lastName: r.lastName,
      sixABonus: r.sixABonus,
      status: r.status,
      joinUrl: r.joinUrl,
      createdAt: r.createdAt,
      meeting: r.meeting,
    })),
  });
}));

export default router;
