import { Router } from "express";
import { prisma } from "./db";
import { getUpcomingMeetings, getZoomToken } from "./zoom";
import axios from "axios";

const router = Router();

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

    // Fetch all LIVE/ENDED sessions from DB for status overlay
    const liveSessions = await prisma.meetingSession.findMany({
      where: { status: { in: ["LIVE", "ENDED"] } },
      select: { meetingId: true, occurrenceId: true, status: true },
    });

    // Build lookup: "meetingId:occurrenceId" → status
    const statusMap = new Map(
      liveSessions.map((s) => [
        `${s.meetingId}:${s.occurrenceId ?? ""}`,
        s.status,
      ])
    );

    const result = occurrences.map((occ) => {
      const key = `${occ.id}:${occ.occurrenceId ?? ""}`;
      const dbStatus = statusMap.get(key);
      return {
        id: occ.id,
        uuid: occ.uuid,
        occurrenceId: occ.occurrenceId ?? null,
        topic: occ.topic,
        startTime: occ.startTime,
        duration: occ.duration,
        joinUrl: occ.joinUrl,
        status: dbStatus ?? "SCHEDULED",
      };
    });

    res.json(result);
  } catch (err: any) {
    console.error("Zoom API error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch meetings" });
  }
});

// ── GET /api/meetings/:meetingId/attendance ───────────────────────────────────
// ?occurrenceId=1780727400000   — recurring meeting occurrence
// (no param)                   — one-time meeting (uses most recent/live session)
router.get("/meetings/:meetingId/attendance", async (req, res) => {
  const { meetingId } = req.params;
  const occurrenceId = req.query.occurrenceId as string | undefined;

  // Fetch registrants (registered for the whole series)
  const registrants = await prisma.registrant.findMany({
    where: { meetingId },
  });

  // Find the relevant MeetingSession
  let session: Awaited<ReturnType<typeof prisma.meetingSession.findFirst>> = null;

  if (occurrenceId) {
    // Recurring: look up by occurrenceId
    session = await prisma.meetingSession.findFirst({
      where: { meetingId, occurrenceId },
    });
  } else {
    // One-time: use LIVE session first, then most recent ENDED
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

  // Participants for this session only
  const participants = session
    ? await prisma.participant.findMany({ where: { sessionId: session.id } })
    : [];

  const participantByEmail = new Map(participants.map((p) => [p.email, p]));

  const attendance = registrants.map((reg) => {
    const joined = participantByEmail.get(reg.email);
    return {
      email: reg.email,
      name: reg.name,
      status: joined ? joined.status : "NOT_JOINED",
      sixABonus: reg.sixABonus || "",
      joinTime: joined?.joinTime ?? null,
      leaveTime: joined?.leaveTime ?? null,
      duration: joined?.duration ?? 0,
      joinHistory: joined?.joinHistory ?? [],
    };
  });

  const registrantEmails = new Set(registrants.map((r) => r.email));
  const guests = participants
    .filter((p) => !registrantEmails.has(p.email))
    .map((p) => ({
      id: p.id,
      email: p.email,
      name: p.name,
      status: p.status,
      joinTime: p.joinTime,
      leaveTime: p.leaveTime,
      duration: p.duration,
      joinHistory: p.joinHistory,
    }));

  res.json({
    meetingId,
    occurrenceId: occurrenceId ?? null,
    sessionId: session?.id ?? null,
    status: session?.status ?? "SCHEDULED",
    startTime: session?.scheduledStart ?? null,
    endTime: session?.endTime ?? null,
    totalRegistered: registrants.length,
    totalJoined: participants.length,
    currentlyInMeeting: participants.filter((p) => p.status === "IN_MEETING")
      .length,
    attendance,
    guests,
  });
});

export default router;
