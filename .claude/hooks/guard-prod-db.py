#!/usr/bin/env python3
"""PreToolUse(Bash) フック: 本番 DB を壊しうるコマンドを実行前に止める。

worktree の .env の DATABASE_URL / DIRECT_URL は本番の Supabase を指している。
2026-10-24 に `prisma migrate diff --from-migrations --shadow-database-url "$DIRECT_URL"` で
本番の public スキーマが消えた (CLAUDE.md「最重要」0)。人の注意ではなく、ここで機械的に止める。

判定の方針 (#251):
- コマンドをシェルの構文として分解し、実行されるもの (先頭の実行ファイルと DB に効く引数) だけを見る。
  `gh issue create --body "..."` や `echo` の文字列に禁止コマンドの名前が入っていても止めない
- DB に効くコマンドは接続先 (コマンド内の DATABASE_URL= / DIRECT_URL=、source した env ファイル、.env) を解決する。
  本番なら migrate status (通す) と migrate deploy (ユーザーに確認) 以外の書き込みを拒否し、ローカルなら通す。
  解決できないものは review (DB を作り直すものは解決できなくても拒否)
- tsx / node で流すスクリプトは、リポジトリ内の import 先まで読んで一括 DELETE / UPDATE・DROP・TRUNCATE を探す。
  あってローカル宛てでなければ review
- 構文を解釈できないときは、文字列だけの判定に落として review

決定: deny (理由を Claude に返す。回避させない) > ask (ユーザーに確認。本番への migrate deploy だけ)
  > review (Claude が自分で確かめ、AKASHIC_GUARD_REVIEWED=1 を付けて再実行する。ユーザーには聞かない)
  > 何も返さない (通常の権限判定)
ユーザーはコードを見せられても安全か判定できないので、コードの中身で迷うものはユーザーに聞かない。
"""
import json
import os
import re
import shlex
import sys

PROD_HOST = re.compile(r"(supabase\.(com|co)|osetzxlsemesugakntfv)", re.I)
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]"}
URL_KEYS = ("DATABASE_URL", "DIRECT_URL")

# review: ユーザーには聞かず、Claude 自身に確かめさせる (コードを見せられてもユーザーは判定できない)。
#   出力は deny + 手順。確かめたら REVIEWED_MARK を付けて再実行すれば通る
# ask: ユーザーが判断できる問いだけ (本番への migrate deploy)
RANK = {None: 0, "review": 1, "ask": 2, "deny": 3}
REVIEWED_MARK = "AKASHIC_GUARD_REVIEWED=1"
REVIEWED_RE = re.compile(r"(?:^|[\s;&|(])" + re.escape(REVIEWED_MARK) + r"(?=\s)")
REVIEW_HOWTO = (
    "ユーザーには聞かず、自分で確かめる: 接続先 (本番か) と、消える・書き換わる行 (対象テーブル・条件・件数を SELECT count で) を調べ、"
    "意図どおりで取り返しがつくと判断できたら、コマンドの先頭に " + REVIEWED_MARK + " を付けて再実行する。"
    "本番の行を広く消す・書き換えるのに意図と合わない、または確かめようがないなら実行しない")
MAX_DEPTH = 6
MAX_SCAN_FILES = 300


# ---------------------------------------------------------------------------
# 接続先の判定

def classify_url(value):
    """'local' / 'prod' / 'unknown'。変数参照のまま (= 解決できない) なら unknown。"""
    if value is None:
        return "unknown"
    v = value.strip().strip("\"'")
    if not v or "$" in v:
        return "unknown"
    if PROD_HOST.search(v):
        return "prod"
    m = re.match(r"^[a-z][a-z0-9+.-]*://(?:[^@/]*@)?(\[[^\]]+\]|[^:/?#]+)", v, re.I)
    host = m.group(1).lower() if m else ""
    if host in LOCAL_HOSTS:
        return "local"
    return "unknown"


def worst_target(kinds):
    kinds = set(kinds)
    if not kinds:
        return "unknown"
    if "prod" in kinds:
        return "prod"
    if "unknown" in kinds:
        return "unknown"
    return "local"


def read_text(path):
    """テキストとして読む。無い・読めない・バイナリなら None。"""
    try:
        with open(path, encoding="utf-8") as f:
            return f.read()
    except (OSError, ValueError):
        return None


def read_env_file(path):
    text = read_text(path)
    if text is None:
        return None
    env = {}
    for line in text.splitlines():
        m = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
        if m:
            env[m.group(1)] = m.group(2).strip().strip("\"'")
    return env


