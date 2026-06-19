import { Router } from "express";
import { prisma } from "./db";
import {
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

function resolveOccurrenceStatus(
  meetingId: string,
  occurrenceId: string | null | undefined,
  startTime: string,
  dbSessions: {
    meetingId: string;
    occurrenceId: string | null;
    scheduledStart: Date;
    status: string;
  }[]
) {
  const exact = dbSessions.find(
    (s) =>
      s.meetingId === meetingId &&
      (s.occurrenceId ?? "") === (occurrenceId ?? "")
  );
  if (exact) return exact.status;

  const startMs = new Date(startTime).getTime();
  const near = dbSessions.find(
    (s) =>
      s.meetingId === meetingId &&
      Math.abs(s.scheduledStart.getTime() - startMs) < SESSION_MATCH_MS
  );
  return near?.status ?? null;
}

// ── GET /api/meetings/upcoming ────────────────────────────────────────────────
router.get("/meetings/upcoming", async (req, res) => {
  try {
    const occurrences = await getUpcomingMeetings();

    // Ensure all meetings/sessions exist in DB (seed if not)
    const seenMeetingIds = new Set<string>();
    for (const occ of occurrences) {
      if (seenMeetingIds.has(occ.id)) continue;
      seenMeetingIds.add(occ.id);

      const existingMeeting = await prisma.meeting.findUnique({
        where: { id: occ.id },
        include: { sessions: { where: { occurrenceId: { not: null } }, take: 1 } },
      });

      if (!existingMeeting || existingMeeting.sessions.length === 0) {
        await seedSessionsForMeeting(
          occ.id,
          occ.topic,
          occ.type,
          occ.joinUrl,
          undefined
        );
      }
    }

    // Fetch LIVE/ENDED sessions from DB (Zoom API omits in-progress occurrences)
    const dbSessions = await prisma.meetingSession.findMany({
      where: { status: { in: ["LIVE", "ENDED"] } },
      include: {
        meeting: { select: { topic: true, joinUrl: true, type: true } },
      },
    });

    type OccurrenceResult = {
      id: string;
      uuid: string;
      occurrenceId: string | null;
      topic: string;
      startTime: string;
      duration: number;
      joinUrl: string;
      status: string;
    };

    const result: OccurrenceResult[] = occurrences.map((occ) => ({
      id: occ.id,
      uuid: occ.uuid,
      occurrenceId: occ.occurrenceId ?? null,
      topic: occ.topic,
      startTime: occ.startTime,
      duration: occ.duration,
      joinUrl: occ.joinUrl,
      status:
        resolveOccurrenceStatus(
          occ.id,
          occ.occurrenceId,
          occ.startTime,
          dbSessions
        ) ?? "SCHEDULED",
    }));

    // Inject LIVE/ENDED sessions missing from Zoom list (e.g. currently live occurrence)
    const resultKeys = new Set(
      result.map((r) => `${r.id}:${r.occurrenceId ?? ""}`)
    );

    for (const session of dbSessions) {
      const key = `${session.meetingId}:${session.occurrenceId ?? ""}`;
      if (resultKeys.has(key)) continue;

      result.push({
        id: session.meetingId,
        uuid: session.occurrenceId ?? session.meetingId,
        occurrenceId: session.occurrenceId,
        topic: session.meeting.topic,
        startTime: session.scheduledStart.toISOString(),
        duration: session.duration,
        joinUrl: session.meeting.joinUrl ?? "",
        status: session.status,
      });
      resultKeys.add(key);
    }

    // LIVE meetings first, then by start time
    result.sort((a, b) => {
      if (a.status === "LIVE" && b.status !== "LIVE") return -1;
      if (b.status === "LIVE" && a.status !== "LIVE") return 1;
      return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
    });

    res.json(result);
  } catch (err: any) {
    console.error("Zoom API error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch meetings" });
  }
});

// ── GET /api/meetings/history ─────────────────────────────────────────────────
router.get("/meetings/history", async (_req, res) => {
  const meetings = await prisma.meeting.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      sessions: { orderBy: { scheduledStart: "desc" } },
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
});

