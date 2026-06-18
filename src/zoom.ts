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
  uuid: string;      // occurrence_id used as uuid key — unique per occurrence
  occurrenceId?: string;
  topic: string;
  startTime: string;
  duration: number;
  joinUrl: string;
  type: number;
}

export async function getUpcomingMeetings(): Promise<ZoomOccurrence[]> {
  const token = await getZoomToken();

  // Get the flat list of scheduled meetings
  const response = await axios.get("https://api.zoom.us/v2/users/me/meetings", {
    headers: { Authorization: `Bearer ${token}` },
    params: { type: "scheduled", page_size: 300 },
  });

  const results: ZoomOccurrence[] = [];

  for (const m of response.data.meetings ?? []) {
    if (m.type === 8) {
      // ── Recurring meeting ──────────────────────────────────────────────────
      // The List Meetings API does NOT include occurrences in the response.
      // We must call GET /meetings/{id} separately to get all occurrences.
      try {
        const detail = await axios.get(
          `https://api.zoom.us/v2/meetings/${m.id}`,
          {
            headers: { Authorization: `Bearer ${token}` },
            params: { show_previous_occurrences: false },
          }
        );

        const occurrences: any[] = detail.data.occurrences ?? [];
        console.log(
          `[ZOOM] Recurring meeting ${m.id} "${m.topic}" — ${occurrences.length} occurrence(s)`
        );

        if (occurrences.length === 0) {
          // No upcoming occurrences — still show with parent-level time
          results.push({
            id: m.id.toString(),
            uuid: m.uuid ?? m.id.toString(),
            topic: detail.data.topic ?? m.topic,
            startTime: m.start_time,
            duration: m.duration,
            joinUrl: detail.data.join_url ?? m.join_url,
            type: m.type,
          });
        } else {
          for (const occ of occurrences) {
            if (occ.status === "deleted") continue; // skip deleted occurrences
            results.push({
              id: m.id.toString(),
              uuid: occ.occurrence_id,      // unique per occurrence — LIVE detection key
              occurrenceId: occ.occurrence_id,
              topic: detail.data.topic ?? m.topic,
              startTime: occ.start_time,
              duration: occ.duration ?? m.duration,
              joinUrl: detail.data.join_url ?? m.join_url,
              type: m.type,
            });
          }
        }
      } catch (err: any) {
        console.error(
          `[ZOOM] Failed to fetch occurrences for meeting ${m.id}:`,
          err.response?.data ?? err.message
        );
        // Fallback: show as single entry with list-level data
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
    } else {
      // ── One-time meeting ───────────────────────────────────────────────────
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

export interface ZoomMeetingDetails {
  id: number | string;
  topic: string;
  timezone?: string;
  type: number;
  join_url?: string;
  host_id?: string;
}

export async function getMeetingDetails(
  meetingId: string
): Promise<ZoomMeetingDetails> {
  const token = await getZoomToken();
  const response = await axios.get(
    `https://api.zoom.us/v2/meetings/${meetingId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return response.data;
}

export async function listMeetingRegistrants(
  meetingId: string,
  occurrenceId?: string
): Promise<
  {
    id?: string;
    email: string;
    first_name?: string;
    last_name?: string;
    custom_questions?: { value?: string }[];
    join_url?: string;
    status?: string;
  }[]
> {
  const token = await getZoomToken();
  const byEmail = new Map<
    string,
    {
      id?: string;
      email: string;
      first_name?: string;
      last_name?: string;
      custom_questions?: { value?: string }[];
      join_url?: string;
      status?: string;
    }
  >();

  for (const status of ["approved", "pending"] as const) {
    let nextPageToken: string | undefined;

    do {
      const response = await axios.get(
        `https://api.zoom.us/v2/meetings/${meetingId}/registrants`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            page_size: 300,
            status,
            ...(nextPageToken ? { next_page_token: nextPageToken } : {}),
            ...(occurrenceId ? { occurrence_id: occurrenceId } : {}),
          },
        }
      );

      for (const registrant of response.data.registrants ?? []) {
        if (registrant.email) {
          byEmail.set(registrant.email, registrant);
        }
      }

      nextPageToken = response.data.next_page_token;
    } while (nextPageToken);
  }

  return Array.from(byEmail.values());
}