class Ctx:
    def __init__(self, cwd, project_dir):
        self.cwd = cwd
        self.project_dir = project_dir
        self.env = {}            # コマンド内で設定された変数 (NAME=v / export / source した env ファイル)
        self.unresolved = False  # 読めない env ファイルを source した
        self.pkg_scripts = None

    def copy(self):
        c = Ctx(self.cwd, self.project_dir)
        c.env = dict(self.env)
        c.unresolved = self.unresolved
        c.pkg_scripts = self.pkg_scripts
        return c

    def target(self, extra_env=None, explicit_urls=()):
        """コマンドが効く DB。明示の URL (--url 等) があればそれ、無ければ DATABASE_URL / DIRECT_URL。"""
        if explicit_urls:
            return worst_target(classify_url(u) for u in explicit_urls)
        env = dict(self.env)
        env.update(extra_env or {})
        # Prisma も dotenv/config も、cwd に無ければプロジェクト直下の .env を読む
        dotenv = read_env_file(os.path.join(self.cwd, ".env"))
        if dotenv is None:
            dotenv = read_env_file(os.path.join(self.project_dir, ".env")) or {}
        kinds = []
        for key in URL_KEYS:
            if key in env:
                kinds.append(classify_url(env[key]))
            elif key in dotenv:
                kinds.append(classify_url(dotenv[key]))
            elif key in os.environ:
                kinds.append(classify_url(os.environ[key]))
        if self.unresolved:
            kinds.append("unknown")
        return worst_target(kinds)

    def expand(self, value, extra_env=None):
        """$VAR / ${VAR} をコマンド内で設定された値 (と親の環境変数) で展開する。展開できなければそのまま。"""
        env = dict(os.environ)
        env.update(self.env)
        env.update(extra_env or {})
        return re.sub(r"\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?", lambda m: env.get(m.group(1), m.group(0)), value)

    def scripts(self):
        if self.pkg_scripts is None:
            self.pkg_scripts = {}
            for d in (self.cwd, self.project_dir):
                try:
                    with open(os.path.join(d, "package.json"), encoding="utf-8") as f:
                        self.pkg_scripts = json.load(f).get("scripts") or {}
                    break
                except (OSError, ValueError):
                    continue
        return self.pkg_scripts


# ---------------------------------------------------------------------------
# シェルの分解

HEREDOC = re.compile(r"(?<!<)<<(?!<)(-?)\s*(?:'([^'\n]+)'|\"([^\"\n]+)\"|\\?([A-Za-z_][A-Za-z0-9_]*))")


def extract_heredocs(command):
    """ヒアドキュメントの本文を取り除き、(本文を除いたコマンド, [本文, ...]) を返す。
    本文は stdin として渡るので、psql / python などに渡るものは呼び出し側で中身を見る。"""
    lines = command.split("\n")
    out, bodies = [], []
    i = 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        delims = [(m.group(1), m.group(2) or m.group(3) or m.group(4)) for m in HEREDOC.finditer(line)]
        i += 1
        for dash, delim in delims:
            body = []
            while i < len(lines):
                cur = lines[i].lstrip("\t") if dash else lines[i]
                i += 1
                if cur == delim:
                    break
                body.append(lines[i - 1])
            bodies.append("\n".join(body))
    return "\n".join(out), bodies


def split_unquoted_newlines(command):
    """クォートの外の改行を ; に置き換える (行の継続 \\ + 改行 はつなぐ)。"""
    res, quote, i = [], None, 0
    while i < len(command):
        ch = command[i]
        if quote:
            if ch == "\\" and quote == '"' and i + 1 < len(command):
                res.append(command[i:i + 2])
                i += 2
                continue
            if ch == quote:
                quote = None
            res.append(ch)
        elif ch == "\\" and i + 1 < len(command):
            if command[i + 1] == "\n":
                res.append(" ")
            else:
                res.append(command[i:i + 2])
            i += 2
            continue
        elif ch in "'\"":
            quote = ch
            res.append(ch)
        elif ch == "\n":
            res.append(" ; ")
        elif ch == "#" and (i == 0 or command[i - 1] in " \t;&|("):
            while i < len(command) and command[i] != "\n":
                i += 1
            continue
        else:
            res.append(ch)
        i += 1
    if quote:
        raise ValueError("unbalanced quote")
    return "".join(res)


def _close_paren(s, i):
    """s[i] == '(' に対応する ')' の位置。クォートとエスケープを飛ばす。無ければ -1。"""
    depth, quote, j = 0, None, i
    while j < len(s):
        ch = s[j]
        if quote == "'":
            if ch == "'":
                quote = None
        elif ch == "\\":
            j += 1
        elif quote == '"':
            if ch == '"':
                quote = None
        elif ch in "'\"":
            quote = ch
        elif ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return j
        j += 1
    return -1


