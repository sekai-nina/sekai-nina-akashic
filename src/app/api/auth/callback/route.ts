import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/db";
import { getInvitationByToken, consumeInvitation } from "@/lib/domain/invitations";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";

function sanitizeRedirectPath(path: string): string {
  // Only allow relative paths starting with / and not //
  if (!path.startsWith("/") || path.startsWith("//")) return "/search";
  return path;
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = sanitizeRedirectPath(searchParams.get("next") ?? "/search");

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=no_code`);
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) {
    return NextResponse.redirect(`${origin}/login?error=auth_failed`);
  }

  const authUser = data.user;
  const email = authUser.email;
  if (!email) {
    return NextResponse.redirect(`${origin}/login?error=no_email`);
  }

  // Extract Discord metadata if available
  const discordId = authUser.user_metadata?.provider_id ?? authUser.user_metadata?.sub ?? null;
  const discordAvatar = authUser.user_metadata?.avatar_url ?? null;
  const discordName = authUser.user_metadata?.full_name ?? authUser.user_metadata?.name ?? null;

  // Check if user exists in our DB
  const existingUser = await prisma.user.findUnique({ where: { email } });

  if (existingUser) {
    // Verify Discord identity matches if already linked
    if (existingUser.discordId && discordId && existingUser.discordId !== discordId) {
      await supabase.auth.signOut();
      return NextResponse.redirect(`${origin}/login?error=auth_failed`);
    }

    // Existing user — update Discord info if available
    const updateData: Record<string, string> = {};
    if (discordId && !existingUser.discordId) updateData.discordId = discordId;
    if (discordAvatar && discordAvatar !== existingUser.avatarUrl) updateData.avatarUrl = discordAvatar;
    if (Object.keys(updateData).length > 0) {
      await prisma.user.update({ where: { id: existingUser.id }, data: updateData });
    }
    return NextResponse.redirect(`${origin}${next}`);
  }

  // New user — require invitation token
  const cookieStore = await cookies();
  const inviteToken = cookieStore.get("invite_token")?.value;

  if (!inviteToken) {
    // No invitation — this is an unauthorized signup attempt
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=no_invite`);
  }

  const invitation = await getInvitationByToken(inviteToken);
  if (!invitation) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=invalid_invite`);
  }

  // Check email restriction
  if (invitation.email && invitation.email !== email) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=email_mismatch`);
  }

  // Atomically consume invitation first (race-condition safe).
  // usedById is set after the user is created below.
  const consumed = await consumeInvitation(inviteToken);
  if (!consumed) {
    await supabase.auth.signOut();
    return NextResponse.redirect(`${origin}/login?error=invalid_invite`);
  }

  // Create user in our DB
  const user = await prisma.user.create({
    data: {
      email,
      name: discordName || email.split("@")[0],
      passwordHash: "",
      role: invitation.role,
      clearance: invitation.clearance,
      discordId,
      avatarUrl: discordAvatar,
    },
  });

  // Update invitation with actual user ID
  await prisma.invitation.update({
    where: { token: inviteToken },
    data: { usedById: user.id },
  });

  cookieStore.delete("invite_token");

  return NextResponse.redirect(`${origin}${next}`);
}