// ── GET /api/dashboard/overview ───────────────────────────────────────────────
router.get("/dashboard/overview", async (_req, res) => {
  const [
    totalMeetings,
    totalRegistrants,
    totalSessions,
    liveSessions,
    endedSessions,
    scheduledSessions,
    sessionStatusGroups,
    sixAGroups,
    topMeetingsRaw,
  ] = await Promise.all([
    prisma.meeting.count(),
    prisma.registrant.count(),
    prisma.meetingSession.count(),
    prisma.meetingSession.count({ where: { status: "LIVE" } }),
    prisma.meetingSession.count({ where: { status: "ENDED" } }),
    prisma.meetingSession.count({ where: { status: "SCHEDULED" } }),
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

  const sessionsForCharts = await prisma.meetingSession.findMany({
    where: { scheduledStart: { gte: twelveMonthsAgo } },
    orderBy: { scheduledStart: "asc" },
    include: {
      meeting: {
        select: {
          id: true,
          topic: true,
          registrants: { select: { email: true } },
        },
      },
      participants: { select: { email: true } },
    },
  });

  const recentSessions = [...sessionsForCharts]
    .sort((a, b) => b.scheduledStart.getTime() - a.scheduledStart.getTime())
    .slice(0, 30)
    .reverse();

  let totalRegisteredInSessions = 0;
  let totalJoinedInSessions = 0;
  let totalGuestsInSessions = 0;

  const series = recentSessions.map((session) => {
    const registrantEmails = new Set(
      session.meeting.registrants.map((r) => r.email)
    );
    const registered = registrantEmails.size;
    const joined = session.participants.filter((p) =>
      registrantEmails.has(p.email)
    ).length;
    const guests = session.participants.filter(
      (p) => !registrantEmails.has(p.email)
    ).length;
    const notJoined = Math.max(0, registered - joined);

    totalRegisteredInSessions += registered;
    totalJoinedInSessions += joined;
    totalGuestsInSessions += guests;

    return {
      sessionId: session.id,
      meetingId: session.meetingId,
      topic: session.meeting.topic,
      label: session.scheduledStart.toISOString(),
      registered,
      joined,
      notJoined,
      guests,
    };
  });

  const monthlyMap = new Map<
    string,
    { month: string; sessions: number; registered: number; joined: number }
  >();

  for (const session of sessionsForCharts) {
    const monthKey = session.scheduledStart.toLocaleDateString("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
    });
    const monthLabel = session.scheduledStart.toLocaleDateString("en-IN", {
      timeZone: "Asia/Kolkata",
      month: "short",
      year: "numeric",
    });
    const registrantEmails = new Set(
      session.meeting.registrants.map((r) => r.email)
    );
    const joined = session.participants.filter((p) =>
      registrantEmails.has(p.email)
    ).length;

    const existing = monthlyMap.get(monthKey) ?? {
      month: monthLabel,
      sessions: 0,
      registered: 0,
      joined: 0,
    };
    existing.sessions += 1;
    existing.registered += registrantEmails.size;
    existing.joined += joined;
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
});

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

interface JoinSegment {
  joinTime: string;
  leaveTime: string | null;
}

function segmentDurationMs(joinTime: string, leaveTime: string | null) {
  const end = leaveTime ? new Date(leaveTime).getTime() : Date.now();
  return Math.max(0, end - new Date(joinTime).getTime());
}

// ── GET /api/users/:email/profile ─────────────────────────────────────────────
router.get("/users/:email/profile", async (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const meetingFilter = req.query.meetingId as string | undefined;
  const fromDate = req.query.fromDate as string | undefined;
  const toDate = req.query.toDate as string | undefined;

  const registrants = await prisma.registrant.findMany({
    where: { email },
    include: { meeting: { select: { id: true, topic: true, type: true } } },
    orderBy: { createdAt: "desc" },
  });

  const participants = await prisma.participant.findMany({
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
  });

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

    const history = (p.joinHistory as unknown as JoinSegment[]) ?? [];
    const segments: JoinSegment[] =
      history.length > 0
        ? history
        : [
            {
              joinTime: p.joinTime.toISOString(),
              leaveTime: p.leaveTime?.toISOString() ?? null,
            },
          ];

    segments.forEach((seg, idx) => {
      activityLog.push({
        id: `${p.id}-seg-${idx}`,
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
        joinTime: seg.joinTime,
        leaveTime: seg.leaveTime,
        durationMs: segmentDurationMs(seg.joinTime, seg.leaveTime),
        segmentIndex: idx + 1,
        totalSegments: segments.length,
      });
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
});

// ── POST /api/meetings/:meetingId/registrants/sync ───────────────────────────
router.post("/meetings/:meetingId/registrants/sync", async (req, res) => {
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
    const zoomMessage =
      err.response?.data?.message ?? err.response?.data?.code ?? err.message;
    console.error(
      `[SYNC] Failed to fetch registrants for ${meetingId}:`,
      err.response?.data ?? err.message
    );

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
});

// ── GET /api/meetings/:meetingId/attendance ───────────────────────────────────
router.get("/meetings/:meetingId/attendance", async (req, res) => {
  const { meetingId } = req.params;
  const occurrenceId = req.query.occurrenceId as string | undefined;

  const meeting = await prisma.meeting.findUnique({ where: { id: meetingId } });
  const registrants = await prisma.registrant.findMany({ where: { meetingId } });

  let session: Awaited<ReturnType<typeof prisma.meetingSession.findFirst>> = null;

  if (occurrenceId) {
    session = await prisma.meetingSession.findFirst({
      where: { meetingId, occurrenceId },
    });
  } else {
    session = await prisma.meetingSession.findFirst({
      where: { meetingId, status: "LIVE" },
    });
    if (!session) {
      session = await prisma.meetingSession.findFirst({
        where: { meetingId },
        orderBy: { scheduledStart: "desc" },
      });
    }
  }

  const participants = session
    ? await prisma.participant.findMany({ where: { sessionId: session.id } })
    : [];

  const participantByEmail = new Map(participants.map((p) => [p.email, p]));
  const registrantEmails = new Set(registrants.map((r) => r.email));

  type PersonRow = {
    id: string | null;
    email: string;
    name: string;
    role: "HOST" | "REGISTRANT" | "GUEST";
    isHost: boolean;
    isRegistrant: boolean;
    status: string;
    sixABonus: string;
    joinTime: Date | null;
    leaveTime: Date | null;
    duration: number;
    joinHistory: unknown;
  };

  const people: PersonRow[] = [];

  for (const reg of registrants) {
    const joined = participantByEmail.get(reg.email);
    const isHost = joined
      ? resolveIsHost(joined, meeting?.hostId, meeting?.hostEmail)
      : false;
    people.push({
      id: joined?.id ?? null,
      email: reg.email,
      name: reg.name,
      role: isHost ? "HOST" : "REGISTRANT",
      isHost,
      isRegistrant: true,
      status: joined ? joined.status : "NOT_JOINED",
      sixABonus: reg.sixABonus || "",
      joinTime: joined?.joinTime ?? null,
      leaveTime: joined?.leaveTime ?? null,
      duration: joined?.duration ?? 0,
      joinHistory: joined?.joinHistory ?? [],
    });
  }

  for (const p of participants) {
    if (registrantEmails.has(p.email)) continue;
    const isHost = resolveIsHost(p, meeting?.hostId, meeting?.hostEmail);
    people.push({
      id: p.id,
      email: p.email,
      name: p.name,
      role: isHost ? "HOST" : "GUEST",
      isHost,
      isRegistrant: false,
      status: p.status,
      sixABonus: "",
      joinTime: p.joinTime,
      leaveTime: p.leaveTime,
      duration: p.duration,
      joinHistory: p.joinHistory,
    });
  }

  people.sort((a, b) => {
    if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
    if (a.status === "IN_MEETING" && b.status !== "IN_MEETING") return -1;
    if (b.status === "IN_MEETING" && a.status !== "IN_MEETING") return 1;
    return a.name.localeCompare(b.name);
  });

  const registrantsJoined = people.filter(
    (p) => p.isRegistrant && p.status !== "NOT_JOINED"
  ).length;
  const notJoined = people.filter(
    (p) => p.isRegistrant && p.status === "NOT_JOINED"
  ).length;

  const sixARanks = [
    ...new Set(
      registrants.map((r) => r.sixABonus).filter((v) => v && v.trim() !== "")
    ),
  ].sort();

  res.json({
    meetingId,
    topic: meeting?.topic ?? "Meeting",
    occurrenceId: occurrenceId ?? null,
    sessionId: session?.id ?? null,
    status: session?.status ?? "SCHEDULED",
    startTime: session?.scheduledStart ?? null,
    endTime: session?.endTime ?? null,
    totalRegistered: registrants.length,
    registrantsJoined,
    notJoined,
    totalInMeeting: people.filter((p) => p.status === "IN_MEETING").length,
    totalPeople: people.length,
    sixARanks,
    people,
  });
});

// ── GET /api/registrations ────────────────────────────────────────────────────
router.get("/registrations", async (req, res) => {
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
});

export default router;
