import { describe, expect, it } from "vitest";

import { ARTICLE_DATE_MODE_LABELS } from "@/lib/utils";

import {
  BODY_MAX_LENGTH,
  diffArticleEdit,
  normalizeBody,
  normalizeTags,
  parseArticleEditForm,
  toArticleEditFormValues,
  toArticleEditValues,
  toDateInputValue,
  type ArticleEditField,
  type ArticleEditForm,
  type ArticleEditValues,
} from "./edit";
import { parseArticle, toArticleColumns } from "./frontmatter";

/** フォームの生の値。指定しなかった欄は空 */
const form = (over: Partial<ArticleEditForm> = {}): ArticleEditForm => ({
  title: "癖",
  type: "attribute",
  tags: [],
  body: "本文",
  date: "",
  dateDisplay: "",
  dateMode: "",
  publishedAt: "",
  articleUpdatedAt: "",
  draft: false,
  unlisted: false,
  ongoing: false,
  ...over,
});

const utc = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe("normalizeBody", () => {
  it("CRLF を LF にし、先頭の空行を落とす (parseArticle と同じ)", () => {
    expect(normalizeBody("\r\n\r\n# 見出し\r\n本文\r\n")).toBe("# 見出し\n本文\n");
  });

  it("末尾の改行は触らない (実ファイルの流儀が揃っていない)", () => {
    expect(normalizeBody("a")).toBe("a");
    expect(normalizeBody("a\n")).toBe("a\n");
    expect(normalizeBody("a\n\n")).toBe("a\n\n");
  });

  it("取り込み (parseArticle) と同じ本文になる", () => {
    const raw = "---\ntitle: t\nshort_id: x\n---\n\n\n本文\n";
    expect(normalizeBody("\n\n本文\n")).toBe(parseArticle(raw).body);
  });
});

describe("normalizeTags", () => {
  it("trim して空と重複を落とし、順序は保つ", () => {
    expect(normalizeTags([" 家族 ", "", "食レポ", "家族", "  "])).toEqual(["家族", "食レポ"]);
  });
});

