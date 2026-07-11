import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { toggleCheck } from "@/lib/domain/coverage";
import type { ClearanceLevel } from "@prisma/client";

/**
 * PUT /coverage/checks
 * アイテムチェックのトグル（冪等 upsert / delete）。
 * ボディ: { lensKey, dataSourceKey, itemKey, checked, note?, classification? }
 */
export async function PUT(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const body = await request.json();
  if (!body.lensKey || !body.dataSourceKey || !body.itemKey) {
    return NextResponse.json(
      { error: "lensKey, dataSourceKey and itemKey are required" },
      { status: 400 }
    );
  }
  if (typeof body.checked !== "boolean") {
    return NextResponse.json({ error: "checked (boolean) is required" }, { status: 400 });
  }

  try {
    const result = await toggleCheck(
      {
        lensKey: body.lensKey,
        dataSourceKey: body.dataSourceKey,
        itemKey: body.itemKey,
        checked: body.checked,
        note: body.note,
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
