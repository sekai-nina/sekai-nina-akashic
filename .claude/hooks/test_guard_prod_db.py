"""guard-prod-db.py の判定テスト。実行: python3 -m unittest discover -s .claude/hooks"""
import importlib.util
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("guard", os.path.join(HERE, "guard-prod-db.py"))
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)

PROD = "postgresql://akashic_cli.osetzxlsemesugakntfv:pw@aws-1-ap-northeast-1.pooler.supabase.com:5432/postgres"
LOCAL = "postgresql://postgres:pw@localhost:5432/akashic"


class GuardTest(unittest.TestCase):
    def setUp(self):
        for k in guard.URL_KEYS:
            os.environ.pop(k, None)
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = os.path.realpath(self.tmp.name)
        self.write(".env", f'DATABASE_URL="{PROD}"\nDIRECT_URL="{PROD}"\n')
        self.write("local.env", f"DATABASE_URL={LOCAL}\nDIRECT_URL={LOCAL}\n")
        self.write("migrate.env", f"DIRECT_URL={PROD.replace('akashic_cli', 'postgres')}\n")
        self.write("package.json", json.dumps({"scripts": {
            "db:migrate": "prisma migrate dev",
            "db:push": "prisma db push",
            "db:seed": "tsx prisma/seed.ts",
            "cli:wipe": "tsx src/cli/wipe.ts",
            "cli:safe": "tsx src/cli/safe.ts",
        }}))
        self.write("prisma/seed.ts", "await prisma.user.upsert({ where: { id: 1 }, create: {}, update: {} });\n")
        self.write("src/lib/danger.ts", 'export const wipe = () => prisma.$executeRawUnsafe(`DELETE FROM "Asset"`);\n')
        self.write("src/cli/wipe.ts", 'import { wipe } from "@/lib/danger";\nawait wipe();\n')
        self.write("src/cli/safe.ts", 'await prisma.asset.deleteMany({ where: { id: { in: ids } } });\n'
                   'await prisma.$executeRaw`UPDATE "Article" SET "dirty" = true WHERE "id" = ${id}`;\n')
        self.write("src/cli/empty.ts", "await prisma.assetText.deleteMany({});\n")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, rel, content):
        path = os.path.join(self.dir, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)

    def decide(self, command):
        return guard.decide(command, cwd=self.dir, project_dir=self.dir)[0]

    # --- 5. 誤検知 -------------------------------------------------------
    def test_strings_in_other_commands_pass(self):
        for cmd in [
            'gh issue create --title x --body "prisma migrate reset と --from-migrations と DROP SCHEMA public"',
            "echo 'npx prisma migrate dev'",
            'git commit -m "$(cat <<\'EOF\'\n:fish: prisma migrate reset を止める\n\nDROP SCHEMA の話\nEOF\n)"',
            "cat <<'EOF' > notes.md\nnpx prisma migrate reset --force\nDROP SCHEMA public CASCADE;\nEOF",
            "grep -rn 'migrate dev' .claude/",
            "gh pr create --body-file body.md",
        ]:
            with self.subTest(cmd=cmd):
                self.assertIsNone(self.decide(cmd))

    def test_herestring_is_not_heredoc(self):
        self.assertIsNone(self.decide("grep x <<< 'a'\nnpx prisma generate"))
        self.assertEqual(self.decide("grep x <<< 'a'\nnpx prisma migrate reset"), "deny")

    def test_unparseable_falls_back_to_review(self):
        self.assertEqual(self.decide('npx prisma migrate reset "unterminated'), "review")
        self.assertIsNone(self.decide('echo "unterminated'))

    # --- 1. 接続先 -------------------------------------------------------
    def test_destructive_prisma_against_prod_denied(self):
        for cmd in [
            "npx prisma migrate reset --force",
            "pnpm exec prisma migrate dev --name x",
            "pnpm prisma db push --force-reset",
            "pnpm db:migrate",
            "bash -c 'npx prisma migrate reset'",
            "cd . && npx prisma migrate dev",
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(self.decide(cmd), "deny")

    def test_shadow_database_url(self):
        self.assertEqual(self.decide(
            'npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma '
            '--shadow-database-url "$DIRECT_URL" --script'), "deny")
        self.assertEqual(self.decide(
            f"npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel x --shadow-database-url {PROD}"), "deny")
        self.assertEqual(self.decide("npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel x"), "deny")
        self.assertIsNone(self.decide(
            f"npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel x --shadow-database-url {LOCAL}"))
        self.assertIsNone(self.decide(
            "npx prisma migrate diff --from-schema-datamodel a.prisma --to-schema-datamodel prisma/schema.prisma --script"))

    def test_prod_status_passes_deploy_asks(self):
        self.assertIsNone(self.decide("npx prisma migrate status"))
        self.assertEqual(self.decide("(set -a; . ./migrate.env; set +a; npx prisma migrate deploy)"), "ask")
        self.assertEqual(self.decide("npx prisma migrate deploy"), "ask")

    def test_prod_other_writes_denied(self):
        for cmd in [
            "npx prisma db push",
            "npx prisma db execute --stdin <<'EOF'\nUPDATE x SET y = 1;\nEOF",
            "npx prisma migrate resolve --applied 2026_x",
            "pnpm db:push",
            "pnpm db:seed",
            'psql "$DIRECT_URL" -c "DROP SCHEMA public CASCADE"',
            f"psql {PROD} -c 'DELETE FROM \"Asset\" WHERE id = 1'",
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(self.decide(cmd), "deny")

    def test_prod_reads_pass(self):
        for cmd in [
            "npx prisma generate",
            "pnpm db:generate",
            "npx prisma validate",
            f"psql {PROD} -c 'SELECT count(*) FROM \"Asset\"'",
            f"pg_dump {PROD}",
        ]:
            with self.subTest(cmd=cmd):
                self.assertIsNone(self.decide(cmd))

    def test_local_target_passes(self):
        for cmd in [
            f"DATABASE_URL={LOCAL} DIRECT_URL={LOCAL} npx prisma migrate reset --force",
            f"DATABASE_URL={LOCAL} DIRECT_URL={LOCAL} pnpm db:migrate",
            "(set -a; source local.env; set +a; npx prisma db push --accept-data-loss)",
            f"npx prisma db execute --url {LOCAL} --stdin <<'EOF'\nTRUNCATE x;\nEOF",
            f"psql {LOCAL} -c 'DROP SCHEMA public CASCADE'",
            "dotenv -e local.env -- npx prisma migrate dev",
        ]:
            with self.subTest(cmd=cmd):
                self.assertIsNone(self.decide(cmd))

    def test_unresolvable_target(self):
        os.remove(os.path.join(self.dir, ".env"))
        self.assertEqual(self.decide("npx prisma migrate reset"), "deny")
        self.assertEqual(self.decide("npx prisma db push"), "review")
        self.assertEqual(self.decide("source ./missing.env && npx prisma migrate deploy"), "review")
        self.assertEqual(self.decide("psql -c 'UPDATE x SET y = 1'"), "review")

    # --- 2. スクリプトの中身 ----------------------------------------------
    def test_script_with_bulk_delete_reviews_on_prod(self):
        for cmd in [
            "npx tsx src/cli/empty.ts",
            "pnpm cli:wipe",                      # import 先 (@/lib/danger) の DELETE を拾う
            "npx tsx -e 'await prisma.asset.deleteMany()'",
            "node -e 'prisma.asset.updateMany({ data: { x: 1 } })'",
            "npx tsx - <<'EOF'\nawait prisma.$executeRawUnsafe('TRUNCATE \"Asset\"');\nEOF",
            "npx tsx -e 'execSync(\"npx prisma migrate reset --force\")'",
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(self.decide(cmd), "review")

    def test_script_with_where_passes(self):
        self.write("src/cli/words.ts", "// delete from the list, then update x set y\nconst t = truncate(text, 10);\n")
        self.assertIsNone(self.decide("npx tsx src/cli/words.ts"))
        self.assertIsNone(self.decide("pnpm cli:safe"))
        self.assertIsNone(self.decide("npx tsx src/cli/safe.ts --apply"))

    def test_script_with_bulk_delete_passes_on_local(self):
        self.assertIsNone(self.decide(f"DATABASE_URL={LOCAL} DIRECT_URL={LOCAL} npx tsx src/cli/empty.ts"))
        self.assertIsNone(self.decide("(set -a; . ./local.env; set +a; pnpm cli:wipe)"))

    # --- レビューで見つかった穴 ---------------------------------------------
    def test_review_bypasses(self):
        for cmd in [
            "npm exec -- prisma migrate reset --force",
            "pnpm exec -- prisma migrate reset --force",
            "npx prisma@6.19.0 migrate reset --force",
            "npx -p prisma prisma migrate reset --force",
            "npx dotenv-cli -e .env -- prisma migrate reset --force",
            "bash -lc 'npx prisma migrate reset --force'",
            'zsh -ec "npx prisma db push --force-reset"',
            "source .env && psql \"$DATABASE_URL\" -c 'TRUNCATE \"Asset\"'",
            "cd src && npx prisma db push",
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(self.decide(cmd), "deny")
        for cmd in [
            "npx tsx -e 'await p.$executeRawUnsafe(`delete from \"Asset\"`)'",
            "npx tsx -e 'import \"./src/cli/wipe\"'",
            "npx tsx -e 'await p.asset.deleteMany({ where: undefined })'",
            "cat > /tmp/x.ts <<'X'\nawait p.asset.deleteMany()\nX\nnpx tsx /tmp/x-not-yet.ts",
            "echo 'await p.asset.deleteMany()' | npx tsx",
            "npx tsx watch src/cli/empty.ts",
        ]:
            with self.subTest(cmd=cmd):
                self.assertEqual(self.decide(cmd), "review")

    def test_review_false_positives(self):
        for cmd in [
            "gh issue create --title x --body 'Never run `npx prisma migrate reset` against prod'",
            "git commit -m 'docs: `prisma db push --force-reset` を禁止'",
            "echo 'psql $(prisma migrate reset)'",
            'gh pr create --body "avoid \\`prisma migrate dev\\`"',
            "source /bin/ls",
            "bash /bin/ls",
            "python3 -m unittest discover -s .claude/hooks",
            "npx tsx --version",
        ]:
            with self.subTest(cmd=cmd):
                self.assertIsNone(self.decide(cmd))

    def test_real_substitution_is_checked(self):
        self.assertEqual(self.decide('echo "$(npx prisma migrate reset --force)"'), "deny")
        self.assertEqual(self.decide("x=`npx prisma migrate reset --force`"), "deny")

    def test_python_stdin_dash_reads_heredoc(self):
        self.assertIsNone(self.decide("python3 - \"$f\" <<'PY'\nprint(open(__file__).read())\nPY"))
        self.assertEqual(self.decide("python3 - <<'PY'\ncur.execute('DELETE FROM \"Asset\"')\nPY"), "review")

    # --- review: Claude が確かめて印を付ければ通る ---------------------------
    def test_reviewed_mark_passes_review_only(self):
        mark = guard.REVIEWED_MARK
        self.assertIsNone(self.decide(f"{mark} npx tsx src/cli/empty.ts"))
        self.assertIsNone(self.decide(f"cd . && {mark} pnpm cli:wipe"))
        self.assertEqual(self.decide(f"{mark} npx prisma migrate reset --force"), "deny")
        self.assertEqual(self.decide(f"{mark} npx prisma migrate deploy"), "ask")
        self.assertEqual(self.decide(f"echo '{mark}x' && npx tsx src/cli/empty.ts"), "review")

    # --- main ------------------------------------------------------------
    def run_main(self, command):
        import io
        import sys
        payload = {"tool_name": "Bash", "cwd": self.dir, "tool_input": {"command": command}}
        old_in, old_out, old_env = sys.stdin, sys.stdout, os.environ.get("CLAUDE_PROJECT_DIR")
        os.environ["CLAUDE_PROJECT_DIR"] = self.dir
        sys.stdin, sys.stdout = io.StringIO(json.dumps(payload)), io.StringIO()
        try:
            guard.main()
            text = sys.stdout.getvalue()
        finally:
            sys.stdin, sys.stdout = old_in, old_out
            if old_env is None:
                os.environ.pop("CLAUDE_PROJECT_DIR", None)
            else:
                os.environ["CLAUDE_PROJECT_DIR"] = old_env
        return json.loads(text)["hookSpecificOutput"] if text else None

    def test_hook_output_shape(self):
        self.assertEqual(self.run_main("npx prisma migrate reset")["permissionDecision"], "deny")
        self.assertEqual(self.run_main("npx prisma migrate deploy")["permissionDecision"], "ask")

    def test_review_is_sent_as_deny_with_howto(self):
        out = self.run_main("npx tsx src/cli/empty.ts")
        self.assertEqual(out["permissionDecision"], "deny")  # ユーザーには確認を出さない
        self.assertIn(guard.REVIEWED_MARK, out["permissionDecisionReason"])
        self.assertIsNone(self.run_main(f"{guard.REVIEWED_MARK} npx tsx src/cli/empty.ts"))


if __name__ == "__main__":
    unittest.main()