describe("parseArticleEditForm", () => {
  it("日付は date-only を UTC 深夜として保存する (取り込みと同じ)", () => {
    const r = parseArticleEditForm(form({ date: "2026-01-08", publishedAt: "2025-12-31" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.values.date).toEqual(utc("2026-01-08"));
    expect(r.values.publishedAt).toEqual(utc("2025-12-31"));
    expect(r.values.articleUpdatedAt).toBeNull();
  });

  it("空欄は null / false / [] になる", () => {
    const r = parseArticleEditForm(form({ type: "", dateDisplay: "  ", dateMode: "" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.values.type).toBeNull();
    expect(r.values.dateDisplay).toBeNull();
    expect(r.values.dateMode).toBeNull();
    expect(r.values.tags).toEqual([]);
    expect(r.values.draft).toBe(false);
  });

  it("タイトルは空でもよい (実記事に空タイトルの下書きがある。取り込みと同じ扱い)", () => {
    const r = parseArticleEditForm(form({ title: "  " }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.values.title).toBe("");
  });

  it("本文が上限を超えたらエラー (上限ちょうどは通る)", () => {
    expect(parseArticleEditForm(form({ body: "あ".repeat(BODY_MAX_LENGTH) })).ok).toBe(true);
    expect(parseArticleEditForm(form({ body: "あ".repeat(BODY_MAX_LENGTH + 1) }))).toMatchObject({
      ok: false,
      errors: { body: expect.any(String) },
    });
  });

  it("dateMode の許容値はラベル定義 (ARTICLE_DATE_MODE_LABELS) と同じ", () => {
    for (const mode of Object.keys(ARTICLE_DATE_MODE_LABELS)) {
      expect(parseArticleEditForm(form({ dateMode: mode })).ok).toBe(true);
    }
  });

  it("暦に無い日付・形式外の日付はエラー (黙って null にしない)", () => {
    expect(parseArticleEditForm(form({ date: "2026-02-30" }))).toMatchObject({
      ok: false,
      errors: { date: expect.any(String) },
    });
    expect(parseArticleEditForm(form({ articleUpdatedAt: "2026/1/8" }))).toMatchObject({
      ok: false,
      errors: { articleUpdatedAt: expect.any(String) },
    });
  });

  it("enum 外の type / dateMode はエラー", () => {
    expect(parseArticleEditForm(form({ type: "quiz" }))).toMatchObject({ ok: false, errors: { type: expect.any(String) } });
    expect(parseArticleEditForm(form({ dateMode: "week" }))).toMatchObject({
      ok: false,
      errors: { dateMode: expect.any(String) },
    });
    expect(parseArticleEditForm(form({ dateMode: "range" })).ok).toBe(true);
  });

  it("複数のエラーをまとめて返す", () => {
    const r = parseArticleEditForm(form({ type: "quiz", date: "x" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(["date", "type"]);
  });
});

describe("toArticleEditValues / toDateInputValue", () => {
  it("Article の行をフォームの値に落とし、日付は YYYY-MM-DD に戻る", () => {
    const values = toArticleEditValues({
      title: "癖",
      type: "attribute",
      tags: ["性格", 2025],
      body: "本文",
      date: utc("2026-01-08"),
      dateDisplay: null,
      dateMode: "range",
      publishedAt: null,
      articleUpdatedAt: utc("2026-02-01"),
      draft: true,
      unlisted: false,
      ongoing: false,
    });
    expect(values.tags).toEqual(["性格", "2025"]);
    expect(toDateInputValue(values.date)).toBe("2026-01-08");
    expect(toDateInputValue(values.publishedAt)).toBe("");
  });

  it("取り込んだ値をそのままフォームに通して保存しても差分が出ない (往復)", () => {
    const raw = [
      "---",
      "title: 癖",
      "short_id: abc1234",
      "type: attribute",
      "tags:",
      "  - 性格",
      "  - 家族",
      "date: 2026-01-08",
      "date_display: 2026年1月頃",
      "date_mode: range",
      "published_at: 2026-01-10",
      "updated_at: 2026-02-01",
      "draft: true",
      "---",
      "",
      "本文^[1]",
      "",
    ].join("\n");
    const cols = toArticleColumns(parseArticle(raw), "attribute/癖.md");
    // ArticleColumns は書き出し用に string も許す型なので、取り込みが書いた形 (Date | null) に絞る
    const prev = toArticleEditValues({
      ...cols,
      date: cols.date as Date | null,
      publishedAt: cols.publishedAt as Date | null,
      articleUpdatedAt: cols.articleUpdatedAt as Date | null,
      dateDisplay: cols.dateDisplay ?? null,
      dateMode: cols.dateMode ?? null,
      draft: cols.draft ?? false,
      unlisted: cols.unlisted ?? false,
      ongoing: cols.ongoing ?? false,
    });
    // フォームは初期値を文字列で持つ (toArticleEditFormValues)。それをそのまま送り返した状態
    const parsed = parseArticleEditForm(toArticleEditFormValues(prev));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.values.date).toEqual(utc("2026-01-08"));
    expect(parsed.values.dateMode).toBe("range");
    expect(diffArticleEdit(prev, parsed.values)).toEqual([]);
  });
});

describe("diffArticleEdit", () => {
  const base: ArticleEditValues = {
    title: "癖",
    type: "attribute",
    tags: ["性格"],
    body: "本文",
    date: utc("2026-01-08"),
    dateDisplay: null,
    dateMode: null,
    publishedAt: null,
    articleUpdatedAt: null,
    draft: false,
    unlisted: false,
    ongoing: false,
  };

  it("同じなら空", () => {
    expect(diffArticleEdit(base, { ...base, date: utc("2026-01-08") })).toEqual([]);
  });

  it("変わったフィールドだけ列挙する", () => {
    expect(
      diffArticleEdit(base, { ...base, body: "本文2", tags: ["性格", "家族"], draft: true, date: null }),
    ).toEqual(["tags", "body", "date", "draft"]);
  });

  it("タグの順序変更も差分 (公開サイトにこの並びで出る)", () => {
    expect(diffArticleEdit({ ...base, tags: ["a", "b"] }, { ...base, tags: ["b", "a"] })).toEqual(["tags"]);
  });

  // フィールドを 1 つずつ動かして、必ずそのフィールドだけが検出されることを見る
  // (「変わっていない」と誤ると編集が消えるので、全フィールドを網羅する)
  const fieldCases: [ArticleEditField, Partial<ArticleEditValues>][] = [
    ["title", { title: "別のタイトル" }],
    ["type", { type: "event" }],
    ["tags", { tags: ["性格", "家族"] }],
    ["body", { body: "本文\n" }],
    ["date", { date: null }],
    ["dateDisplay", { dateDisplay: "2026年1月頃" }],
    ["dateMode", { dateMode: "range" }],
    ["publishedAt", { publishedAt: utc("2026-01-10") }],
    ["articleUpdatedAt", { articleUpdatedAt: utc("2026-02-01") }],
    ["draft", { draft: true }],
    ["unlisted", { unlisted: true }],
    ["ongoing", { ongoing: true }],
  ];

  it.each(fieldCases)("%s が変わったらそれだけを検出する", (field, patch) => {
    expect(diffArticleEdit(base, { ...base, ...patch })).toEqual([field]);
  });

  it("フィールドの網羅: fieldCases が ArticleEditValues の全キーを持つ", () => {
    expect(fieldCases.map(([f]) => f).sort()).toEqual(Object.keys(base).sort());
  });
});
