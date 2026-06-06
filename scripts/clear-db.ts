/**
 * clear-db.ts — Wipes all data from Participant, MeetingSession, Registrant, Meeting.
 * Run with: npm run clear-db
 */
import { PrismaClient } from "@prisma/client";
import * as dotenv from "dotenv";
dotenv.config();

const prisma = new PrismaClient();

async function main() {
  console.log("🗑️  Clearing database...\n");

  const participants = await prisma.participant.deleteMany();
  console.log(`  ✅ Deleted ${participants.count} Participant rows`);

  const sessions = await prisma.meetingSession.deleteMany();
  console.log(`  ✅ Deleted ${sessions.count} MeetingSession rows`);

  const registrants = await prisma.registrant.deleteMany();
  console.log(`  ✅ Deleted ${registrants.count} Registrant rows`);

  const meetings = await prisma.meeting.deleteMany();
  console.log(`  ✅ Deleted ${meetings.count} Meeting rows`);

  console.log("\n✨ Database cleared. Fresh start ready!");
}

main()
  .catch((e) => {
    console.error("❌ Error:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
