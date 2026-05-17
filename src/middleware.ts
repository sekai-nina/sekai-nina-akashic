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
  if (session?.user && !isMfaExempt && !pathname.startsWith("/api/v1/")) {
    const factors = session.user.factors;
    const hasMfaEnrolled = factors && factors.length > 0;
    const hasVerifiedFactor = factors?.some((f) => f.status === "verified");

    if (hasMfaEnrolled && !hasVerifiedFactor) {
      return NextResponse.redirect(new URL("/mfa/verify", request.url));
    }
    if (!hasMfaEnrolled) {
      return NextResponse.redirect(new URL("/mfa/setup", request.url));
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.jpg|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