def find_substitutions(s):
    """コマンド置換 $(...) / `...` の中身を返す。シングルクォートの中は文字列なので見ない
    (gh --body 'npx prisma migrate reset は禁止' のバッククォートは実行されない)。"""
    subs, quote, i = [], None, 0
    while i < len(s):
        ch = s[i]
        if quote == "'":
            if ch == "'":
                quote = None
            i += 1
            continue
        if ch == "\\":
            i += 2
            continue
        if ch == '"':
            quote = None if quote == '"' else '"'
        elif ch == "'":
            quote = "'"
        elif ch == "$" and s[i + 1:i + 2] == "(" and s[i + 2:i + 3] != "(":
            j = _close_paren(s, i + 1)
            if j < 0:
                raise ValueError("unbalanced $(")
            subs.append(s[i + 2:j])
            i = j + 1
            continue
        elif ch == "`":
            j = i + 1
            while j < len(s) and s[j] != "`":
                j += 2 if s[j] == "\\" else 1
            if j >= len(s):
                raise ValueError("unbalanced backtick")
            subs.append(s[i + 1:j])
            i = j + 1
            continue
        i += 1
    return subs


def split_commands(command):
    """([(tokens, heredoc_bodies)], [コマンド置換の中身]) を返す。演算子 (; && || | & 括弧) で区切る。"""
    stripped, bodies = extract_heredocs(command)
    flat = split_unquoted_newlines(stripped)
    subs = find_substitutions(flat)
    lex = shlex.shlex(flat, posix=True, punctuation_chars=";&|()<>")
    lex.whitespace_split = True
    lex.commenters = ""
    tokens = list(lex)
    commands, cur = [], []
    body_iter = iter(bodies)
    for tok in tokens:
        if tok and set(tok) <= set(";&|()"):
            if cur:
                commands.append(cur)
            cur = []
        else:
            cur.append(tok)
    if cur:
        commands.append(cur)
    # ヒアドキュメント本文は、<< を含むコマンドに順に割り当てる
    result = []
    for toks in commands:
        mine = []
        cleaned = []
        j = 0
        while j < len(toks):
            t = toks[j]
            if t in ("<<", "<<-") or (t.startswith("<<") and t != "<<<"):
                mine.append(next(body_iter, ""))
                if t in ("<<", "<<-"):
                    j += 1  # 区切り文字
            elif t == "<<<" and j + 1 < len(toks):
                mine.append(toks[j + 1])
                j += 1
            elif t in ("<", ">", ">>", "<>", ">&", "<&", "2>", "&>") and j + 1 < len(toks):
                if t == "<":
                    cleaned.append(("<", toks[j + 1]))
                j += 1
            elif t == "<" or t == ">":
                pass
            else:
                cleaned.append(t)
            j += 1
        result.append((cleaned, mine))
    return result, subs


# ---------------------------------------------------------------------------
# コード (スクリプト・SQL) の中身

# SQL として渡されたもの (psql -c / db execute) は大文字小文字を問わない。
# スクリプトの中は、SQL を大文字で書くこのリポジトリの慣習に合わせて大文字だけ拾う
# (JS の truncate() や「delete from the list」のようなコメントを拾わないため)
_SQL = {
    "drop_schema": r"\bDROP\s+(SCHEMA|DATABASE|OWNED)\b",
    "ddl": r"\b(DROP\s+(TABLE|INDEX|VIEW|FUNCTION|TYPE|POLICY|ROLE|EXTENSION)|TRUNCATE\s+(TABLE\s+)?[\"\w]|ALTER\s+(TABLE|TYPE|ROLE|SCHEMA)|CREATE\s+(TABLE|ROLE|SCHEMA))",
    "delete": r"\bDELETE\s+FROM\s+[\"\w.]+(?P<rest>[^;`]{0,400})",
    "update": r"\bUPDATE\s+[\"\w.]+\s+SET\b(?P<rest>[^;`]{0,400})",
}
SQL_CI = {k: re.compile(p, re.I) for k, p in _SQL.items()}
SQL_CS = {k: re.compile(p) for k, p in _SQL.items()}
SQL_DROP_SCHEMA = SQL_CI["drop_schema"]
SQL_DDL = SQL_CI["ddl"]
SQL_WRITE = re.compile(r"\b(insert\s+into|update\s+[\"\w.]+\s+set|delete\s+from|merge\s+into|grant|revoke|copy\s+[\"\w.]+\s+from)\b", re.I)

