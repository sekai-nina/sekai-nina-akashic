import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";
import type { User } from "@prisma/client";

export interface ApiKeyUser {
  id: string;
  email: string;
  name: string;
  role: string;
  apiKeyId: string;
  permissions: string[];
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * AuthorizationヘッダーからAPIキーを検証し、ユーザー情報を返す。
 * 無効な場合はnullを返す。
 */
export async function authenticateApiKey(
  request: Request
): Promise<ApiKeyUser | null> {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ak_")) return null;

  const key = authHeader.slice("Bearer ".length);
  const keyHash = hashKey(key);

  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash },
    include: { user: true },
  });

  if (!apiKey) return null;
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null;

  // lastUsedAtを非同期で更新（レスポンスをブロックしない）
  prisma.apiKey
    .update({
      where: { id: apiKey.id },
      data: { lastUsedAt: new Date() },
    })
    .catch(() => {});

  return {
    id: apiKey.user.id,
    email: apiKey.user.email,
    name: apiKey.user.name,
    role: apiKey.user.role,
    apiKeyId: apiKey.id,
    permissions: apiKey.permissions as string[],
  };
}

/**
 * APIルートで使うヘルパー。認証失敗時はエラーレスポンスを返す。
 */
export async function requireApiAuth(
  request: Request,
  requiredPermission?: string
): Promise<ApiKeyUser | NextResponse> {
  const user = await authenticateApiKey(request);
  if (!user) {
    return NextResponse.json(
      { error: "Invalid or missing API key" },
      { status: 401 }
    );
  }
  if (requiredPermission && !user.permissions.includes(requiredPermission)) {
    return NextResponse.json(
      { error: `Missing permission: ${requiredPermission}` },
      { status: 403 }
    );
  }
  return user;
}

/**
 * 新しいAPIキーを生成する。
 * 返り値のrawKeyは一度だけ表示し、以降は復元不可。
 */
export async function generateApiKey(
  userId: string,
  name: string,
  options?: { permissions?: string[]; expiresAt?: Date }
): Promise<{ rawKey: string; apiKey: { id: string; keyPrefix: string; name: string } }> {
  const rawKey = "ak_" + randomBytes(32).toString("hex");
  const keyHash = hashKey(rawKey);
  const keyPrefix = rawKey.slice(0, 11); // "ak_" + 8文字

  const apiKey = await prisma.apiKey.create({
    data: {
      name,
      keyHash,
      keyPrefix,
      userId,
      permissions: options?.permissions ?? ["read", "write"],
      expiresAt: options?.expiresAt ?? null,
    },
  });

  return {
    rawKey,
    apiKey: { id: apiKey.id, keyPrefix: apiKey.keyPrefix, name: apiKey.name },
  };
}
