/**
 * APIキーを生成するCLIスクリプト
 *
 * Usage:
 *   pnpm cli:keygen <user-email> <key-name>
 *   pnpm cli:keygen admin@akashic.local "discord-bot"
 */
import { PrismaClient } from "@prisma/client";
import { createHash, randomBytes } from "crypto";

const prisma = new PrismaClient();

async function main() {
  const [, , email, name] = process.argv;

  if (!email || !name) {
    console.error("Usage: pnpm cli:keygen <user-email> <key-name>");
    console.error('Example: pnpm cli:keygen admin@akashic.local "discord-bot"');
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
      permissions: ["read", "write"],
    },
  });

  console.log("API key created successfully!");
  console.log(`  Name:   ${name}`);
  console.log(`  User:   ${user.email} (${user.role})`);
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
