import { lensApiGone } from "@/lib/coverage/gone";

/** 観点（Lens）の管理は #253 で終了。テーブルと行は残す。 */
export async function PATCH(request: Request) {
  return lensApiGone(request, "write");
}
