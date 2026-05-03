-- Migrate data (already done via script, but idempotent)
UPDATE "Testimonial" SET category = 'performance' WHERE category = 'dance';
UPDATE "Testimonial" SET category = 'performance' WHERE category = 'skill';
UPDATE "Testimonial" SET category = 'habit' WHERE category = 'preference';
UPDATE "Testimonial" SET category = 'habit' WHERE category = 'other';

-- Recreate enum without old values
CREATE TYPE "TestimonialCategory_new" AS ENUM ('personality', 'appearance', 'performance', 'habit', 'relationship');
ALTER TABLE "Testimonial" ALTER COLUMN "category" DROP DEFAULT;
ALTER TABLE "Testimonial" ALTER COLUMN "category" TYPE "TestimonialCategory_new" USING (category::text::"TestimonialCategory_new");
ALTER TYPE "TestimonialCategory" RENAME TO "TestimonialCategory_old";
ALTER TYPE "TestimonialCategory_new" RENAME TO "TestimonialCategory";
DROP TYPE "TestimonialCategory_old";
ALTER TABLE "Testimonial" ALTER COLUMN "category" SET DEFAULT 'habit';
