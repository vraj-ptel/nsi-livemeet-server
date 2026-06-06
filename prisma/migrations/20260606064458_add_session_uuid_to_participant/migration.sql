/*
  Warnings:

  - A unique constraint covering the columns `[meetingId,sessionUuid,email]` on the table `Participant` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Participant_meetingId_email_key";

-- AlterTable
ALTER TABLE "Participant" ADD COLUMN     "sessionUuid" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE UNIQUE INDEX "Participant_meetingId_sessionUuid_email_key" ON "Participant"("meetingId", "sessionUuid", "email");
