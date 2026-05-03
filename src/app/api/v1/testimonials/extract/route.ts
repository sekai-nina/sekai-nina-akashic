import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { prisma } from "@/lib/db";
import { extractTestimonials } from "@/lib/domain/testimonials";

export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const entityId = url.searchParams.get("entityId");

  if (!entityId) {
    return NextResponse.json(
      { error: "entityId query parameter is required" },
      { status: 400 }
    );
  }

  // Verify entity exists
  const entity = await prisma.entity.findUnique({ where: { id: entityId } });
  if (!entity) {
    return NextResponse.json({ error: "Entity not found" }, { status: 404 });
  }

  // Auto-detect sinceDate: use the sourceDate of the most recently processed testimonial
  const latestTestimonial = await prisma.testimonial.findFirst({
    where: { entityId },
    orderBy: { sourceDate: "desc" },
    select: { sourceDate: true },
  });

  // Process mentions from after the latest known testimonial (with 1 day overlap for safety)
  let sinceDate: Date | undefined;
  if (latestTestimonial?.sourceDate) {
    sinceDate = new Date(latestTestimonial.sourceDate.getTime() - 24 * 60 * 60 * 1000);
  }

  const limit = Number(url.searchParams.get("limit")) || 200;

  const result = await extractTestimonials({ entityId, limit, sinceDate });

  return NextResponse.json({
    success: true,
    entityName: entity.canonicalName,
    sinceDate: sinceDate?.toISOString() || null,
    ...result,
  });
}
