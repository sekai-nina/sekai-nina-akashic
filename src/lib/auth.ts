import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "./db";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface Session {
  user: SessionUser;
}

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

  const user = await prisma.user.findUnique({
    where: { email: session.user.email },
  });
  if (!user) return null;

  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  };
});
