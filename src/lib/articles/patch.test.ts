import { describe, expect, it } from "vitest";

import { diffArticleEdit, parseArticleEditForm, type ArticleEditValues } from "./edit";
import {
  ArticleApplyRequestSchema,
  ArticleEditPatchSchema,
  ArticleUpdateRequestSchema,
  hasPatchFields,
  mergeArticleEditPatch,
  parseUpdatedAt,
} from "./patch";

const utc = (s: string) => new Date(`${s}T00:00:00.000Z`);

const current: ArticleEditValues = {
  title: "癖",
  type: "attribute",
  tags: ["仕草", "口癖"],
  body: "本文^[1]",
  date: utc("2025-03-01"),
  dateDisplay: "2025年春",
  dateMode: "range",
  publishedAt: utc("2025-03-02"),
  articleUpdatedAt: utc("2025-03-03"),
  draft: false,
  unlisted: true,
  ongoing: false,
};

/** patch → merge → parse を通した値。API の PATCH と同じ経路 */
const apply = (patch: unknown) => {
  const parsed = ArticleEditPatchSchema.parse(patch);
  const form = mergeArticleEditPatch(current, parsed);
  const result = parseArticleEditForm(form);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.values;
};

describe("ArticleEditPatchSchema", () => {
  it("未知のキーは除去する (拒否しない)", () => {
    const parsed = ArticleEditPatchSchema.parse({ body: "x", id: "evil", path: "a.md" });
    expect(parsed).toEqual({ body: "x" });
  });

  it("日付は YYYY-MM-DD / 空 / null だけ", () => {
    expect(ArticleEditPatchSchema.safeParse({ date: "2025-03-01" }).success).toBe(true);
    expect(ArticleEditPatchSchema.safeParse({ date: "" }).success).toBe(true);
    expect(ArticleEditPatchSchema.safeParse({ date: null }).success).toBe(true);
    expect(ArticleEditPatchSchema.safeParse({ date: "2025/03/01" }).success).toBe(false);
    expect(ArticleEditPatchSchema.safeParse({ date: "2025-03-01T00:00:00Z" }).success).toBe(false);
  });

  it("type は enum、tags は文字列配列", () => {
    expect(ArticleEditPatchSchema.safeParse({ type: "quote" }).success).toBe(true);
    expect(ArticleEditPatchSchema.safeParse({ type: "poem" }).success).toBe(false);
    expect(ArticleEditPatchSchema.safeParse({ tags: "a" }).success).toBe(false);
  });

  it("dateMode はラベル定義の値だけ (スキーマの段階で弾く)", () => {
    expect(ArticleEditPatchSchema.safeParse({ dateMode: "range" }).success).toBe(true);
    expect(ArticleEditPatchSchema.safeParse({ dateMode: null }).success).toBe(true);
    expect(ArticleEditPatchSchema.safeParse({ dateMode: "weekly" }).success).toBe(false);
  });

  it("null で消せるのは type / 日付 / dateDisplay / dateMode だけ。title / body / tags / 真偽値は拒否", () => {
    for (const key of ["type", "date", "dateDisplay", "dateMode", "publishedAt", "articleUpdatedAt"]) {
      expect(ArticleEditPatchSchema.safeParse({ [key]: null }).success, key).toBe(true);
    }
    for (const key of ["title", "body", "tags", "draft", "unlisted", "ongoing"]) {
      expect(ArticleEditPatchSchema.safeParse({ [key]: null }).success, key).toBe(false);
    }
  });

  it("REST の body は updatedAt が必須で、日時として解釈できる文字列だけ", () => {
    expect(ArticleUpdateRequestSchema.safeParse({ body: "x" }).success).toBe(false);
    expect(ArticleUpdateRequestSchema.safeParse({ body: "x", updatedAt: "2026-09-16T00:00:00.000Z" }).success).toBe(true);
    expect(ArticleUpdateRequestSchema.safeParse({ body: "x", updatedAt: "yesterday" }).success).toBe(false);
    expect(ArticleUpdateRequestSchema.safeParse({ body: "x", updatedAt: "" }).success).toBe(false);
    expect(ArticleApplyRequestSchema.safeParse({}).success).toBe(false);
    expect(ArticleApplyRequestSchema.safeParse({ updatedAt: "2026-09-16T00:00:00.000Z" }).success).toBe(true);
  });
});

