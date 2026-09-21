/**
 * APIキーを生成するCLIスクリプト
 *
 * Usage:
 *   pnpm cli:keygen <user-email> <key-name> [permissions]
 *   pnpm cli:keygen admin@akashic.local "discord-bot"
 *   pnpm cli:keygen admin@akashic.local "ipad-insta-worker" insta_worker
 *
 * permissions はカンマ区切り (省略時 read,write)。iPad ワーカー (#178) には
 * `insta_worker` だけを与え、read / write を持たせない (iPad が漏れても他の API は叩けない)。
 * **permission はルートを絞るだけで、RLS の範囲はキーの持ち主のクリアランスのまま。**
 * ワーカー用キーは clearance が internal の専用ユーザーに発行する (admin の垢に付けない)。
 */
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "crypto";
import { WORKER_PERMISSION } from "@/lib/insta/jobs";

const prisma = new PrismaClient();

/** アプリが見る permission。`insta_worker` は /api/v1/insta/jobs の iPad 側だけを通す */
const KNOWN_PERMISSIONS = ["read", "write", WORKER_PERMISSION];

async function main() {
  const [, , email, name, permissionsArg] = process.argv;

  if (!email || !name) {
    console.error("Usage: pnpm cli:keygen <user-email> <key-name> [permissions]");
    console.error('Example: pnpm cli:keygen admin@akashic.local "discord-bot"');
    console.error('         pnpm cli:keygen admin@akashic.local "ipad-insta-worker" insta_worker');
    process.exit(1);
  }

  const permissions = (permissionsArg ?? "read,write")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const unknown = permissions.filter((p) => !KNOWN_PERMISSIONS.includes(p));
  if (permissions.length === 0 || unknown.length > 0) {
    console.error(`Unknown permission: ${unknown.join(", ") || "(empty)"} (known: ${KNOWN_PERMISSIONS.join(", ")})`);
    process.exit(1);
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    console.error(`User not found: ${email}`);
    process.exit(1);
  }

  const rawKey = "ak_" + randomBytes(32).toString("hex");
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.slice(0, 11);

  await prisma.apiKey.create({
    data: {
      name,
      keyHash,
      keyPrefix,
      userId: user.id,
      permissions,
    },
  });

  console.log("API key created successfully!");
  console.log(`  Name:   ${name}`);
  console.log(`  User:   ${user.email} (${user.role})`);
  console.log(`  Perms:  ${permissions.join(", ")}`);
  if (permissions.includes(WORKER_PERMISSION) && user.clearance !== "internal") {
    console.log("");
    console.log(`⚠ ${WORKER_PERMISSION} のキーは clearance=internal の専用ユーザーに発行してください`);
    console.log(`  (このユーザーは ${user.clearance}。RLS の範囲は permission ではなく持ち主のクリアランスで決まります)`);
  }
  console.log(`  Key:    ${rawKey}`);
  console.log("");
  console.log("⚠ Save this key now — it cannot be retrieved later.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
