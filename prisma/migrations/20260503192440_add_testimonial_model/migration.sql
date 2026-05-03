-- CreateEnum
CREATE TYPE "TestimonialStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "TestimonialCategory" AS ENUM ('personality', 'dance', 'appearance', 'habit', 'preference', 'skill', 'relationship', 'other');

-- CreateTable
CREATE TABLE "Testimonial" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "trait" TEXT NOT NULL DEFAULT '',
    "category" "TestimonialCategory" NOT NULL DEFAULT 'other',
    "speakerName" TEXT NOT NULL,
    "speakerEntityId" TEXT,
    "sourceUrl" TEXT,
    "sourceDate" TIMESTAMP(3),
    "status" "TestimonialStatus" NOT NULL DEFAULT 'pending',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "Testimonial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Testimonial_entityId_status_idx" ON "Testimonial"("entityId", "status");

-- CreateIndex
CREATE INDEX "Testimonial_category_idx" ON "Testimonial"("category");

-- CreateIndex
CREATE INDEX "Testimonial_status_idx" ON "Testimonial"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Testimonial_assetId_entityId_quote_key" ON "Testimonial"("assetId", "entityId", "quote");

-- AddForeignKey
ALTER TABLE "Testimonial" ADD CONSTRAINT "Testimonial_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Testimonial" ADD CONSTRAINT "Testimonial_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
