import axios from "axios";

const ZOOM_ACCOUNT_ID = process.env.ZOOM_ACCOUNT_ID!;
const ZOOM_CLIENT_ID = process.env.ZOOM_CLIENT_ID!;
const ZOOM_CLIENT_SECRET = process.env.ZOOM_CLIENT_SECRET!;

// Cache token to avoid hitting OAuth endpoint on every request
let cachedToken: string | null = null;
let tokenExpiry = 0;

export async function getZoomToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const credentials = Buffer.from(
    `${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}`
  ).toString("base64");

  const res = await axios.post("https://zoom.us/oauth/token", null, {
    params: { grant_type: "account_credentials", account_id: ZOOM_ACCOUNT_ID },
    headers: { Authorization: `Basic ${credentials}` },
  });

  cachedToken = res.data.access_token as string;
  // Zoom tokens last 1 hour; cache for 55 minutes
  tokenExpiry = Date.now() + 55 * 60 * 1000;
  return cachedToken;
}

export interface ZoomOccurrence {
  id: string;        // parent meeting id
  uuid: string;      // occurrence uuid (unique per instance)
  occurrenceId?: string;
  topic: string;
  startTime: string;
  duration: number;
  joinUrl: string;
  type: number;
}

export async function getUpcomingMeetings(): Promise<ZoomOccurrence[]> {
  const token = await getZoomToken();

  const response = await axios.get("https://api.zoom.us/v2/users/me/meetings", {
    headers: { Authorization: `Bearer ${token}` },
    params: { type: "scheduled", page_size: 300 },
  });

  const results: ZoomOccurrence[] = [];

  for (const m of response.data.meetings ?? []) {
    if (m.type === 8 && m.occurrences) {
      // Recurring meeting — each occurrence is a separate entry
      for (const occ of m.occurrences) {
        results.push({
          id: m.id.toString(),
          uuid: occ.occurrence_id, // use occurrence_id as uuid key for recurring meetings
          occurrenceId: occ.occurrence_id,
          topic: m.topic,
          startTime: occ.start_time,
          duration: occ.duration ?? m.duration,
          joinUrl: m.join_url,
          type: m.type,
        });
      }
    } else {
      results.push({
        id: m.id.toString(),
        uuid: m.uuid ?? m.id.toString(),
        topic: m.topic,
        startTime: m.start_time,
        duration: m.duration,
        joinUrl: m.join_url,
        type: m.type,
      });
    }
  }

  return results;
}
