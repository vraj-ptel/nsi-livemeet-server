import { Request, Response } from "express";
import { Server as SocketIOServer } from "socket.io";
import { prisma } from "./db";
import { seedSessionsForMeeting } from "./api";
import {
  normalizeZoomRegistrant,
  upsertRegistrant,
} from "./registrants";
import fs from "fs";
import path from "path";

// One JSON object per line, appended — never re-read on the hot path.
const PAYLOAD_LOG_FILE =
  process.env.WEBHOOK_PAYLOAD_LOG ??
  path.join(process.cwd(), "logs", "webhook-payloads.ndjson");

// Zoom events we receive but intentionally don't act on (kept out of the logs).
const IGNORED_EVENTS = new Set([
  "meeting.participant_jbh_waiting",
  "meeting.participant_jbh_waiting_left",
  "meeting.participant_joined_waiting_room",
  "meeting.participant_left_waiting_room",
  "meeting.participant_put_in_waiting_room",
  "meeting.participant_admitted",
  "meeting.sharing_started",
  "meeting.sharing_ended",
  "meeting.aic_transcript_completed",
  "meeting.deleted",
  "user.updated",
]);

interface JoinSession {
  joinTime: string;
  leaveTime: string | null;
}

function savePayload(event: string, payload: unknown) {
  const line =
    JSON.stringify({ receivedAt: new Date().toISOString(), event, payload }) + "\n";
  fs.promises
    .mkdir(path.dirname(PAYLOAD_LOG_FILE), { recursive: true })
    .then(() => fs.promises.appendFile(PAYLOAD_LOG_FILE, line, "utf-8"))
    .catch((err) => console.error("[PAYLOAD SAVE ERROR]", err.message));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Stable per-meeting identity for a participant (stored in Participant.email).
 * Zoom only sends an email for signed-in users. Guests get a new user_id on
 * every rejoin, but keep the same participant_uuid within a meeting.
 */
export function participantKey(p: Record<string, any>): string {
  if (p.email) return p.email;
  if (p.participant_uuid) return `zoom:${p.participant_uuid}`;
  return p.user_id || p.user_name || "";
}

/**
 * Participant rows created before participantKey existed were keyed by user_id.
 * Fall back to that so a deploy mid-meeting doesn't orphan leave events.
 */
async function findParticipantRow(sessionId: string, p: Record<string, any>) {
  const key = participantKey(p);
  const row = await prisma.participant.findUnique({
    where: { sessionId_email: { sessionId, email: key } },
  });
  if (row || !p.user_id || p.user_id === key) return row;
  return prisma.participant.findUnique({
    where: { sessionId_email: { sessionId, email: p.user_id } },
  });
}

/**
 * Ensure a parent Meeting row exists.
 */
async function ensureMeeting(
  meetingId: string,
  fields: {
    topic?: string;
    timezone?: string;
    type?: number;
    joinUrl?: string;
    hostId?: string;
    hostEmail?: string;
  }
) {
  await prisma.meeting.upsert({
    where: { id: meetingId },
    create: {
      id: meetingId,
      topic: fields.topic ?? "Unknown",
      timezone: fields.timezone ?? null,
      type: fields.type ?? 2,
      joinUrl: fields.joinUrl ?? null,
      hostId: fields.hostId ?? null,
      hostEmail: fields.hostEmail ?? null,
    },
    update: {
      ...(fields.topic ? { topic: fields.topic } : {}),
      ...(fields.joinUrl ? { joinUrl: fields.joinUrl } : {}),
      ...(fields.hostId ? { hostId: fields.hostId } : {}),
      ...(fields.hostEmail ? { hostEmail: fields.hostEmail } : {}),
    },
  });
}

function isParticipantHost(
  participant: Record<string, any>,
  hostId?: string
): boolean {
  if (!hostId) return false;
  const pid =
    participant.participant_user_id ||
    participant.id ||
    participant.user_id;
  return pid === hostId;
}

/**
 * Find the MeetingSession for a given meeting whose scheduledStart is
 * closest to `actualStart` within a ±45 minute window.
 * Used to link meeting.started (actual time) → occurrence (scheduled time).
 */
async function findNearestSession(meetingId: string, actualStart: Date) {
  const window = 45 * 60 * 1000; // 45 min tolerance
  const sessions = await prisma.meetingSession.findMany({
    where: {
      meetingId,
      scheduledStart: {
        gte: new Date(actualStart.getTime() - window),
        lte: new Date(actualStart.getTime() + window),
      },
    },
    orderBy: { scheduledStart: "asc" },
  });

  if (sessions.length === 0) return null;

  // Return closest to actualStart
  return sessions.reduce((best, s) =>
    Math.abs(s.scheduledStart.getTime() - actualStart.getTime()) <
    Math.abs(best.scheduledStart.getTime() - actualStart.getTime())
      ? s
      : best
  );
}

export function createWebhookHandler(io: SocketIOServer) {
  return async function handleWebhook(req: Request, res: Response) {
    const { event, payload } = req.body as {
      event: string;
      payload: Record<string, any>;
    };

    savePayload(event, payload);

    if (IGNORED_EVENTS.has(event)) {
      res.status(200).send();
      return;
    }
    console.log(`[WEBHOOK] ${event}`);

    const obj = payload?.object ?? {};
    const meetingId = obj.id?.toString() ?? "";
    const meetingUuid = obj.uuid ?? "";

    try {
      switch (event) {
        // ── Meeting created ──────────────────────────────────────────────────────
        // Contains the full occurrences[] array — use this to seed MeetingSession rows.
        case "meeting.created": {
          if (!meetingId) break;

          await ensureMeeting(meetingId, {
            topic: obj.topic,
            timezone: obj.timezone,
            type: obj.type,
            joinUrl: obj.join_url,
            hostId: obj.host_id,
            hostEmail: obj.host_email,
          });

          const occurrences: any[] = obj.occurrences ?? [];

          if (occurrences.length > 0) {
            // Recurring meeting — create one MeetingSession per occurrence
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
                  duration: occ.duration ?? obj.duration ?? 60,
                  status: "SCHEDULED",
                },
                update: {
                  duration: occ.duration ?? obj.duration ?? 60,
                },
              });
            }
            console.log(
              `[CREATED] Recurring meeting ${meetingId} — seeded ${occurrences.length} sessions`
            );
          } else {
            // One-time meeting — single session, occurrenceId=null.
            // Prisma can't upsert on a compound unique containing null, so check first.
            const existing = await prisma.meetingSession.findFirst({
              where: { meetingId, occurrenceId: null },
            });
            if (!existing) {
              await prisma.meetingSession.create({
                data: {
                  meetingId,
                  occurrenceId: null,
                  scheduledStart: new Date(obj.start_time ?? Date.now()),
                  duration: obj.duration ?? 60,
                  status: "SCHEDULED",
                },
              });
            }
            console.log(`[CREATED] One-time meeting ${meetingId}`);
          }
          break;
        }

        // ── Meeting started ──────────────────────────────────────────────────────
        case "meeting.started": {
          if (!meetingId) break;

          // Ensure parent row exists (in case meeting.created wasn't received)
          await ensureMeeting(meetingId, {
            topic: obj.topic,
            timezone: obj.timezone,
            type: obj.type,
            hostId: obj.host_id,
            hostEmail: obj.host_email,
          });

          const actualStart = obj.start_time ? new Date(obj.start_time) : new Date();

          // Find the session whose scheduledStart is nearest to actual start
          let session = await findNearestSession(meetingId, actualStart);

          if (!session && obj.type === 8) {
            // It's a recurring meeting but we found no session.
            // This means meeting.created didn't seed it (e.g. created before our app was running).
            // Let's seed it now dynamically.
            console.log(`[STARTED] No session found for ${meetingId}, attempting to seed from Zoom...`);
            await seedSessionsForMeeting(meetingId, obj.topic, obj.type, obj.join_url, obj.timezone);
            session = await findNearestSession(meetingId, actualStart);
          }

          if (!session) {
            // Still no session (or it's a one-time meeting) — create on-the-fly
            session = await prisma.meetingSession.create({
              data: {
                meetingId,
                occurrenceId: null,
                uuid: meetingUuid,
                scheduledStart: actualStart,
                duration: obj.duration ?? 60,
                status: "LIVE",
              },
            });
            console.log(`[STARTED] Created on-the-fly session for ${meetingId}`);
          } else {
            // Update found session with uuid and status
            session = await prisma.meetingSession.update({
              where: { id: session.id },
              data: { uuid: meetingUuid, status: "LIVE" },
            });
            console.log(
              `[STARTED] Meeting ${meetingId} — session ${session.id} (uuid: ${meetingUuid}) LIVE`
            );
          }

          io.to(`meeting-${meetingId}`).emit("meeting-started", {
            meetingId,
            sessionId: session.id,
            occurrenceId: session.occurrenceId,
          });
          break;
        }

        // ── Meeting ended ────────────────────────────────────────────────────────
        case "meeting.ended": {
          // Find session by uuid (set during meeting.started)
          const session = await prisma.meetingSession.findFirst({
            where: { uuid: meetingUuid },
          });

          if (session) {
            await prisma.meetingSession.update({
              where: { id: session.id },
              data: {
                status: "ENDED",
                endTime: obj.end_time ? new Date(obj.end_time) : new Date(),
              },
            });
            console.log(`[ENDED] Session ${session.id} for meeting ${meetingId}`);
          }

          io.to(`meeting-${meetingId}`).emit("meeting-ended", { meetingId });
          break;
        }

        // ── Registration ─────────────────────────────────────────────────────────
        case "meeting.registration_created": {
          const r = obj.registrant ?? {};

          // Ensure parent meeting exists
          await ensureMeeting(meetingId, {
            topic: obj.topic,
            timezone: obj.timezone,
            type: obj.type,
            joinUrl: obj.join_url,
            hostId: obj.host_id,
            hostEmail: obj.host_email,
          });

          const registrant = normalizeZoomRegistrant({
            id: r.id,
            email: r.email,
            first_name: r.first_name,
            last_name: r.last_name,
            custom_questions: r.custom_questions,
            join_url: r.join_url,
            status: r.status,
          });

          await upsertRegistrant(meetingId, registrant);

          io.to(`meeting-${meetingId}`).emit("user-registered", { meetingId });
          console.log(
            `[REG] ${r.first_name} ${r.last_name} (${r.email}) → 6A: "${registrant.sixABonus}"`
          );
          break;
        }

        // ── Participant role changed (host/co-host) ─────────────────────────────
        case "meeting.participant_role_changed": {
          const p = obj.participant ?? {};

          const session = await prisma.meetingSession.findFirst({
            where: { uuid: meetingUuid },
          });
          const row = session ? await findParticipantRow(session.id, p) : null;
          if (row) {
            await prisma.participant.update({
              where: { id: row.id },
              data: { isHost: p.new_role === "host" },
            });
          }
          break;
        }

        // ── Participant joined ────────────────────────────────────────────────────
        case "meeting.participant_joined": {
          const p = obj.participant ?? {};
          const email = participantKey(p);
          const joinTime = new Date(p.join_time);
          const hostFlag = isParticipantHost(p, obj.host_id);

          if (obj.host_id || obj.host_email) {
            await ensureMeeting(meetingId, {
              hostId: obj.host_id,
              hostEmail: obj.host_email,
            });
          }

          // Find the LIVE session for this meeting via uuid
          const session = await prisma.meetingSession.findFirst({
            where: { uuid: meetingUuid, status: "LIVE" },
          });

          if (!session) {
            console.warn(
              `[JOIN] No LIVE session found for meeting ${meetingId} uuid=${meetingUuid}. Participant ${email} skipped.`
            );
            break;
          }

          const existing = await prisma.participant.findUnique({
            where: { sessionId_email: { sessionId: session.id, email } },
          });

          const history: JoinSession[] = existing
            ? (existing.joinHistory as unknown as JoinSession[])
            : [];
          // A rejoin can arrive before the matching leave — close the open segment
          // so it doesn't keep accruing duration forever.
          const open = history[history.length - 1];
          if (open && !open.leaveTime) open.leaveTime = joinTime.toISOString();
          history.push({ joinTime: joinTime.toISOString(), leaveTime: null });

          const zoomUserId = p.participant_user_id || p.id || p.user_id || null;

          await prisma.participant.upsert({
            where: { sessionId_email: { sessionId: session.id, email } },
            create: {
              sessionId: session.id,
              email,
              name: p.user_name ?? "",
              userId: zoomUserId,
              isHost: hostFlag,
              status: "IN_MEETING",
              joinTime,
              joinHistory: JSON.parse(JSON.stringify(history)),
            },
            update: {
              status: "IN_MEETING",
              joinTime,
              leaveTime: null,
              isHost: hostFlag,
              userId: zoomUserId ?? undefined,
              joinHistory: JSON.parse(JSON.stringify(history)),
            },
          });

          const participant = await prisma.participant.findUnique({
            where: { sessionId_email: { sessionId: session.id, email } },
          });

          io.to(`meeting-${meetingId}`).emit("participant-joined", {
            meetingId,
            sessionId: session.id,
            participant,
          });
          console.log(
            `[JOIN] ${p.user_name} (${email}) → session ${session.id}`
          );
          break;
        }

        // ── Participant left ──────────────────────────────────────────────────────
        case "meeting.participant_left": {
          const p = obj.participant ?? {};
          const leaveTime = new Date(p.leave_time);

          const session = await prisma.meetingSession.findFirst({
            where: { uuid: meetingUuid },
          });

          if (!session) {
            console.warn(`[LEFT] No session found for uuid=${meetingUuid}`);
            break;
          }

          const existing = await findParticipantRow(session.id, p);

          if (existing) {
            const history = existing.joinHistory as unknown as JoinSession[];
            const lastSession = history[history.length - 1];
            if (lastSession) lastSession.leaveTime = leaveTime.toISOString();

            const duration = history.reduce((total, s) => {
              const end = s.leaveTime ? new Date(s.leaveTime) : new Date();
              return total + (end.getTime() - new Date(s.joinTime).getTime());
            }, 0);

            const participant = await prisma.participant.update({
              where: { id: existing.id },
              data: {
                status: "LEFT",
                leaveTime,
                duration,
                joinHistory: JSON.parse(JSON.stringify(history)),
              },
            });

            io.to(`meeting-${meetingId}`).emit("participant-left", {
              meetingId,
              sessionId: session.id,
              participant,
            });
            console.log(`[LEFT] ${p.user_name} (${existing.email}) ← session ${session.id}`);
          }
          break;
        }

        default:
          console.log(`[WEBHOOK] Unhandled event: ${event}`);
      }
    } catch (err: any) {
      // Non-2xx makes Zoom retry the delivery; handlers are upserts, so a retry is safe.
      console.error(`[WEBHOOK] ${event} failed for meeting ${meetingId}:`, err?.message ?? err);
      res.status(500).send();
      return;
    }

    res.status(200).send();
  };
}
