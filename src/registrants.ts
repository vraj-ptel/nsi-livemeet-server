import { prisma } from "./db";

export interface RegistrantInput {
  zoomId: string;
  email: string;
  name: string;
  firstName: string;
  lastName: string;
  sixABonus: string;
  joinUrl: string | null;
  status: string;
}

export function parseSixABonus(
  customQuestions: { value?: string }[] | undefined
): string {
  return customQuestions?.[0]?.value ?? "";
}

export function normalizeZoomRegistrant(r: {
  id?: string;
  email: string;
  first_name?: string;
  last_name?: string;
  custom_questions?: { value?: string }[];
  join_url?: string;
  status?: string;
}): RegistrantInput {
  const firstName = r.first_name ?? "";
  const lastName = r.last_name ?? "";
  return {
    zoomId: r.id ?? "",
    email: r.email,
    firstName,
    lastName,
    name: `${firstName} ${lastName}`.trim() || r.email,
    sixABonus: parseSixABonus(r.custom_questions),
    joinUrl: r.join_url ?? null,
    status: r.status ?? "approved",
  };
}

export async function upsertRegistrant(
  meetingId: string,
  data: RegistrantInput
): Promise<"created" | "updated"> {
  const existing = await prisma.registrant.findUnique({
    where: { meetingId_email: { meetingId, email: data.email } },
  });

  await prisma.registrant.upsert({
    where: { meetingId_email: { meetingId, email: data.email } },
    create: {
      zoomId: data.zoomId,
      meetingId,
      email: data.email,
      name: data.name,
      firstName: data.firstName,
      lastName: data.lastName,
      sixABonus: data.sixABonus,
      joinUrl: data.joinUrl,
      status: data.status,
    },
    update: {
      ...(data.zoomId ? { zoomId: data.zoomId } : {}),
      name: data.name,
      firstName: data.firstName,
      lastName: data.lastName,
      sixABonus: data.sixABonus,
      ...(data.joinUrl != null ? { joinUrl: data.joinUrl } : {}),
      status: data.status,
    },
  });

  return existing ? "updated" : "created";
}
