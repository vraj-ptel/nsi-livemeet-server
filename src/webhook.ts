import { Request, Response } from "express";
import { Server as SocketIOServer } from "socket.io";
import { prisma } from "./db";
import { seedSessionsForMeeting } from "./api";
import fs from "fs";
import path from "path";

const PAYLOAD_LOG_FILE = path.join(__dirname, "../../webhook_payloads.json");

interface JoinSession {
  joinTime: string;
  leaveTime: string | null;
}

function savePayload(event: string, payload: unknown) {
  try {
    let log: unknown[] = [];
    if (fs.existsSync(PAYLOAD_LOG_FILE)) {
      const raw = fs.readFileSync(PAYLOAD_LOG_FILE, "utf-8");
      log = JSON.parse(raw);
    }
    log.push({ receivedAt: new Date().toISOString(), event, payload: JSON.parse(JSON.stringify(payload)) });
    fs.writeFileSync(PAYLOAD_LOG_FILE, JSON.stringify(log, null, 2), "utf-8");
  } catch (err: any) {
    console.error("[PAYLOAD SAVE ERROR]", err.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Ensure a parent Meeting row exists.
 */
async function ensureMeeting(
  meetingId: string,
  fields: { topic?: string; timezone?: string; type?: number; joinUrl?: string }
) {
  await prisma.meeting.upsert({
    where: { id: meetingId },
    create: {
      id: meetingId,
      topic: fields.topic ?? "Unknown",
      timezone: fields.timezone ?? null,
      type: fields.type ?? 2,
      joinUrl: fields.joinUrl ?? null,
    },
    update: {
      ...(fields.topic ? { topic: fields.topic } : {}),
      ...(fields.joinUrl ? { joinUrl: fields.joinUrl } : {}),
    },
  });
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

    console.log(`[WEBHOOK] ${event}`);
    savePayload(event, payload);

    const obj = payload.object ?? {};
    const meetingId = obj.id?.toString() ?? "";
    const meetingUuid = obj.uuid ?? "";

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
          // One-time meeting — single session, occurrenceId=null
          await prisma.meetingSession.upsert({
            where: { meetingId_occurrenceId: { meetingId, occurrenceId: null as any } },
            create: {
              meetingId,
              occurrenceId: null,
              scheduledStart: new Date(obj.start_time ?? Date.now()),
              duration: obj.duration ?? 60,
              status: "SCHEDULED",
            },
            update: {},
          }).catch(async () => {
            // Null unique key may fail — create if not exists
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
          });
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
        const sixABonus: string = r.custom_questions?.[0]?.value ?? "";

        // Ensure parent meeting exists
        await ensureMeeting(meetingId, {
          topic: obj.topic,
          timezone: obj.timezone,
          type: obj.type,
          joinUrl: obj.join_url,
        });

        await prisma.registrant.upsert({
          where: { meetingId_email: { meetingId, email: r.email } },
          create: {
            zoomId: r.id ?? "",
            meetingId,
            email: r.email,
            name: `${r.first_name} ${r.last_name}`.trim(),
            firstName: r.first_name ?? "",
            lastName: r.last_name ?? "",
            sixABonus,
            joinUrl: r.join_url ?? null,
            status: r.status ?? "approved",
          },
          update: {
            sixABonus,
            joinUrl: r.join_url ?? undefined,
            status: r.status ?? undefined,
          },
        });

        io.to(`meeting-${meetingId}`).emit("user-registered", { meetingId });
        console.log(
          `[REG] ${r.first_name} ${r.last_name} (${r.email}) → 6A: "${sixABonus}"`
        );
        break;
      }

      // ── Participant joined ────────────────────────────────────────────────────
      case "meeting.participant_joined": {
        const p = obj.participant ?? {};
        const email: string = p.email || p.user_id || p.user_name;
        const joinTime = new Date(p.join_time);

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
        history.push({ joinTime: joinTime.toISOString(), leaveTime: null });

        await prisma.participant.upsert({
          where: { sessionId_email: { sessionId: session.id, email } },
          create: {
            sessionId: session.id,
            email,
            name: p.user_name ?? "",
            userId: p.user_id ?? null,
            status: "IN_MEETING",
            joinTime,
            joinHistory: JSON.parse(JSON.stringify(history)),
          },
          update: {
            status: "IN_MEETING",
            joinTime,
            leaveTime: null,
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
        const email: string = p.email || p.user_id || p.user_name;
        const leaveTime = new Date(p.leave_time);

        const session = await prisma.meetingSession.findFirst({
          where: { uuid: meetingUuid },
        });

        if (!session) {
          console.warn(`[LEFT] No session found for uuid=${meetingUuid}`);
          break;
        }

        const existing = await prisma.participant.findUnique({
          where: { sessionId_email: { sessionId: session.id, email } },
        });

        if (existing) {
          const history = existing.joinHistory as unknown as JoinSession[];
          const lastSession = history[history.length - 1];
          if (lastSession) lastSession.leaveTime = leaveTime.toISOString();

          const duration = history.reduce((total, s) => {
            const end = s.leaveTime ? new Date(s.leaveTime) : new Date();
            return total + (end.getTime() - new Date(s.joinTime).getTime());
          }, 0);

          await prisma.participant.update({
            where: { sessionId_email: { sessionId: session.id, email } },
            data: {
              status: "LEFT",
              leaveTime,
              duration,
              joinHistory: JSON.parse(JSON.stringify(history)),
            },
          });

          const participant = await prisma.participant.findUnique({
            where: { sessionId_email: { sessionId: session.id, email } },
          });

          io.to(`meeting-${meetingId}`).emit("participant-left", {
            meetingId,
            sessionId: session.id,
            participant,
          });
          console.log(`[LEFT] ${p.user_name} (${email}) ← session ${session.id}`);
        }
        break;
      }

      default:
        console.log(`[WEBHOOK] Unhandled event: ${event}`);
    }

    res.status(200).send();
  };
}
