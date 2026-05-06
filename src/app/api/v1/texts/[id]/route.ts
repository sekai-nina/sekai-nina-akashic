import { NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/api-auth";
import { updateText } from "@/lib/domain/texts";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireApiAuth(request, "write");
  if (auth instanceof NextResponse) return auth;

  const { id } = await params;
  const body = await request.json();
  const { content } = body as { content?: string };

  if (!content) {
    return NextResponse.json(
      { error: "content is required" },
      { status: 400 }
    );
  }

  try {
    const text = await updateText(id, content);
    return NextResponse.json(text);
  } catch {
    return NextResponse.json(
      { error: "Text not found" },
      { status: 404 }
    );
  }
}
