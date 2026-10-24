import { lensApiGone } from "@/lib/coverage/gone";

/** 観点別のアイテムチェックは #233 段階3で終了。既存の記録は保存する。 */
export async function PUT(request: Request) {
  return lensApiGone(request, "write");
}
