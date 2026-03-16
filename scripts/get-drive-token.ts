/**
 * Google Drive OAuth2 リフレッシュトークン取得スクリプト
 *
 * 使い方:
 *   1. .env に GOOGLE_CLIENT_ID と GOOGLE_CLIENT_SECRET を設定
 *   2. pnpm tsx scripts/get-drive-token.ts
 *   3. 表示された URL をブラウザで開いて認証
 *   4. リダイレクト先の URL からコードをコピーしてターミナルに貼り付け
 *   5. 出力されたリフレッシュトークンを .env の GOOGLE_REFRESH_TOKEN に設定
 */

import "dotenv/config";
import { google } from "googleapis";
import { createInterface } from "readline";

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("GOOGLE_CLIENT_ID と GOOGLE_CLIENT_SECRET を .env に設定してください");
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  "http://localhost:3000/api/auth/callback/google" // redirect URI (not actually used, we use urn:ietf:wg:oauth:2.0:oob alternative)
);

// Use out-of-band flow for CLI
const oauth2ClientOOB = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  "http://localhost"
);

const authUrl = oauth2ClientOOB.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/drive.file"],
});

console.log("\n以下の URL をブラウザで開いて認証してください:\n");
console.log(authUrl);
console.log("\n認証後、リダイレクト先の URL をそのまま貼り付けてください");
console.log("（http://localhost/?code=XXXX&scope=... の形式）\n");

const rl = createInterface({ input: process.stdin, output: process.stdout });

rl.question("リダイレクト URL: ", async (input) => {
  rl.close();

  let code: string;
  try {
    const url = new URL(input.trim());
    code = url.searchParams.get("code") || input.trim();
  } catch {
    code = input.trim();
  }

  try {
    const { tokens } = await oauth2ClientOOB.getToken(code);
    console.log("\n=== 以下を .env に追加してください ===\n");
    console.log(`GOOGLE_REFRESH_TOKEN="${tokens.refresh_token}"`);
    console.log("\n======================================\n");
  } catch (err) {
    console.error("トークンの取得に失敗しました:", err);
  }
});
