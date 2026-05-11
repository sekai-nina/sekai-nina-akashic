-- CreateEnum
CREATE TYPE "ClearanceLevel" AS ENUM ('public', 'internal', 'confidential', 'restricted');

-- AlterTable: User
ALTER TABLE "User" ADD COLUMN "clearance" "ClearanceLevel" NOT NULL DEFAULT 'internal';
ALTER TABLE "User" ADD COLUMN "avatarUrl" TEXT;
ALTER TABLE "User" ADD COLUMN "discordId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_discordId_key" ON "User"("discordId");

-- AlterTable: Asset (3-step: nullable -> backfill -> NOT NULL)
ALTER TABLE "Asset" ADD COLUMN "classification" "ClearanceLevel";
UPDATE "Asset" SET "classification" = 'internal' WHERE "classification" IS NULL;
ALTER TABLE "Asset" ALTER COLUMN "classification" SET NOT NULL;
ALTER TABLE "Asset" ALTER COLUMN "classification" SET DEFAULT 'internal';

-- CreateIndex
CREATE INDEX "Asset_classification_idx" ON "Asset"("classification");

-- CreateTable: Invitation
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "email" TEXT,
    "role" "Role" NOT NULL DEFAULT 'member',
    "clearance" "ClearanceLevel" NOT NULL DEFAULT 'internal',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_token_key" ON "Invitation"("token");
CREATE UNIQUE INDEX "Invitation_usedById_key" ON "Invitation"("usedById");
CREATE INDEX "Invitation_token_idx" ON "Invitation"("token");
CREATE INDEX "Invitation_createdById_idx" ON "Invitation"("createdById");

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_usedById_fkey" FOREIGN KEY ("usedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
