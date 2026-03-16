import { Role } from "@prisma/client";
import { hash } from "bcryptjs";
import { prisma } from "@/lib/db";

const BCRYPT_ROUNDS = 12;

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
  const passwordHash = await hash(password, BCRYPT_ROUNDS);

  return prisma.user.create({
    data: {
      email,
      name,
      passwordHash,
      role,
    },
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

  const updateData: {
    name?: string;
    email?: string;
    role?: Role;
    passwordHash?: string;
  } = { ...rest };

  if (password) {
    updateData.passwordHash = await hash(password, BCRYPT_ROUNDS);
  }

  return prisma.user.update({
    where: { id },
    data: updateData,
    select: userSelect,
  });
}

export async function deleteUser(id: string) {
  return prisma.user.delete({
    where: { id },
  });
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
