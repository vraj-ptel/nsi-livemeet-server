import { Router } from "express";
import { prisma } from "./db";
import { getUpcomingMeetings } from "./zoom";
import { MeetingStatus } from "@prisma/client";

const router = Router();

// ── GET /api/meetings/upcoming ────────────────────────────────────────────────
// Returns all upcoming meeting occurrences with correct LIVE status per occurrence.
router.get("/meetings/upcoming", async (req, res) => {
  try {
    const occurrences = await getUpcomingMeetings();

    // Fetch all LIVE / ENDED meetings from DB in one query
    const dbMeetings = await prisma.meeting.findMany({
      where: { status: { in: ["LIVE", "ENDED"] } },
      select: { id: true, uuid: true, status: true, occurrenceId: true },
    });

    // Build lookup: occurrenceId → status (for recurring) or id → status (for one-time)
    const liveByOccurrenceId = new Map(
      dbMeetings
        .filter((m) => m.occurrenceId)
        .map((m) => [m.occurrenceId!, m.status])
    );
    const liveById = new Map(
      dbMeetings
        .filter((m) => !m.occurrenceId)
        .map((m) => [m.id, m.status])
    );

    const result = occurrences.map((occ) => {
      let status: MeetingStatus = "SCHEDULED";
      if (occ.occurrenceId && liveByOccurrenceId.has(occ.occurrenceId)) {
        status = liveByOccurrenceId.get(occ.occurrenceId)!;
      } else if (!occ.occurrenceId && liveById.has(occ.id)) {
        status = liveById.get(occ.id)!;
      }
      return {
        id: occ.id,
        uuid: occ.uuid,
        occurrenceId: occ.occurrenceId ?? null,
        topic: occ.topic,
        startTime: occ.startTime,
        duration: occ.duration,
        joinUrl: occ.joinUrl,
        status,
      };
    });

    res.json(result);
  } catch (err: any) {
    console.error("Zoom API error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch meetings" });
  }
});

// ── GET /api/meetings/:meetingId/attendance ───────────────────────────────────
router.get("/meetings/:meetingId/attendance", async (req, res) => {
  const { meetingId } = req.params;

  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    include: {
      registrants: true,
      participants: true,
    },
  });

  if (!meeting) {
    // Meeting hasn't received any webhooks yet — return empty state
    return res.json({
      meetingId,
      status: "SCHEDULED",
      startTime: null,
      endTime: null,
      totalRegistered: 0,
      totalJoined: 0,
      currentlyInMeeting: 0,
      attendance: [],
      guests: [],
    });
  }

  const { registrants, participants } = meeting;

  // Build participant lookup by email
  const participantByEmail = new Map(participants.map((p) => [p.email, p]));

  // Merge registrants with participant data
  const attendance = registrants.map((reg) => {
    const joined = participantByEmail.get(reg.email);
    return {
      email: reg.email,
      name: reg.name,
      status: joined ? joined.status : "NOT_JOINED",
      sixABonus: reg.sixABonus || "-",
      joinTime: joined?.joinTime ?? null,
      leaveTime: joined?.leaveTime ?? null,
      duration: joined?.duration ?? 0,
      joinHistory: joined?.joinHistory ?? [],
    };
  });

  // Guests = participants not in registrant list
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
    meetingId: meeting.id,
    status: meeting.status,
    startTime: meeting.startTime,
    endTime: meeting.endTime,
    totalRegistered: registrants.length,
    totalJoined: participants.length,
    currentlyInMeeting: participants.filter((p) => p.status === "IN_MEETING")
      .length,
    attendance,
    guests,
  });
});

export default router;
