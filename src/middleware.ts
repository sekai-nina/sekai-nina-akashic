import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Routes that don't need MFA check
const MFA_EXEMPT_PREFIXES = ["/login", "/invite/", "/mfa/", "/api/auth/"];

function isMfaExempt(pathname: string): boolean {
  return MFA_EXEMPT_PREFIXES.some((p) => pathname.startsWith(p));
}

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

  // Refresh session if expired
  const { data: { user } } = await supabase.auth.getUser();

  // MFA enforcement: skip for exempt routes and API key routes
  const pathname = request.nextUrl.pathname;
  if (user && !isMfaExempt(pathname) && !pathname.startsWith("/api/v1/")) {
    const { data: aalData } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();

    if (aalData) {
      const { currentLevel, nextLevel } = aalData;
      // If MFA is enrolled (nextLevel is aal2) but session is only aal1, redirect to verify
      if (nextLevel === "aal2" && currentLevel === "aal1") {
        return NextResponse.redirect(new URL("/mfa/verify", request.url));
      }
      // If no MFA enrolled at all, redirect to setup
      if (nextLevel === "aal1" && currentLevel === "aal1") {
        return NextResponse.redirect(new URL("/mfa/setup", request.url));
      }
    }
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.jpg|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