PRISMA_EMPTY_MANY = re.compile(r"\.(deleteMany|updateMany)\(\s*(\)|\{\s*\}\s*\)|\{\s*where\s*:\s*(\{\s*\}|undefined|null)\s*[,}])")
PRISMA_UPDATE_MANY_NO_WHERE = re.compile(r"\.updateMany\(\s*\{\s*data\s*:")
# コードの中から子プロセスで流す破壊的コマンド (execSync("npx prisma migrate reset") 等)
SPAWNED_DESTRUCTIVE = re.compile(r"\bprisma\s+(migrate\s+(dev|reset)|db\s+push\b[^\n'\"`]*--(force-reset|accept-data-loss))|--from-migrations\b", re.I)


def sql_findings(sql, pats=SQL_CI):
    """SQL 文字列 (または SQL を含むコード) の危険な操作を列挙する。"""
    found = []
    if pats["drop_schema"].search(sql):
        found.append("DROP SCHEMA / DATABASE / OWNED")
    m = pats["ddl"].search(sql)
    if m:
        found.append(re.sub(r"\s+", " ", m.group(0)).upper().rstrip('"'))
    for m in pats["delete"].finditer(sql):
        if not re.search(r"\bwhere\b", m.group("rest"), re.I):
            found.append("WHERE の無い DELETE")
            break
    for m in pats["update"].finditer(sql):
        if not re.search(r"\bwhere\b", m.group("rest"), re.I):
            found.append("WHERE の無い UPDATE")
            break
    return found


def code_findings(code, inline=False):
    """inline (-e / -c / ヒアドキュメントで渡したその場のコード) は SQL の大文字小文字を問わない。"""
    found = sql_findings(code, SQL_CI if inline else SQL_CS)
    for m in PRISMA_EMPTY_MANY.finditer(code):
        found.append(f"条件の無い {m.group(1)}")
    if PRISMA_UPDATE_MANY_NO_WHERE.search(code):
        found.append("where の無い updateMany")
    m = SPAWNED_DESTRUCTIVE.search(code)
    if m:
        snippet = re.sub(r"\s+", " ", m.group(0))[:40]
        found.append(f"DB を作り直すコマンド ({snippet})")
    return list(dict.fromkeys(found))


IMPORT_RE = re.compile(r"""(?:import\s[^'"]*?from\s*|import\s*\(?\s*|require\(\s*|export\s[^'"]*?from\s*)['"]([^'"]+)['"]""")
SCRIPT_EXTS = ("", ".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", "/index.ts", "/index.js")


def resolve_import(spec, base_dir, project_dir):
    if spec.startswith("@/"):
        base = os.path.join(project_dir, "src", spec[2:])
    elif spec.startswith("."):
        base = os.path.join(base_dir, spec)
    else:
        return None
    for ext in SCRIPT_EXTS:
        p = os.path.normpath(base + ext)
        if os.path.isfile(p):
            return p
    # import "./x.js" が実体 x.ts を指す (TS の慣習)
    root, ext = os.path.splitext(base)
    if ext in (".js", ".mjs", ".cjs"):
        for e in (".ts", ".tsx", ".mts", ".cts"):
            if os.path.isfile(root + e):
                return os.path.normpath(root + e)
    return None


def scan_code(inline_codes, paths, cwd, project_dir):
    """その場のコードとスクリプトファイル、そのリポジトリ内の import 先を読み、[(どこ, 指摘)] を返す。"""
    root = os.path.realpath(project_dir)
    findings, seen, queue = [], set(), []

    def follow(code, base_dir):
        for spec in IMPORT_RE.findall(code):
            q = resolve_import(spec, base_dir, project_dir)
            if q and os.path.realpath(q).startswith(root + os.sep) and "node_modules" not in q:
                queue.append(os.path.realpath(q))

    for code in inline_codes:
        findings += [("(インライン)", f) for f in code_findings(code, inline=True)]
        follow(code, cwd)
    for path in paths:
        if read_text(path) is None:
            findings.append((os.path.relpath(path, cwd) if os.path.isabs(path) else path,
                             "スクリプトが無い・読めない (実行前に作るものは中身を判定できない)"))
        else:
            queue.append(os.path.realpath(path))
    while queue and len(seen) < MAX_SCAN_FILES:
        p = queue.pop()
        if p in seen:
            continue
        seen.add(p)
        code = read_text(p)
        if code is None:
            continue
        for item in code_findings(code):
            findings.append((os.path.relpath(p, root), item))
        follow(code, os.path.dirname(p))
    return findings


