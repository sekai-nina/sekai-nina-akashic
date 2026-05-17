import { randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import type { ClearanceLevel, Role } from "@prisma/client";

const invitationSelect = {
  id: true,
  token: true,
  email: true,
  role: true,
  clearance: true,
  expiresAt: true,
  usedAt: true,
  usedById: true,
  usedBy: { select: { id: true, name: true, email: true } },
  createdById: true,
  createdBy: { select: { id: true, name: true } },
  createdAt: true,
} as const;

export async function createInvitation(
  createdById: string,
  opts: {
    email?: string;
    role?: Role;
    clearance?: ClearanceLevel;
    expiresInDays?: number;
  } = {}
) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + (opts.expiresInDays ?? 7));

  const token = randomBytes(32).toString("hex");

  return prisma.invitation.create({
    data: {
      token,
      email: opts.email || null,
      role: opts.role ?? "member",
      clearance: opts.clearance ?? "internal",
      expiresAt,
      createdById,
    },
    select: invitationSelect,
  });
}

export async function getInvitationByToken(token: string) {
  const invitation = await prisma.invitation.findUnique({
    where: { token },
    select: invitationSelect,
  });

  if (!invitation) return null;
  if (invitation.usedAt) return null;
  if (invitation.expiresAt < new Date()) return null;

  return invitation;
}

/**
 * Atomically consume an invitation. Returns the updated invitation,
 * or null if it was already consumed or expired (race condition safe).
 *
 * Pass `userId` for the email/password flow where the user already exists.
 * Omit it for OAuth flows that must claim the invitation before creating
 * the user (set `usedById` in a follow-up update once the user is created).
 */
export async function consumeInvitation(token: string, userId?: string) {
  const result = await prisma.invitation.updateMany({
    where: { token, usedAt: null, expiresAt: { gte: new Date() } },
    data: userId ? { usedAt: new Date(), usedById: userId } : { usedAt: new Date() },
  });
  if (result.count === 0) return null;
  return prisma.invitation.findUnique({ where: { token } });
}

export async function listInvitations() {
  return prisma.invitation.findMany({
    select: invitationSelect,
    orderBy: { createdAt: "desc" },
  });
}

export async function deleteInvitation(id: string) {
  return prisma.invitation.delete({ where: { id } });
}
