import { lensApiGone } from "@/lib/coverage/gone";

/** 観点（Lens）の管理は #253 で終了。テーブルと行は残す。 */
export async function GET(request: Request) {
  return lensApiGone(request, "read");
}

export async function POST(request: Request) {
  return lensApiGone(request, "write");
}
