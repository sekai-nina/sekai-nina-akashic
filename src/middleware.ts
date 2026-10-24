import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const MFA_EXEMPT_PREFIXES = ["/login", "/invite/", "/mfa/", "/api/auth/"];

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // getSession() decodes the JWT locally — no network round-trip.
  // Expired tokens are refreshed via the setAll cookie callback above.
  const { data: { session } } = await supabase.auth.getSession();

  const pathname = request.nextUrl.pathname;
  const isMfaExempt = MFA_EXEMPT_PREFIXES.some((p) => pathname.startsWith(p));

  // MFA enforcement using session claims (no additional API call)
  // API キー認証の経路は matcher から外してあるのでここには来ない
  if (session?.user && !isMfaExempt) {
    // currentLevel はこのセッションの JWT の aal、nextLevel は検証済みの因子があれば aal2
    // 因子の有無だけを見ていると、MFA 登録済みのユーザーが Discord / パスワードだけ（aal1）で入れてしまう
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();

    if (aal?.nextLevel !== "aal2") {
      // 検証済みの因子が無い（未登録 / QR を出したまま放置した未検証の因子だけ）
      return NextResponse.redirect(new URL("/mfa/setup", request.url));
    }
    if (aal.currentLevel !== "aal2") {
      return NextResponse.redirect(new URL("/mfa/verify", request.url));
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    // API キー認証の経路 (/api/v1/, /api/mcp) と Vercel Cron (/api/cron/) は Cookie を持たないので
    // middleware を通す意味がない。matcher から外して Supabase クライアントの生成ごと省く。
    // MCP は 1 セッションで initialize → tools/list → tools/call と何往復もするので効く。
    "/((?!api/v1/|api/mcp|api/cron/|_next/static|_next/image|favicon.ico|icon.jpg|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
