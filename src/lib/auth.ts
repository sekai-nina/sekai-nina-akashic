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

export async function auth(): Promise<Session | null> {
  const supabase = await createClient();
  const {
    data: { user: supabaseUser },
  } = await supabase.auth.getUser();

  if (!supabaseUser?.email) return null;

  const user = await prisma.user.findUnique({
    where: { email: supabaseUser.email },
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
}