# ---------------------------------------------------------------------------
# コマンドごとの判定

ENV_ASSIGN = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", re.S)
PASSTHROUGH = {"sudo", "time", "nice", "nohup", "exec", "command", "builtin", "caffeinate", "timeout", "xargs"}
SHELLS = {"sh", "bash", "zsh", "dash"}
INTERPRETERS = {"node", "tsx", "ts-node", "bun", "deno", "python", "python3", "ruby", "perl"}
PG_CLIENTS = {"psql", "pg_restore", "dropdb", "createdb", "pg_dump"}


def progname(token):
    """実行ファイル名。パスと @バージョン (npx prisma@6 / @scope/pkg@1) を落とす。"""
    name = os.path.basename(token)
    if "@" in name[1:]:
        name = name[0] + name[1:].split("@")[0]
    return name


class Verdict:
    def __init__(self):
        self.decision = None
        self.reasons = []

    def add(self, decision, reason):
        if RANK[decision] > RANK[self.decision]:
            self.decision = decision
        if decision and reason not in self.reasons:
            self.reasons.append(reason)


def by_target(target, prod, unknown, local=None):
    return {"prod": prod, "unknown": unknown, "local": local}[target]


def where(target):
    return {"prod": "本番", "unknown": "接続先を特定できない DB", "local": "ローカル"}[target]


def opt_value(args, *names):
    """--name value / --name=value の値をすべて返す。"""
    vals = []
    for i, a in enumerate(args):
        for n in names:
            if a == n and i + 1 < len(args):
                vals.append(args[i + 1])
            elif a.startswith(n + "="):
                vals.append(a[len(n) + 1:])
    return vals


def check_prisma(args, ctx, v, extra_env):
    words = [a for a in args if not a.startswith("-")]
    sub = words[:2]
    flags = set(a.split("=")[0] for a in args if a.startswith("-"))
    target = ctx.target(extra_env)
    if "--help" in flags or "-h" in flags:
        return
    # シャドウ DB は Prisma が DROP して作り直す。どのコマンドでもローカル以外は拒否
    for url in opt_value(args, "--shadow-database-url"):
        url = ctx.expand(url, extra_env)
        if classify_url(url) != "local":
            v.add("deny", f"--shadow-database-url に localhost 以外 ({url[:40]}) が渡されている。シャドウ DB は作り直されるので、自分で立てたローカル Postgres だけを指す")
    if sub[:1] == ["migrate"]:
        cmd = sub[1] if len(sub) > 1 else ""
        if cmd == "status":
            return
        if cmd == "diff":
            uses_shadow = flags & {"--from-migrations", "--to-migrations"}
            if uses_shadow and not opt_value(args, "--shadow-database-url"):
                v.add("deny", "--from-migrations / --to-migrations はシャドウ DB にマイグレーションを当て直す (DB を作り直す)。差分は --from-schema-datamodel / --to-schema-datamodel で取るか、ローカルの --shadow-database-url を渡す")
            return
        if cmd in ("dev", "reset"):
            v.add(by_target(target, "deny", "deny"),
                  f"prisma migrate {cmd} は DB を作り直す ({where(target)} 宛て)。.env は本番なので使わない (/db-migration スキルの手順を使う)")
            return
        if cmd == "deploy":
            v.add(by_target(target, "ask", "review"),
                  f"prisma migrate deploy は {where(target)} にマイグレーションを当てる。ユーザーの了承が要る")
            return
        if cmd == "resolve":
            v.add(by_target(target, "deny", "review"),
                  f"prisma migrate resolve は {where(target)} のマイグレーション履歴を書き換える")
            return
        v.add(by_target(target, "review", "review"), f"prisma migrate {cmd} ({where(target)} 宛て)")
        return
    if sub[:1] == ["db"]:
        cmd = sub[1] if len(sub) > 1 else ""
        if cmd == "pull":
            return
        if cmd == "push":
            if flags & {"--force-reset", "--accept-data-loss"}:
                v.add(by_target(target, "deny", "deny"),
                      f"prisma db push --force-reset / --accept-data-loss は DB のデータを消す ({where(target)} 宛て)")
            else:
                v.add(by_target(target, "deny", "review"),
                      f"prisma db push は {where(target)} のスキーマを書き換える。本番には /db-migration の migrate deploy で当てる")
            return
        if cmd == "execute":
            urls = [ctx.expand(u, extra_env) for u in opt_value(args, "--url")]
            t = ctx.target(extra_env, urls) if urls else target
            sql_bits = [read_text(os.path.join(ctx.cwd, f)) or "" for f in opt_value(args, "--file")]
            if any(SQL_DROP_SCHEMA.search(s) for s in sql_bits) and t != "local":
                v.add("deny", "DROP SCHEMA / DATABASE を流そうとしている")
            v.add(by_target(t, "deny", "review"),
                  f"prisma db execute は {where(t)} に任意の SQL を流す。本番の変更は /db-migration の migrate deploy で行う")
            return
        if cmd == "seed":
            v.add(by_target(target, "deny", "review"), f"prisma db seed は {where(target)} を書き換える")
            return
        v.add(by_target(target, "review", "review"), f"prisma db {cmd} ({where(target)} 宛て)")
        return
    # generate / format / validate / studio / version などは DB を書き換えない


