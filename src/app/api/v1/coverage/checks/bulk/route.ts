import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { bulkCheck } from "@/lib/domain/coverage";
import type { ClearanceLevel } from "@prisma/client";

/**
 * POST /coverage/checks/bulk
 * 範囲一括チェック。itemDate <= untilDate の全導出アイテムを対象 lens でチェック済みに。
 * ボディ: { dataSourceKey, lensKeys[], untilDate, classification? }
 */
export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const body = await request.json();
  if (!body.dataSourceKey || !Array.isArray(body.lensKeys) || !body.untilDate) {
    return NextResponse.json(
      { error: "dataSourceKey, lensKeys[] and untilDate are required" },
      { status: 400 }
    );
  }

  try {
    const result = await bulkCheck(
      {
        dataSourceKey: body.dataSourceKey,
        lensKeys: body.lensKeys,
        untilDate: body.untilDate,
        classification: body.classification as ClearanceLevel | undefined,
      },
      auth.clearance,
      auth.id
    );
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
