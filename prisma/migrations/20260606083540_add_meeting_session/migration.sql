/*
  Warnings:

  - You are about to drop the column `duration` on the `Meeting` table. All the data in the column will be lost.
  - You are about to drop the column `endTime` on the `Meeting` table. All the data in the column will be lost.
  - You are about to drop the column `occurrenceId` on the `Meeting` table. All the data in the column will be lost.
  - You are about to drop the column `startTime` on the `Meeting` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `Meeting` table. All the data in the column will be lost.
  - You are about to drop the column `uuid` on the `Meeting` table. All the data in the column will be lost.
  - You are about to drop the column `meetingId` on the `Participant` table. All the data in the column will be lost.
  - You are about to drop the column `sessionUuid` on the `Participant` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[sessionId,email]` on the table `Participant` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `sessionId` to the `Participant` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('SCHEDULED', 'LIVE', 'ENDED');

-- DropForeignKey
ALTER TABLE "Participant" DROP CONSTRAINT "Participant_meetingId_fkey";

-- DropIndex
DROP INDEX "Meeting_uuid_key";

-- DropIndex
DROP INDEX "Participant_meetingId_sessionUuid_email_key";

-- AlterTable
ALTER TABLE "Meeting" DROP COLUMN "duration",
DROP COLUMN "endTime",
DROP COLUMN "occurrenceId",
DROP COLUMN "startTime",
DROP COLUMN "status",
DROP COLUMN "uuid",
ADD COLUMN     "type" INTEGER NOT NULL DEFAULT 2;

-- AlterTable
ALTER TABLE "Participant" DROP COLUMN "meetingId",
DROP COLUMN "sessionUuid",
ADD COLUMN     "sessionId" TEXT NOT NULL;

-- DropEnum
DROP TYPE "MeetingStatus";

-- CreateTable
CREATE TABLE "MeetingSession" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "occurrenceId" TEXT,
    "uuid" TEXT,
    "scheduledStart" TIMESTAMP(3) NOT NULL,
    "duration" INTEGER NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "endTime" TIMESTAMP(3),

    CONSTRAINT "MeetingSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MeetingSession_uuid_idx" ON "MeetingSession"("uuid");

-- CreateIndex
CREATE INDEX "MeetingSession_meetingId_status_idx" ON "MeetingSession"("meetingId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MeetingSession_meetingId_occurrenceId_key" ON "MeetingSession"("meetingId", "occurrenceId");

-- CreateIndex
CREATE UNIQUE INDEX "Participant_sessionId_email_key" ON "Participant"("sessionId", "email");

-- AddForeignKey
ALTER TABLE "MeetingSession" ADD CONSTRAINT "MeetingSession_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "Meeting"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "MeetingSession"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