def check_pg_client(prog, args, ctx, v, extra_env, stdin_bodies):
    args = [ctx.expand(a, extra_env) for a in args]  # psql "$DATABASE_URL" (source .env の後など)
    urls = [a for a in args if re.match(r"^postgres(ql)?://", a)]
    urls += [u for u in opt_value(args, "-d", "--dbname") if "://" in u]
    hosts = opt_value(args, "-h", "--host")
    if urls:
        target = ctx.target(extra_env, urls)
    elif hosts:
        target = worst_target(classify_url(f"postgres://{h}") for h in hosts)
    else:
        target = "unknown"  # PGHOST 等の環境変数・既定ソケットは解決しない
    if target == "local":
        return
    if prog == "pg_dump":
        return
    if prog in ("dropdb",) or (prog == "pg_restore" and ("--clean" in args or "-c" in args)):
        v.add("deny", f"{prog} は {where(target)} の DB を消す")
        return
    if prog in ("createdb", "pg_restore"):
        v.add(by_target(target, "deny", "review"), f"{prog} は {where(target)} に書き込む")
        return
    sql = list(opt_value(args, "-c", "--command")) + list(stdin_bodies)
    for f in opt_value(args, "-f", "--file"):
        text = read_text(os.path.join(ctx.cwd, f))
        sql.append("-- unreadable" if text is None else text)
    if not sql:
        v.add("review", f"psql を対話的に {where(target)} へつなぐ (流す SQL を判定できない)")
        return
    text = "\n".join(sql)
    if SQL_DROP_SCHEMA.search(text):
        v.add("deny", f"DROP SCHEMA / DATABASE を {where(target)} に流そうとしている")
    elif SQL_DDL.search(text) or SQL_WRITE.search(text) or "-- unreadable" in sql:
        v.add(by_target(target, "deny", "review"),
              f"psql で {where(target)} に書き込む SQL を流そうとしている。本番の変更は /db-migration の migrate deploy で行う")


def check_interpreter(prog, args, ctx, v, extra_env, stdin_bodies):
    """tsx / node などで流すコードを読み、一括削除・DDL があれば接続先しだいで review にする。"""
    codes, files = [], []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "-m" and prog.startswith("python"):
            return  # python -m <module> (unittest 等)。モジュールの中身は追わない
        if a in ("--version", "-v", "-V", "--help", "-h", "--test"):
            return
        if a in ("-e", "--eval", "-p", "--print", "-c") and i + 1 < len(args):
            codes.append(args[i + 1])
            i += 2
            continue
        if a.startswith("-") and a != "-":
            if a in ("-r", "--require", "--import", "--loader", "--env-file", "--tsconfig") and i + 1 < len(args):
                if a == "--env-file":
                    ctx_env = read_env_file(os.path.join(ctx.cwd, args[i + 1]))
                    if ctx_env is None:
                        ctx.unresolved = True
                    else:
                        extra_env.update(ctx_env)
                i += 2
                continue
            if a.startswith("--env-file="):
                ctx_env = read_env_file(os.path.join(ctx.cwd, a.split("=", 1)[1]))
                if ctx_env is None:
                    ctx.unresolved = True
                else:
                    extra_env.update(ctx_env)
            i += 1
            continue
        if a in ("watch", "run") and prog in ("tsx", "bun", "deno") and not files:
            i += 1  # tsx watch x.ts / bun run x.ts
            continue
        files.append(a)  # 最初の位置引数がスクリプト。以降はスクリプトの引数
        break
    if files and files[0] == "-":
        files = []
    codes += list(stdin_bodies) if not files else []
    if files and os.path.normpath(os.path.join(ctx.cwd, files[0])) == os.path.join(ctx.project_dir, "prisma", "seed.ts"):
        target = ctx.target(extra_env)
        v.add(by_target(target, "deny", "review"), f"prisma/seed.ts はデモデータを {where(target)} に書き込む")
        return
    paths = [f if os.path.isabs(f) else os.path.join(ctx.cwd, os.path.expanduser(f)) for f in files[:1]]
    findings = scan_code(codes, paths, ctx.cwd, ctx.project_dir)
    if not codes and not paths:
        # パイプ (echo ... | npx tsx) や対話。流れるコードを判定できない
        findings.append(("(標準入力)", "流すコードを判定できない"))
    if not findings:
        return
    target = ctx.target(extra_env)
    if target == "local":
        return
    detail = "、".join(f"{p}: {f}" for p, f in findings[:4])
    v.add("review", f"{prog} で流すコードに一括で消す・書き換える操作がある ({detail})。接続先は {where(target)}")


