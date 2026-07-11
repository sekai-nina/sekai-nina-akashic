import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { bulkCheck } from "@/lib/domain/coverage";
import type { ClearanceLevel } from "@prisma/client";

/**
 * POST /coverage/checks/bulk
 * 範囲一括チェック。itemDate <= untilDate の全導出アイテムを対象 lens でチェック済みに。
 * untilDate 省略時は全期間（v2.3）。
 * onlyIrrelevant=true は関連なし（言及なし かつ 本人著でない）のみを対象にする（v2.4）。
 * ボディ: { dataSourceKey, lensKeys[], untilDate?, onlyIrrelevant?, classification? }
 */
export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const body = await request.json();
  if (!body.dataSourceKey || !Array.isArray(body.lensKeys)) {
    return NextResponse.json(
      { error: "dataSourceKey and lensKeys[] are required" },
      { status: 400 }
    );
  }

  try {
    const result = await bulkCheck(
      {
        dataSourceKey: body.dataSourceKey,
        lensKeys: body.lensKeys,
        untilDate: body.untilDate ?? null,
        onlyIrrelevant: body.onlyIrrelevant === true,
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
