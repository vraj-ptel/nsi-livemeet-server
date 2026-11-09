-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN "lastWaitingAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "MeetingSession_scheduledStart_idx" ON "MeetingSession"("scheduledStart");

-- CreateIndex
CREATE INDEX "Registrant_email_idx" ON "Registrant"("email");

-- CreateIndex
CREATE INDEX "Participant_email_idx" ON "Participant"("email");
