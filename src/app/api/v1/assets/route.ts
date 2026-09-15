import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { listAssets } from "@/lib/domain/assets";
import {
  intakeAsset,
  AssetIntakeSchema,
  formatIntakeError,
} from "@/lib/domain/asset-intake";
import { assertClearance } from "@/lib/classification";
import type { ListAssetsFilters } from "@/lib/domain/assets";

export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const includeParam = url.searchParams.get("include");
  const updatedSinceParam = url.searchParams.get("updatedSince");
  const filters: ListAssetsFilters = {
    status: (url.searchParams.get("status") as ListAssetsFilters["status"]) || undefined,
    kind: (url.searchParams.get("kind") as ListAssetsFilters["kind"]) || undefined,
    trustLevel: (url.searchParams.get("trustLevel") as ListAssetsFilters["trustLevel"]) || undefined,
    sourceType: (url.searchParams.get("sourceType") as ListAssetsFilters["sourceType"]) || undefined,
    updatedSince: updatedSinceParam ? new Date(updatedSinceParam) : undefined,
    entityId: url.searchParams.get("entityId") || undefined,
    page: Number(url.searchParams.get("page")) || 1,
    perPage: Math.min(Number(url.searchParams.get("perPage")) || 20, 100),
    include: includeParam ? includeParam.split(",") : undefined,
  };

  const result = await listAssets(filters, auth.clearance);
  return NextResponse.json(result);
}

export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    // JSON パース失敗は 500 ではなく 400 で返す
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const parsed = AssetIntakeSchema.safeParse(raw);
  if (!parsed.success) {
    // kind だけが欠けている場合はこれまでの専用メッセージを踏襲する。
    // 他にもエラーがあるなら握り潰さずに全部返す (1 往復で 1 個ずつ潰させない)
    const issues = parsed.error.issues;
    const isPlainObject =
      typeof raw === "object" && raw !== null && !Array.isArray(raw);
    const onlyKindMissing =
      isPlainObject &&
      (raw as Record<string, unknown>).kind === undefined &&
      issues.every((i) => i.path[0] === "kind");
    if (onlyKindMissing) {
      return NextResponse.json({ error: "kind is required" }, { status: 400 });
    }
    return NextResponse.json(
      { error: formatIntakeError(parsed.error) },
      { status: 400 }
    );
  }
  const body = parsed.data;

  // クリアランス超過は intakeAsset の中でも弾かれるが、ここで 403 に整形しておく
  // (`||` は intakeAsset 側の既定値の入れ方に合わせている。空文字は internal 扱い)
  try {
    assertClearance(auth.clearance, body.classification || "internal");
  } catch {
    return NextResponse.json(
      { error: "Cannot create asset with classification above your clearance" },
      { status: 403 },
    );
  }

  const asset = await intakeAsset(body, auth.id, auth.clearance);

  return NextResponse.json(asset, { status: 201 });
}
