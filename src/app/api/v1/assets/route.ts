import { NextResponse, after } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { createAsset, listAssets } from "@/lib/domain/assets";
import { extractTestimonials } from "@/lib/domain/testimonials";
import type { CreateAssetData, ListAssetsFilters } from "@/lib/domain/assets";

// 坂井新奈のentityId（口コミ抽出対象）
const NINA_ENTITY_ID = "cmmtp8vrg0004mo381neyztvn";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const includeParam = url.searchParams.get("include");
  const filters: ListAssetsFilters = {
    status: (url.searchParams.get("status") as ListAssetsFilters["status"]) || undefined,
    kind: (url.searchParams.get("kind") as ListAssetsFilters["kind"]) || undefined,
    trustLevel: (url.searchParams.get("trustLevel") as ListAssetsFilters["trustLevel"]) || undefined,
    sourceType: (url.searchParams.get("sourceType") as ListAssetsFilters["sourceType"]) || undefined,
    page: Number(url.searchParams.get("page")) || 1,
    perPage: Math.min(Number(url.searchParams.get("perPage")) || 20, 100),
    include: includeParam ? includeParam.split(",") : undefined,
  };

  const result = await listAssets(filters);
  return NextResponse.json(result);
}

export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const body = await request.json() as CreateAssetData;

  if (!body.kind) {
    return NextResponse.json({ error: "kind is required" }, { status: 400 });
  }

  const asset = await createAsset(body, auth.id);

  // Trigger testimonial extraction in background for web (blog) assets
  if (body.sourceType === "web" && process.env.OPENAI_API_KEY) {
    after(async () => {
      try {
        await extractTestimonials({
          entityId: NINA_ENTITY_ID,
          limit: 20,
        });
      } catch (err) {
        console.error("[testimonials] background extraction failed:", err);
      }
    });
  }

  return NextResponse.json(asset, { status: 201 });
}
