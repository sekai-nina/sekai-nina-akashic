import { Role } from "@prisma/client";
import { prisma } from "@/lib/db";
import { createAdminClient } from "@/lib/supabase/admin";

const userSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function createUser(
  email: string,
  name: string,
  password: string,
  role: Role = Role.member
) {
  const supabase = createAdminClient();
  const { error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`Supabase Auth: ${error.message}`);

  return prisma.user.create({
    data: { email, name, passwordHash: "", role },
    select: userSelect,
  });
}

export async function updateUser(
  id: string,
  data: {
    name?: string;
    email?: string;
    role?: Role;
    password?: string;
  }
) {
  const { password, ...rest } = data;
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw new Error("User not found");

  // Update Supabase Auth if email or password changed
  if (password || (rest.email && rest.email !== user.email)) {
    const supabase = createAdminClient();
    const { data: authUsers } = await supabase.auth.admin.listUsers();
    const authUser = authUsers?.users.find((u) => u.email === user.email);
    if (authUser) {
      const updates: Record<string, string> = {};
      if (rest.email && rest.email !== user.email) updates.email = rest.email;
      if (password) updates.password = password;
      await supabase.auth.admin.updateUserById(authUser.id, updates);
    }
  }

  return prisma.user.update({
    where: { id },
    data: rest,
    select: userSelect,
  });
}

export async function deleteUser(id: string) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (user) {
    const supabase = createAdminClient();
    const { data: authUsers } = await supabase.auth.admin.listUsers();
    const authUser = authUsers?.users.find((u) => u.email === user.email);
    if (authUser) {
      await supabase.auth.admin.deleteUser(authUser.id);
    }
  }
  return prisma.user.delete({ where: { id } });
}

export async function listUsers() {
  return prisma.user.findMany({
    select: userSelect,
    orderBy: { createdAt: "asc" },
  });
}

export async function getUser(id: string) {
  return prisma.user.findUnique({
    where: { id },
    select: userSelect,
  });
}