describe("parseUpdatedAt", () => {
  it("ISO 8601 を Date に、それ以外は null", () => {
    expect(parseUpdatedAt("2026-09-16T01:02:03.456Z")?.toISOString()).toBe("2026-09-16T01:02:03.456Z");
    expect(parseUpdatedAt("nope")).toBeNull();
    expect(parseUpdatedAt("")).toBeNull();
    expect(parseUpdatedAt(undefined)).toBeNull();
    expect(parseUpdatedAt(123)).toBeNull();
  });
});

describe("hasPatchFields", () => {
  it("空の PATCH を見分ける", () => {
    expect(hasPatchFields({})).toBe(false);
    expect(hasPatchFields({ body: "x" })).toBe(true);
    expect(hasPatchFields({ type: null })).toBe(true);
  });
});

describe("mergeArticleEditPatch", () => {
  it("省略した項目は現在値のまま = 変更なし", () => {
    const values = apply({});
    expect(diffArticleEdit(current, values)).toEqual([]);
  });

  it("body だけ渡すと body だけ変わる", () => {
    const values = apply({ body: "新しい本文^[1]^[2]" });
    expect(diffArticleEdit(current, values)).toEqual(["body"]);
    expect(values.body).toBe("新しい本文^[1]^[2]");
  });

  it("本文は UI と同じ正規化 (CRLF → LF、先頭空行の除去)", () => {
    const values = apply({ body: "\r\n\r\n一行目\r\n二行目" });
    expect(values.body).toBe("一行目\n二行目");
  });

  it("null で消せる (type / date / dateDisplay / dateMode)", () => {
    const values = apply({ type: null, date: null, dateDisplay: null, dateMode: null });
    expect(values.type).toBeNull();
    expect(values.date).toBeNull();
    expect(values.dateDisplay).toBeNull();
    expect(values.dateMode).toBeNull();
    expect(diffArticleEdit(current, values).sort()).toEqual(["date", "dateDisplay", "dateMode", "type"]);
  });

  it("空文字の日付も消す (フォームの空欄と同じ)", () => {
    const values = apply({ publishedAt: "" });
    expect(values.publishedAt).toBeNull();
    expect(diffArticleEdit(current, values)).toEqual(["publishedAt"]);
  });

  it("日付は UTC 深夜の date-only (取り込みと同じ規則)", () => {
    const values = apply({ articleUpdatedAt: "2026-09-16" });
    expect(values.articleUpdatedAt?.toISOString()).toBe("2026-09-16T00:00:00.000Z");
  });

  it("tags は全置換で、trim と重複除去が効く", () => {
    const values = apply({ tags: [" 仕草 ", "仕草", "新タグ"] });
    expect(values.tags).toEqual(["仕草", "新タグ"]);
    expect(diffArticleEdit(current, values)).toEqual(["tags"]);
  });

  it("tags: [] で全部消える (空配列は「触らない」ではない)", () => {
    const values = apply({ tags: [] });
    expect(values.tags).toEqual([]);
    expect(diffArticleEdit(current, values)).toEqual(["tags"]);
  });

  it("真偽値は個別に上書きできる", () => {
    const values = apply({ draft: true });
    expect(values.draft).toBe(true);
    expect(values.unlisted).toBe(true);
    expect(diffArticleEdit(current, values)).toEqual(["draft"]);
  });

  it("暦に無い日付は parseArticleEditForm が弾く", () => {
    const form = mergeArticleEditPatch(current, ArticleEditPatchSchema.parse({ date: "2026-02-30" }));
    const result = parseArticleEditForm(form);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.date).toBeDefined();
  });

  it("本文の上限は parseArticleEditForm が弾く", () => {
    const form = mergeArticleEditPatch(current, ArticleEditPatchSchema.parse({ body: "x".repeat(200_001) }));
    const result = parseArticleEditForm(form);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.body).toBeDefined();
  });
});
