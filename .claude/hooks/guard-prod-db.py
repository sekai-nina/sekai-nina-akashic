#!/usr/bin/env python3
"""PreToolUse(Bash) フック: 本番 DB を壊しうるコマンドを実行前に止める。

worktree の .env の DATABASE_URL / DIRECT_URL は本番の Supabase を指している。
2026-10-24 に `prisma migrate diff --from-migrations --shadow-database-url "$DIRECT_URL"` で
本番の public スキーマが消えた (CLAUDE.md「最重要」0)。人の注意ではなく、ここで機械的に止める。

- deny: DB を作り直す / 消すコマンド (理由を Claude に返す。回避させない)
- ask : 本番に書き込みうるが正当な用途もあるもの (毎回ユーザーに確認させる)
"""
import json
import re
import sys

LOCAL_HOST = re.compile(r"^(postgres(ql)?://)?[^@/\s]*@?(localhost|127\.0\.0\.1|\[::1\])([:/]|$)")

DENY = [
    (r"\bprisma\b[^\n;&|]*\bmigrate\s+(dev|reset)\b",
     "prisma migrate dev / reset はシャドウ DB や対象 DB を作り直す。.env は本番なので使わない (/db-migration スキルの手順を使う)"),
    (r"--from-migrations\b",
     "--from-migrations はシャドウ DB にマイグレーションを当て直す (DB を作り直す)。差分は --from-schema-datamodel / --to-schema-datamodel で取る"),
    (r"\bprisma\b[^\n;&|]*\bdb\s+push\b[^\n;&|]*--(force-reset|accept-data-loss)\b",
     "prisma db push --force-reset / --accept-data-loss は DB のデータを消す"),
    (r"\bdrop\s+(schema|database)\b",
     "DROP SCHEMA / DROP DATABASE は実行させない"),
    (r"\bdb:migrate\b",
     "pnpm db:migrate は prisma migrate dev (シャドウ DB を作り直す)。/db-migration スキルの手順を使う"),
]

ASK = [
    (r"\bprisma\b[^\n;&|]*\bmigrate\s+deploy\b",
     "prisma migrate deploy は本番にマイグレーションを当てる。ユーザーの了承が要る"),
    (r"\bprisma\b[^\n;&|]*\bdb\s+(execute|push)\b",
     "prisma db execute / db push は本番のスキーマやデータを書き換えうる"),
    (r"\bprisma\b[^\n;&|]*\bmigrate\s+resolve\b",
     "prisma migrate resolve は本番のマイグレーション履歴を書き換える"),
    (r"\b(drop\s+table|truncate)\b",
     "DROP TABLE / TRUNCATE を含む"),
    (r"\bdb:(push|seed)\b",
     "pnpm db:push / db:seed は .env の DB (本番) を書き換える"),
]


def decide(command: str):
    # 改行の継続 (\ + 改行) をつなぎ、大文字小文字を無視して見る
    cmd = re.sub(r"\\\n", " ", command)
    low = cmd.lower()
    for pattern, reason in DENY:
        if re.search(pattern, low):
            return "deny", reason
    # --shadow-database-url は localhost だけ許す (変数・本番 URL は拒否)
    for m in re.finditer(r"--shadow-database-url(?:=|\s+)(\"[^\"]*\"|'[^']*'|\S+)", cmd):
        value = m.group(1).strip("\"'")
        if not LOCAL_HOST.match(value):
            return "deny", f"--shadow-database-url に localhost 以外 ({value[:40]}) が渡されている。シャドウ DB は作り直されるので、自分で立てたローカル Postgres だけを指す"
    for pattern, reason in ASK:
        if re.search(pattern, low):
            return "ask", reason
    return None, None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    if data.get("tool_name") != "Bash":
        return 0
    command = (data.get("tool_input") or {}).get("command") or ""
    decision, reason = decide(command)
    if decision:
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": decision,
                "permissionDecisionReason": f"[guard-prod-db] {reason} (CLAUDE.md「最重要」0)",
            }
        }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
