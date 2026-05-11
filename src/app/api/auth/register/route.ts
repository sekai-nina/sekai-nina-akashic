import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { createAdminClient } from "@/lib/supabase/admin";
import { getInvitationByToken, consumeInvitation } from "@/lib/domain/invitations";

export async function POST(request: Request) {
  const body = await request.json();
  const { token, email, password, name } = body;

  if (!token || !email || !password || !name) {
    return NextResponse.json({ error: "必須項目が不足しています" }, { status: 400 });
  }

  if (password.length < 8) {
    return NextResponse.json({ error: "パスワードは8文字以上必要です" }, { status: 400 });
  }

  // Validate invitation
  const invitation = await getInvitationByToken(token);
  if (!invitation) {
    return NextResponse.json({ error: "招待が無効です" }, { status: 400 });
  }

  // If invitation is restricted to a specific email, verify it matches
  if (invitation.email && invitation.email !== email) {
    return NextResponse.json({ error: "このメールアドレスでは招待を使用できません" }, { status: 400 });
  }

  // Check if user already exists
  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    return NextResponse.json({ error: "このメールアドレスは既に登録されています" }, { status: 400 });
  }

  // Create user in Supabase Auth
  const supabase = createAdminClient();
  const { error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (authError) {
    return NextResponse.json({ error: `登録に失敗しました: ${authError.message}` }, { status: 500 });
  }

  // Create user in local DB
  let user;
  try {
    user = await prisma.user.create({
      data: {
        email,
        name,
        passwordHash: "",
        role: invitation.role,
        clearance: invitation.clearance,
      },
    });
  } catch {
    // Clean up Supabase user if local DB creation fails
    const { data: authUsers } = await supabase.auth.admin.listUsers();
    const authUser = authUsers?.users.find((u) => u.email === email);
    if (authUser) await supabase.auth.admin.deleteUser(authUser.id);
    return NextResponse.json({ error: "登録に失敗しました" }, { status: 500 });
  }

  // Atomically consume invitation (race-condition safe)
  const consumed = await consumeInvitation(token, user.id);
  if (!consumed) {
    // Invitation was consumed by another request — clean up
    await prisma.user.delete({ where: { id: user.id } });
    const { data: authUsers } = await supabase.auth.admin.listUsers();
    const authUser = authUsers?.users.find((u) => u.email === email);
    if (authUser) await supabase.auth.admin.deleteUser(authUser.id);
    return NextResponse.json({ error: "招待は既に使用されています" }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
