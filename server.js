const express = require("express");
const crypto = require("crypto");
const { Server } = require("socket.io");
const http = require("http");
const axios = require("axios");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }),
);

// ==================== CONFIG ====================

const ZOOM_WEBHOOK_SECRET = "XAH3rGMWSreWGTju14QSVw";
const ZOOM_ACCOUNT_ID = "54FoHe86RBytPFxtzr9jfA";
const ZOOM_CLIENT_ID = "l4Lqt4eKQziEVXp2FDU89A";
const ZOOM_CLIENT_SECRET = "ic9YG5iO3vb9WHdn78feNVAkEknQI8F6";
// In-memory store (REPLACE WITH REDIS/DB IN PRODUCTION)
const meetings = new Map(); // meetingId -> { participants: Map, status, startTime }
const registrantBonusStore = new Map(); // email -> "6a bonus" value

// ==================== PAYLOAD LOGGER ====================
const PAYLOAD_LOG_FILE = path.join(__dirname, "webhook_payloads.json");

function savePayload(event, payload) {
  try {
    // Load existing log or start fresh
    let log = [];
    if (fs.existsSync(PAYLOAD_LOG_FILE)) {
      const raw = fs.readFileSync(PAYLOAD_LOG_FILE, "utf-8");
      log = JSON.parse(raw);
    }

    // Build entry — JSON.parse(JSON.stringify()) fully expands nested arrays/objects
    const entry = {
      receivedAt: new Date().toISOString(),
      event,
      payload: JSON.parse(JSON.stringify(payload)), // deep-clone so Maps/circular refs are safe
    };

    log.push(entry);

    fs.writeFileSync(PAYLOAD_LOG_FILE, JSON.stringify(log, null, 2), "utf-8");
    console.log(
      `[PAYLOAD SAVED] ${event} → webhook_payloads.json (${log.length} total entries)`,
    );
  } catch (err) {
    console.error("[PAYLOAD SAVE ERROR]", err.message);
  }
}

