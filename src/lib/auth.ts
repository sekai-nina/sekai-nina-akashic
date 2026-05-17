import { cache } from "react";
import { unstable_cache } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "./db";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
  clearance: string;
  avatarUrl: string | null;
}

export interface Session {
  user: SessionUser;
}

/** Cache user DB lookup for 5 minutes to avoid a DB round-trip on every navigation */
const getCachedUser = unstable_cache(
  async (email: string) => {
    const user = await prisma.user.findUnique({
      where: { email },
    });
    if (!user) return null;
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      clearance: user.clearance,
      avatarUrl: user.avatarUrl,
    };
  },
  ["auth-user"],
  { revalidate: 300 }
);

/**
 * Cached per-request auth.
 * Uses getSession() instead of getUser() because middleware already
 * validates/refreshes the JWT on every request.
 * Wrapped in React.cache() so layout + page calling auth() only
 * executes once per render pass.
 */
export const auth = cache(async (): Promise<Session | null> => {
  const supabase = await createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session?.user?.email) return null;

  const user = await getCachedUser(session.user.email);
  if (!user) return null;

  return { user };
});
