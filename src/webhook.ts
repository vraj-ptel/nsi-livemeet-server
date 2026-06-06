import { Request, Response } from "express";
import { Server as SocketIOServer } from "socket.io";
import { prisma } from "./db";

interface JoinSession {
  joinTime: string;
  leaveTime: string | null;
}

export function createWebhookHandler(io: SocketIOServer) {
  return async function handleWebhook(req: Request, res: Response) {
    const { event, payload } = req.body as {
      event: string;
      payload: Record<string, any>;
    };

    console.log(`[WEBHOOK] ${event}`);

    const obj = payload.object ?? {};
    const meetingId = obj.id?.toString() ?? "";
    const meetingUuid = obj.uuid ?? "";

    // ── Ensure meeting row exists in DB ──────────────────────────────────────
    // We upsert so that any event can create the meeting record if missing.
    if (meetingId) {
      await prisma.meeting.upsert({
        where: { id: meetingId },
        create: {
          id: meetingId,
          uuid: meetingUuid,
          topic: obj.topic ?? "Unknown",
          startTime: obj.start_time ? new Date(obj.start_time) : new Date(),
          duration: obj.duration ?? 60,
          timezone: obj.timezone ?? null,
          status: "UNKNOWN",
        },
        update: {
          // Only update uuid if we have one (meeting.started gives real occurrence uuid)
          ...(meetingUuid ? { uuid: meetingUuid } : {}),
          topic: obj.topic ?? undefined,
        },
      });
    }

    switch (event) {
      // ── Meeting lifecycle ──────────────────────────────────────────────────
      case "meeting.started": {
        await prisma.meeting.update({
          where: { id: meetingId },
          data: {
            status: "LIVE",
            uuid: meetingUuid, // lock in the actual occurrence UUID
            startTime: obj.start_time ? new Date(obj.start_time) : undefined,
          },
        });
        io.to(`meeting-${meetingId}`).emit("meeting-started", {
          meetingId,
          startTime: obj.start_time,
        });
        console.log(`[LIVE] Meeting ${meetingId} (uuid: ${meetingUuid}) is now LIVE`);
        break;
      }

      case "meeting.ended": {
        await prisma.meeting.update({
          where: { id: meetingId },
          data: {
            status: "ENDED",
            endTime: obj.end_time ? new Date(obj.end_time) : new Date(),
          },
        });
        io.to(`meeting-${meetingId}`).emit("meeting-ended", {
          meetingId,
          endTime: obj.end_time,
        });
        console.log(`[ENDED] Meeting ${meetingId}`);
        break;
      }

      // ── Registration ───────────────────────────────────────────────────────
      case "meeting.registration_created": {
        const r = obj.registrant ?? {};
        const sixABonus: string = r.custom_questions?.[0]?.value ?? "";

        await prisma.registrant.upsert({
          where: {
            meetingId_email: { meetingId, email: r.email },
          },
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
          `[REG] ${r.first_name} ${r.last_name} (${r.email}) → sixABonus: "${sixABonus}"`
        );
        break;
      }

      // ── Participant joined ─────────────────────────────────────────────────
      case "meeting.participant_joined": {
        const p = obj.participant ?? {};
        const email: string = p.email || p.user_id || p.user_name;
        const joinTime = new Date(p.join_time);

        // Get existing participant to update joinHistory
        const existing = await prisma.participant.findUnique({
          where: { meetingId_email: { meetingId, email } },
        });

        const history: JoinSession[] = existing
          ? (existing.joinHistory as JoinSession[])
          : [];
        history.push({ joinTime: joinTime.toISOString(), leaveTime: null });

        await prisma.participant.upsert({
          where: { meetingId_email: { meetingId, email } },
          create: {
            meetingId,
            email,
            name: p.user_name ?? "",
            userId: p.user_id ?? null,
            status: "IN_MEETING",
            joinTime,
            joinHistory: history,
          },
          update: {
            status: "IN_MEETING",
            joinTime,
            leaveTime: null,
            joinHistory: history,
          },
        });

        const participant = await prisma.participant.findUnique({
          where: { meetingId_email: { meetingId, email } },
        });

        io.to(`meeting-${meetingId}`).emit("participant-joined", {
          meetingId,
          participant,
        });
        console.log(`[JOIN] ${p.user_name} (${email}) joined ${meetingId}`);
        break;
      }

      // ── Participant left ───────────────────────────────────────────────────
      case "meeting.participant_left": {
        const p = obj.participant ?? {};
        const email: string = p.email || p.user_id || p.user_name;
        const leaveTime = new Date(p.leave_time);

        const existing = await prisma.participant.findUnique({
          where: { meetingId_email: { meetingId, email } },
        });

        if (existing) {
          const history = existing.joinHistory as JoinSession[];
          const lastSession = history[history.length - 1];
          if (lastSession) lastSession.leaveTime = leaveTime.toISOString();

          // Calculate total duration across all sessions
          const duration = history.reduce((total, s) => {
            const end = s.leaveTime ? new Date(s.leaveTime) : new Date();
            return total + (end.getTime() - new Date(s.joinTime).getTime());
          }, 0);

          await prisma.participant.update({
            where: { meetingId_email: { meetingId, email } },
            data: { status: "LEFT", leaveTime, duration, joinHistory: history },
          });

          const participant = await prisma.participant.findUnique({
            where: { meetingId_email: { meetingId, email } },
          });

          io.to(`meeting-${meetingId}`).emit("participant-left", {
            meetingId,
            participant,
          });
          console.log(`[LEFT] ${p.user_name} (${email}) left ${meetingId}`);
        }
        break;
      }

      default:
        console.log(`[WEBHOOK] Unhandled event: ${event}`);
    }

    res.status(200).send();
  };
}
