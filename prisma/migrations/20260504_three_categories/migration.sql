UPDATE "Testimonial" SET category = 'personality' WHERE category IN ('appearance', 'habit');

CREATE TYPE "TestimonialCategory_new" AS ENUM ('personality', 'performance', 'relationship');
ALTER TABLE "Testimonial" ALTER COLUMN "category" DROP DEFAULT;
ALTER TABLE "Testimonial" ALTER COLUMN "category" TYPE "TestimonialCategory_new" USING (category::text::"TestimonialCategory_new");
ALTER TYPE "TestimonialCategory" RENAME TO "TestimonialCategory_old";
ALTER TYPE "TestimonialCategory_new" RENAME TO "TestimonialCategory";
DROP TYPE "TestimonialCategory_old";
ALTER TABLE "Testimonial" ALTER COLUMN "category" SET DEFAULT 'personality';
