-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN     "hostId" TEXT;

-- AlterTable
ALTER TABLE "Participant" ADD COLUMN     "isHost" BOOLEAN NOT NULL DEFAULT false;
