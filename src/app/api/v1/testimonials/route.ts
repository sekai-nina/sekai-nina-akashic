import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { listTestimonials, reviewTestimonial } from "@/lib/domain/testimonials";
import type { TestimonialCategory, TestimonialStatus } from "@prisma/client";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const entityId = url.searchParams.get("entityId") || undefined;
  const status = (url.searchParams.get("status") as TestimonialStatus) || undefined;
  const category = (url.searchParams.get("category") as TestimonialCategory) || undefined;
  const page = Number(url.searchParams.get("page")) || 1;
  const perPage = Math.min(Number(url.searchParams.get("perPage")) || 50, 200);

  const result = await listTestimonials({ entityId, status, category, page, perPage });
  return NextResponse.json(result);
}

export async function PATCH(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const body = await request.json();
  if (!body.id || !body.status) {
    return NextResponse.json(
      { error: "id and status (approved|rejected) are required" },
      { status: 400 }
    );
  }

  if (!["approved", "rejected"].includes(body.status)) {
    return NextResponse.json(
      { error: "status must be 'approved' or 'rejected'" },
      { status: 400 }
    );
  }

  const testimonial = await reviewTestimonial(body.id, body.status);
  return NextResponse.json(testimonial);
}
