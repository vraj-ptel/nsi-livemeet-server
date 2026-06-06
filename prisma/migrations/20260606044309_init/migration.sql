-- CreateEnum
CREATE TYPE "MeetingStatus" AS ENUM ('SCHEDULED', 'LIVE', 'ENDED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ParticipantStatus" AS ENUM ('IN_MEETING', 'LEFT');

-- CreateTable
CREATE TABLE "Meeting" (
    "id" TEXT NOT NULL,
    "uuid" TEXT NOT NULL,
    "occurrenceId" TEXT,
    "topic" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3),
    "duration" INTEGER NOT NULL,
    "timezone" TEXT,
    "joinUrl" TEXT,
    "status" "MeetingStatus" NOT NULL DEFAULT 'SCHEDULED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Registrant" (
    "id" TEXT NOT NULL,
    "zoomId" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "sixABonus" TEXT NOT NULL DEFAULT '',
    "joinUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'approved',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Registrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Participant" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "userId" TEXT,
    "status" "ParticipantStatus" NOT NULL DEFAULT 'IN_MEETING',
    "joinTime" TIMESTAMP(3) NOT NULL,
    "leaveTime" TIMESTAMP(3),
    "duration" INTEGER NOT NULL DEFAULT 0,
    "joinHistory" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Participant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Meeting_uuid_key" ON "Meeting"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "Registrant_meetingId_email_key" ON "Registrant"("meetingId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Participant_meetingId_email_key" ON "Participant"("meetingId", "email");

-- AddForeignKey
ALTER TABLE "Registrant" ADD CONSTRAINT "Registrant_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