def check_command(tokens, bodies, ctx, v, depth):
    if depth > MAX_DEPTH:
        v.add("review", "コマンドの入れ子が深すぎて判定できない")
        return
    stdin_files = [t[1] for t in tokens if isinstance(t, tuple)]
    toks = [t for t in tokens if not isinstance(t, tuple)]
    stdin = list(bodies)
    for f in stdin_files:
        text = read_text(os.path.join(ctx.cwd, f))
        if text is not None:
            stdin.append(text)

    extra_env = {}
    i = 0
    while i < len(toks) and ENV_ASSIGN.match(toks[i]):
        k, val = ENV_ASSIGN.match(toks[i]).groups()
        extra_env[k] = val
        i += 1
    args = toks[i:]
    if not args:
        ctx.env.update(extra_env)  # 単独の代入はシェル変数として以降に効く
        return

    # ラッパーを剥がす
    while args:
        if args[0] == "--":
            args = args[1:]
            continue
        prog = progname(args[0])
        if prog in PASSTHROUGH:
            args = args[1:]
            while args and args[0].startswith("-"):
                args = args[1:]
            if prog == "timeout" and args:
                args = args[1:]
            continue
        if prog == "env":
            args = args[1:]
            while args and (args[0].startswith("-") or ENV_ASSIGN.match(args[0])):
                m = ENV_ASSIGN.match(args[0])
                if m:
                    extra_env[m.group(1)] = m.group(2)
                args = args[1:]
            continue
        if prog in ("npx", "bunx", "pnpx"):
            args = args[1:]
            while args and args[0].startswith("-") and args[0] != "--":
                if args[0] in ("-c", "--call") and len(args) > 1:
                    check_string(args[1], ctx.copy(), v, depth + 1)
                    return
                args = args[2:] if args[0] in ("-p", "--package") else args[1:]
            continue
        if prog in ("dotenv", "dotenvx", "dotenv-cli"):
            rest = args[1:]
            files, j = [], 0
            while j < len(rest) and rest[j] != "--":
                if rest[j] in ("-e", "-f") and j + 1 < len(rest):
                    files.append(rest[j + 1])
                    j += 2
                    continue
                if rest[j] == "run":
                    j += 1
                    continue
                if not rest[j].startswith("-"):
                    break
                j += 1
            for f in files or [".env"]:
                e = read_env_file(os.path.join(ctx.cwd, f))
                if e is None:
                    ctx.unresolved = True
                else:
                    extra_env.update(e)
            args = rest[j + 1:] if j < len(rest) and rest[j] == "--" else rest[j:]
            continue
        if prog in ("pnpm", "npm", "yarn", "bun"):
            rest = args[1:]
            while rest and rest[0].startswith("-"):
                rest = rest[2:] if rest[0] in ("-C", "--dir", "--filter", "-F") else rest[1:]
            if not rest:
                return
            if rest[0] in ("exec", "dlx", "x"):
                args = rest[1:]
                while args and args[0].startswith("-") and args[0] != "--":
                    if args[0] in ("-c", "--call") and len(args) > 1:
                        check_string(args[1], ctx.copy(), v, depth + 1)
                        return
                    args = args[2:] if args[0] in ("-p", "--package") else args[1:]
                continue
            if rest[0] in ("run", "run-script"):
                rest = rest[1:]
            if not rest:
                return
            script = ctx.scripts().get(rest[0])
            if script is None:
                if prog in ("pnpm", "yarn", "bun"):
                    args = rest  # pnpm prisma ... は node_modules/.bin を直接実行する
                    continue
                return
            joined = script + "".join(" " + shlex.quote(a) for a in rest[1:] if a != "--")
            sub = ctx.copy()
            sub.env.update(extra_env)
            check_string(joined, sub, v, depth + 1)
            return
        break
    if not args:
        return
    prog = progname(args[0])
    rest = args[1:]

    if prog in ("source", "."):
        if rest:
            e = read_env_file(os.path.expanduser(rest[0]) if rest[0].startswith("~") else os.path.join(ctx.cwd, rest[0]))
            if e is None:
                ctx.unresolved = True
            else:
                ctx.env.update(e)
        return
    if prog == "export":
        for a in rest:
            m = ENV_ASSIGN.match(a)
            if m:
                ctx.env[m.group(1)] = m.group(2)
        return
    if prog == "cd":
        if rest and not rest[0].startswith("-"):
            ctx.cwd = os.path.normpath(os.path.join(ctx.cwd, os.path.expanduser(rest[0])))
        return
    if prog in SHELLS:
        flags, j = [], 0
        while j < len(rest) and rest[j].startswith("-") and rest[j] != "--":
            flags.append(rest[j])
            j += 1
        operands = rest[j + 1:] if j < len(rest) and rest[j] == "--" else rest[j:]
        if any(not f.startswith("--") and "c" in f[1:] for f in flags):  # -c / -lc / -ec
            if operands:
                check_string(operands[0], ctx.copy(), v, depth + 1)
        elif operands:
            text = read_text(os.path.join(ctx.cwd, os.path.expanduser(operands[0])))
            if text is not None:
                check_string(text, ctx.copy(), v, depth + 1)
        else:
            for b in stdin:
                check_string(b, ctx.copy(), v, depth + 1)
        return
    if prog == "eval":
        check_string(" ".join(rest), ctx.copy(), v, depth + 1)
        return
    if prog == "prisma":
        check_prisma(rest, ctx, v, extra_env)
        return
    if prog in PG_CLIENTS:
        check_pg_client(prog, rest, ctx, v, extra_env, stdin)
        return
    if prog in INTERPRETERS:
        check_interpreter(prog, rest, ctx, v, extra_env, stdin)
        return
    if prog == "supabase" and rest[:1] == ["db"]:
        cmd = rest[1] if len(rest) > 1 else ""
        remote = "--linked" in rest or any(classify_url(u) != "local" for u in opt_value(rest, "--db-url"))
        if cmd in ("reset", "push") and remote:
            v.add("deny" if cmd == "reset" else "review", f"supabase db {cmd} をリモートの DB に向けている")
        return
    # それ以外のコマンド (gh / git / echo / cat …) の引数は DB に効かないので見ない


