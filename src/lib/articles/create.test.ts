import { describe, expect, it } from "vitest";

import { $Enums } from "@prisma/client";

import {
  ArticleCreateSchema,
  FILENAME_MAX_BYTES,
  SHORT_ID_LENGTH,
  deriveArticlePath,
  generateShortId,
  parseArticleCreateInput,
} from "./create";

const utc = (s: string) => new Date(`${s}T00:00:00.000Z`);
const TODAY = "2026-09-17";

describe("generateShortId", () => {
  it("7 桁 base62 (assign-slugs.ts と同じ字母)", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateShortId()).toMatch(new RegExp(`^[A-Za-z0-9]{${SHORT_ID_LENGTH}}$`));
    }
  });

  it("取り込みの short_id 検証 (/^[A-Za-z0-9_-]+$/) を通る", () => {
    for (let i = 0; i < 50; i++) expect(generateShortId()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("毎回違う (衝突は @unique で検出して再採番する前提)", () => {
    const ids = new Set(Array.from({ length: 100 }, generateShortId));
    expect(ids.size).toBe(100);
  });
});

describe("deriveArticlePath", () => {
  it("<type>/<title>.md", () => {
    expect(deriveArticlePath("attribute", "癖")).toEqual({ ok: true, path: "attribute/癖.md" });
    expect(deriveArticlePath("event", "2026年6月13日 リアルミーグリ（幕張メッセ）")).toEqual({
      ok: true,
      path: "event/2026年6月13日 リアルミーグリ（幕張メッセ）.md",
    });
  });

  it("ファイル名に使えない 9 文字は全角に (実データの Yes, me now？.md と同じ)", () => {
    expect(deriveArticlePath("quote", "Yes, me now?")).toEqual({ ok: true, path: "quote/Yes, me now？.md" });
    expect(deriveArticlePath("column", 'a/b\\c:d*e?f"g<h>i|j')).toEqual({
      ok: true,
      path: "column/a／b＼c：d＊e？f”g＜h＞i｜j.md",
    });
  });

  it("前後の空白と制御文字を落とす", () => {
    expect(deriveArticlePath("item", "  タオル\t\n ")).toEqual({ ok: true, path: "item/タオル.md" });
    expect(deriveArticlePath("item", "タ\u0000オ\u001fル\u007f")).toEqual({ ok: true, path: "item/タオル.md" });
  });

  it("NFC に正規化する (#88)", () => {
    const nfd = "好奇心がある".normalize("NFD");
    expect(nfd).not.toBe("好奇心がある");
    const r = deriveArticlePath("attribute", nfd);
    expect(r).toEqual({ ok: true, path: "attribute/好奇心がある.md" });
  });

  it("空 (置換・trim 後に空を含む) は不可", () => {
    expect(deriveArticlePath("attribute", "")).toMatchObject({ ok: false });
    expect(deriveArticlePath("attribute", "   ")).toMatchObject({ ok: false });
    expect(deriveArticlePath("attribute", "\u0000")).toMatchObject({ ok: false });
  });

  it(". / _ 始まりは Astro が無視するので不可 (trim 後で判定)", () => {
    expect(deriveArticlePath("attribute", ".hidden")).toMatchObject({ ok: false });
    expect(deriveArticlePath("attribute", "_draft")).toMatchObject({ ok: false });
    expect(deriveArticlePath("attribute", "  _draft")).toMatchObject({ ok: false });
    // 途中の . / _ は可 (実データ: 00_基本プロフィール.md)
    expect(deriveArticlePath("attribute", "00_基本プロフィール")).toEqual({
      ok: true,
      path: "attribute/00_基本プロフィール.md",
    });
  });

  it("readme を含むファイル名は公開サイトが除外するので不可 (大文字小文字を問わない)", () => {
    expect(deriveArticlePath("column", "README")).toMatchObject({ ok: false });
    expect(deriveArticlePath("column", "このReadMeについて")).toMatchObject({ ok: false });
  });

  it("ArticleType を増やしてもディレクトリが決まる (enum 全部を通す)", () => {
    for (const type of Object.values($Enums.ArticleType)) {
      expect(deriveArticlePath(type, "タイトル")).toEqual({ ok: true, path: `${type}/タイトル.md` });
    }
  });

  it("制御文字だけのタイトルは不可 (zod の trim().min(1) は通るが、ファイル名が空になる)", () => {
    expect(ArticleCreateSchema.safeParse({ title: "\u0001", type: "column" }).success).toBe(true);
    expect(deriveArticlePath("column", "\u0001")).toMatchObject({ ok: false });
  });

  it("255 バイト超のファイル名は不可 (.md 込み)", () => {
    // 日本語 1 文字 3 バイト。84 文字 = 252 + ".md" 3 = 255 (ちょうど可)、85 文字は不可
    expect(deriveArticlePath("quote", "あ".repeat(84))).toMatchObject({ ok: true });
    expect(deriveArticlePath("quote", "あ".repeat(85))).toMatchObject({ ok: false });
    expect(FILENAME_MAX_BYTES).toBe(255);
  });
});

describe("ArticleCreateSchema", () => {
  it("title と type は必須", () => {
    expect(ArticleCreateSchema.safeParse({}).success).toBe(false);
    expect(ArticleCreateSchema.safeParse({ title: "癖" }).success).toBe(false);
    expect(ArticleCreateSchema.safeParse({ type: "attribute" }).success).toBe(false);
    expect(ArticleCreateSchema.safeParse({ title: "癖", type: "attribute" }).success).toBe(true);
  });

  it("title は空・空白のみ・null を許さない (PATCH と違う)", () => {
    expect(ArticleCreateSchema.safeParse({ title: "", type: "attribute" }).success).toBe(false);
    expect(ArticleCreateSchema.safeParse({ title: "   ", type: "attribute" }).success).toBe(false);
    expect(ArticleCreateSchema.safeParse({ title: null, type: "attribute" }).success).toBe(false);
  });

  it("type は enum のみ。null は不可 (path のディレクトリになる)", () => {
    expect(ArticleCreateSchema.safeParse({ title: "癖", type: null }).success).toBe(false);
    expect(ArticleCreateSchema.safeParse({ title: "癖", type: "fact" }).success).toBe(false);
    expect(ArticleCreateSchema.safeParse({ title: "癖", type: "quiz" }).success).toBe(false);
  });

  it("残りは PATCH と同じ検証。未知キーは除去", () => {
    const r = ArticleCreateSchema.safeParse({
      title: "癖",
      type: "attribute",
      tags: ["仕草"],
      date: "2026/01/01",
    });
    expect(r.success).toBe(false);
    const ok = ArticleCreateSchema.safeParse({ title: "癖", type: "attribute", path: "x", shortId: "y" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data).toEqual({ title: "癖", type: "attribute" });
  });
});

describe("parseArticleCreateInput", () => {
  const parse = (raw: unknown) => {
    const input = ArticleCreateSchema.parse(raw);
    const parsed = parseArticleCreateInput(input, TODAY);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
    return parsed.values;
  };

  it("省略時の既定値: draft true / publishedAt・articleUpdatedAt は今日 (JST) / 他は空", () => {
    expect(parse({ title: "癖", type: "attribute" })).toEqual({
      title: "癖",
      type: "attribute",
      tags: [],
      body: "",
      date: null,
      dateDisplay: null,
      dateMode: null,
      publishedAt: utc(TODAY),
      articleUpdatedAt: utc(TODAY),
      draft: true,
      unlisted: false,
      ongoing: false,
    });
  });

  it("明示した値が既定値に勝つ。null / 空文字は空のまま (今日で埋めない)", () => {
    expect(
      parse({
        title: "癖",
        type: "attribute",
        draft: false,
        publishedAt: "2025-03-02",
        articleUpdatedAt: null,
        date: "",
      }),
    ).toMatchObject({ draft: false, publishedAt: utc("2025-03-02"), articleUpdatedAt: null, date: null });
    expect(parse({ title: "癖", type: "attribute", publishedAt: "" })).toMatchObject({ publishedAt: null });
  });

  it("PATCH と同じ正規化 (CRLF / 先頭空行 / タグの trim と重複)", () => {
    expect(parse({ title: " 癖 ", type: "attribute", body: "\r\n\r\n本文\r\n", tags: [" 仕草 ", "仕草", ""] })).toMatchObject({
      title: "癖",
      body: "本文\n",
      tags: ["仕草"],
    });
  });

  it("タイトルは全角置換しない (path だけ。docs/api.md の約束)", () => {
    expect(parse({ title: "Yes, me now?", type: "quote" }).title).toBe("Yes, me now?");
    expect(deriveArticlePath("quote", "Yes, me now?")).toEqual({ ok: true, path: "quote/Yes, me now？.md" });
  });

  it("タイトルは NFC にする (NFD のまま保存すると [[タイトル]] の完全一致から漏れる)", () => {
    const nfd = "好奇心がある".normalize("NFD");
    expect(parse({ title: nfd, type: "attribute" }).title).toBe("好奇心がある");
  });

  it("タイトルから制御文字を落とす (NUL は Postgres の text に入らず 500 になる)", () => {
    expect(parse({ title: "癖\u0000", type: "attribute" }).title).toBe("癖");
    expect(parse({ title: "癖\u0001あ\u007f", type: "attribute" }).title).toBe("癖あ");
  });

  it("PATCH と同じ検証 (暦に無い日付 / dateMode)", () => {
    const input = ArticleCreateSchema.parse({ title: "癖", type: "attribute", date: "2026-02-30" });
    const parsed = parseArticleCreateInput(input, TODAY);
    expect(parsed).toMatchObject({ ok: false, errors: { date: expect.any(String) } });
  });
});
