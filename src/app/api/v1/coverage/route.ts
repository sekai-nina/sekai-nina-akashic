import { lensApiGone } from "@/lib/coverage/gone";

/** 観点×ソースのマトリクスは #253 で終了。既存の記録は保存する。 */
export async function GET(request: Request) {
  return lensApiGone(request, "read");
}

export async function PUT(request: Request) {
  return lensApiGone(request, "write");
}
