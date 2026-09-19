import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { listAiQuestions, recordAiQuestion } from "@/lib/domain/ai-questions";

/** 案内AI Worker が送ってくる1問1答を受け取る。取り出しは一覧画面と同じ関数を使う */
export async function GET(request: Request) {
  const auth = await requireApiAuth(request, "read");
  if (auth instanceof NextResponse) return auth;

  const url = new URL(request.url);
  const take = Math.min(Number(url.searchParams.get("perPage") ?? 50) || 50, 200);
  const page = Math.max(Number(url.searchParams.get("page") ?? 1) || 1, 1);

  const result = await listAiQuestions(auth.clearance, {
    onlyNoHit: url.searchParams.get("noHit") === "1",
    q: url.searchParams.get("q")?.trim() || undefined,
    take,
    skip: (page - 1) * take,
  });
  return NextResponse.json(result);
}

export async function POST(request: Request) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const body = await request.json().catch(() => null);
  if (!body || typeof body.question !== "string" || typeof body.answer !== "string") {
    return NextResponse.json({ error: "question and answer are required" }, { status: 400 });
  }

  // 送信元は Worker だけだが、壊れた値で行が増えないように最低限そろえる
  const askedAt = body.askedAt ? new Date(body.askedAt) : new Date();
  if (Number.isNaN(askedAt.getTime())) {
    return NextResponse.json({ error: "askedAt must be a valid date" }, { status: 400 });
  }
  const citations = Array.isArray(body.citations)
    ? body.citations
        .filter((c: unknown): c is { title: string; url: string } =>
          !!c && typeof (c as { title?: unknown }).title === "string" && typeof (c as { url?: unknown }).url === "string"
        )
        .slice(0, 20)
    : [];

  const created = await recordAiQuestion(
    {
      askedAt,
      question: body.question.slice(0, 500),
      answer: body.answer.slice(0, 5000),
      citations,
      cached: body.cached === true,
      origin: typeof body.origin === "string" ? body.origin.slice(0, 200) : "",
      followUp: body.followUp === true,
    },
    auth.clearance
  );
  return NextResponse.json({ id: created.id }, { status: 201 });
}