def check_string(command, ctx, v, depth=0):
    try:
        commands, subs = split_commands(command)
    except ValueError:
        legacy(command, v)
        return
    for inner in subs:
        check_string(inner, ctx.copy(), v, depth + 1)
    for tokens, bodies in commands:
        check_command(tokens, bodies, ctx, v, depth)


# 構文を解釈できないときの保険 (#249 の文字列判定)。拒否ではなく review に倒す
LEGACY = [
    r"\bprisma\b[^\n;&|]*\bmigrate\s+(dev|reset|deploy|resolve)\b",
    r"--from-migrations\b",
    r"\bprisma\b[^\n;&|]*\bdb\s+(push|execute)\b",
    r"\bdrop\s+(schema|database|table)\b",
    r"\btruncate\b",
    r"\bdb:(migrate|push|seed)\b",
    r"--shadow-database-url\b",
]


def legacy(command, v):
    low = command.lower()
    for pattern in LEGACY:
        if re.search(pattern, low):
            v.add("review", "コマンドの構文を解釈できず、DB を書き換えうる語を含む")
            return


def decide(command, cwd=None, project_dir=None):
    project_dir = project_dir or os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd()
    ctx = Ctx(cwd or os.getcwd(), project_dir)
    v = Verdict()
    check_string(command, ctx, v)
    if not v.decision:
        return None, None
    if v.decision == "review" and REVIEWED_RE.search(command):
        return None, None
    return v.decision, " / ".join(v.reasons)


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0
    if data.get("tool_name") != "Bash":
        return 0
    command = (data.get("tool_input") or {}).get("command") or ""
    try:
        decision, reason = decide(command, cwd=data.get("cwd"))
    except Exception as e:  # フック自身の不具合で素通しにしない
        decision, reason = "review", f"フックの判定中にエラー ({type(e).__name__}: {e})"
        if REVIEWED_RE.search(command):
            decision = None
    if decision == "review":
        decision, reason = "deny", f"{reason}。{REVIEW_HOWTO}"
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
