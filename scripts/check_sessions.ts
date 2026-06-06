import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
prisma.meetingSession.findMany({ where: { meetingId: '88117186984' } })
  .then(s => console.log(s))
  .finally(() => prisma.$disconnect());
