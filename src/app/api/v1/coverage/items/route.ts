import { lensApiGone } from "@/lib/coverage/gone";

/** 観点ごとのチェックの読み取り互換は #253 で終了。素材の一覧は /progress を使う。 */
export async function GET(request: Request) {
  return lensApiGone(request, "read");
}