// ==================== ZOOM WEBHOOK VERIFICATION ====================
function verifyZoomWebhook(req) {
  const message = `v0:${req.headers["x-zm-request-timestamp"]}:${req.rawBody}`;
  const hash = crypto
    .createHmac("sha256", ZOOM_WEBHOOK_SECRET)
    .update(message)
    .digest("hex");
  const signature = `v0=${hash}`;
  return signature === req.headers["x-zm-signature"];
}
// Add this function to your backend
async function getRegistrantDetails(meetingId, email, token) {
  try {
    // 1. Get all registrants for this meeting
    const res = await axios.get(
      `https://api.zoom.us/v2/meetings/${meetingId}/registrants`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { status: "approved", page_size: 300 },
      },
    );

    // 2. Find the registrant by email
    const registrant = res.data.registrants.find((r) => r.email === email);

    if (!registrant) return null;

    // 3. Fetch full details including custom questions
    const detailRes = await axios.get(
      `https://api.zoom.us/v2/meetings/${meetingId}/registrants/${registrant.id}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );

    return detailRes.data;
  } catch (err) {
    console.error(
      "Failed to fetch registrant:",
      err.response?.data || err.message,
    );
    return null;
  }
}
app.get("/", (req, res) => {
  res.send("Hello World");
});

// ==================== WEBHOOK ENDPOINT ====================
app.post("/api/zoom/webhook", async (req, res) => {
  // Zoom sends a challenge when you first set the webhook URL
  if (req.body.event === "endpoint.url_validation") {
    const hash = crypto
      .createHmac("sha256", ZOOM_WEBHOOK_SECRET)
      .update(req.body.payload.plainToken)
      .digest("hex");
    return res.json({
      plainToken: req.body.payload.plainToken,
      encryptedToken: hash,
    });
  }

  // Verify signature for all other requests
  if (!verifyZoomWebhook(req)) {
    console.log("Invalid webhook signature");
    return res.status(401).send("Unauthorized");
  }

  const { event, payload } = req.body;
  console.log("eventtttttttttttt", event, payload);
  const meetingId = payload.object?.id?.toString();
  const meetingUuid = payload.object?.uuid;

  console.log(`[WEBHOOK] ${event} for meeting ${meetingId}`);

  // ── Save full payload (including custom_questions) to JSON file ──
  savePayload(event, payload);

  // Initialize meeting if not exists
  if (!meetings.has(meetingId)) {
    meetings.set(meetingId, {
      id: meetingId,
      uuid: meetingUuid,
      status: "UNKNOWN",
      startTime: null,
      endTime: null,
      participants: new Map(), // participantKey -> participantData
      registeredUsers: [], // You'll populate this separately
    });
  }

  const meeting = meetings.get(meetingId);

  // Handle events
  switch (event) {
    case "meeting.started":
      meeting.status = "LIVE";
      meeting.startTime = payload.object.start_time;
      io.to(`meeting-${meetingId}`).emit("meeting-started", {
        meetingId,
        startTime: meeting.startTime,
      });
      break;

    case "meeting.registration_created": {
      const registrant = payload.object.registrant;
      const { first_name, last_name, email, custom_questions, id } = registrant;

      // ── Store 6a bonus value by email (simple global lookup) ──
      const sixAValue = custom_questions?.[0]?.value || "";
      registrantBonusStore.set(email, sixAValue);
      console.log(`[BONUS STORE] ${email} → "${sixAValue}"`);

      const userRecord = {
        userId: id,
        name: `${first_name} ${last_name}`.trim(),
        email: email,
        firstName: first_name,
        lastName: last_name,
      };

      meeting.registeredUsers.push(userRecord);

      // Emit event to frontend
      io.to(`meeting-${meetingId}`).emit("user-registered", {
        meetingId,
        userRecord,
      });

      console.log(
        `[REGISTRATION] User registered: ${first_name} ${last_name} (${email})`,
      );
      break;
    }

    case "meeting.ended":
      meeting.status = "ENDED";
      meeting.endTime = payload.object.end_time;
      io.to(`meeting-${meetingId}`).emit("meeting-ended", {
        meetingId,
        endTime: meeting.endTime,
      });
      break;

    case "meeting.participant_joined": {
      const p = payload.object.participant;
      const key = p.email || p.user_id || p.user_name; // Unique key
      // Fetch custom registration data
      const token = await getZoomToken();
      const registrantDetails = await getRegistrantDetails(
        meetingId,
        p.email,
        token,
      );
      // Extract custom answers
      const customAnswers = {};
      if (registrantDetails?.custom_questions) {
        registrantDetails.custom_questions.forEach((q) => {
          customAnswers[q.title] = q.value; // e.g., { "6A2-3 & Above": "Yes" }
        });
      }

      const participantData = {
        id: key,
        name: p.user_name,
        email: p.email || "N/A (Guest)",
        userId: p.user_id,
        joinTime: new Date(p.join_time),
        status: "IN_MEETING",
        // Add custom fields here
        customAnswers, // <-- your "6A2-3 & Above" data
        registrantId: registrantDetails?.id || p.registrant_id || null,
        joinHistory: [{ joinTime: new Date(p.join_time), leaveTime: null }],
      };

      // If rejoining after leaving
      if (meeting.participants.has(key)) {
        const existing = meeting.participants.get(key);
        existing.status = "IN_MEETING";
        existing.joinTime = new Date(p.join_time); // Latest join
        existing.joinHistory.push({
          joinTime: new Date(p.join_time),
          leaveTime: null,
        });
        existing.leaveTime = null;
      } else {
        meeting.participants.set(key, participantData);
      }

      io.to(`meeting-${meetingId}`).emit("participant-joined", {
        meetingId,
        participant: meeting.participants.get(key),
      });
      break;
    }

    case "meeting.participant_left": {
      const p = payload.object.participant;
      const key = p.email || p.user_id || p.user_name;

      if (meeting.participants.has(key)) {
        const participant = meeting.participants.get(key);
        const leaveTime = new Date(p.leave_time);
        const lastSession =
          participant.joinHistory[participant.joinHistory.length - 1];

        participant.status = "LEFT";
        participant.leaveTime = leaveTime;
        lastSession.leaveTime = leaveTime;

        // Calculate total duration across all sessions
        participant.duration = participant.joinHistory.reduce(
          (total, session) => {
            const end = session.leaveTime || new Date();
            return total + (end - session.joinTime);
          },
          0,
        );

        io.to(`meeting-${meetingId}`).emit("participant-left", {
          meetingId,
          participant,
        });
      }
      break;
    }
  }

  res.status(200).send();
});

// ==================== REST API FOR FRONTEND ====================

// Get meeting attendance report
app.get("/api/meetings/:meetingId/attendance", (req, res) => {
  const meeting = meetings.get(req.params.meetingId);
  if (!meeting) return res.status(404).json({ error: "Meeting not found" });

  const participants = Array.from(meeting.participants.values()).map((p) => ({
    ...p,
    customAnswers: p.customAnswers || {}, // <-- ensure this is included
  }));
  // Merge with registered users to show who hasn't joined
  const attendance = meeting.registeredUsers.map((reg) => {
    const joined = participants.find((p) => p.email === reg.email);
    return {
      ...reg,
      status: joined ? joined.status : "NOT_JOINED",
      joinTime: joined?.joinTime || null,
      leaveTime: joined?.leaveTime || null,
      duration: joined?.duration || 0,
      joinHistory: joined?.joinHistory || [],
      // ── Direct lookup from global registrant bonus store ──
      sixABonus: registrantBonusStore.get(reg.email) || "-",
    };
  });

  // Also include guests who joined but weren't registered
  const guests = participants.filter(
    (p) => !meeting.registeredUsers.some((r) => r.email === p.email),
  );

  res.json({
    meetingId: meeting.id,
    status: meeting.status,
    startTime: meeting.startTime,
    endTime: meeting.endTime,
    totalRegistered: meeting.registeredUsers.length,
    totalJoined: participants.length,
    currentlyInMeeting: participants.filter((p) => p.status === "IN_MEETING")
      .length,
    attendance,
    guests,
  });
});

// Set registered users for a meeting (called from your HR system)
app.post("/api/meetings/:meetingId/register", (req, res) => {
  const { users } = req.body; // [{ email, name, employeeId }]
  const meeting = meetings.get(req.params.meetingId);

  if (!meetings.has(req.params.meetingId)) {
    meetings.set(req.params.meetingId, {
      id: req.params.meetingId,
      participants: new Map(),
      registeredUsers: users,
      status: "SCHEDULED",
    });
  } else {
    meetings.get(req.params.meetingId).registeredUsers = users;
  }

  res.json({ success: true, registered: users.length });
});

// Get Zoom OAuth token (Server-to-Server)
async function getZoomToken() {
  const credentials = Buffer.from(
    `${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`,
  ).toString("base64");
  const res = await axios.post("https://zoom.us/oauth/token", null, {
    params: {
      grant_type: "account_credentials",
      account_id: ZOOM_ACCOUNT_ID,
    },
    headers: {
      Authorization: `Basic ${credentials}`,
    },
  });
  return res.data.access_token;
}

// Fetch upcoming meetings
app.get("/api/meetings/upcoming", async (req, res) => {
  try {
    const token = await getZoomToken();
    const today = new Date().toISOString().split("T")[0];
    const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split("T")[0];
    const response = await axios.get(
      "https://api.zoom.us/v2/users/me/meetings",
      {
        headers: { Authorization: `Bearer ${token}` },
        params: { type: "upcoming", page_size: 100, from: today, to: nextWeek },
      },
    );

    const upcomingMeetings = response.data.meetings.map((m) => ({
      id: m.id.toString(),
      topic: m.topic,
      startTime: m.start_time,
      duration: m.duration,
      joinUrl: m.join_url,
      status: meetings.has(m.id.toString()) ? "LIVE" : "SCHEDULED",
    }));

    res.json(upcomingMeetings);
  } catch (err) {
    console.error("Zoom API error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch meetings" });
  }
});

// ==================== SOCKET.IO ====================
io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  socket.on("subscribe-meeting", (meetingId) => {
    socket.join(`meeting-${meetingId}`);
    console.log(`Socket ${socket.id} joined room meeting-${meetingId}`);

    // Send current state immediately
    const meeting = meetings.get(meetingId);
    if (meeting) {
      socket.emit("meeting-state", {
        status: meeting.status,
        participants: Array.from(meeting.participants.values()),
      });
    }
  });
});

// ==================== START ====================
const PORT = process.env.PORT || 8000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(
    `Webhook URL: https://3651-2401-4900-8898-7ed7-c912-a592-585-c627.ngrok-free.app/api/zoom/webhook`,
  );
});
