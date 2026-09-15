import { ArticleSourceStatus, ClearanceLevel } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  buildFrontmatter as buildFrontmatterFull,
  formatFrontmatterDate,
  parseArticle,
  parseFrontmatterDate,
  serializeArticle,
  splitFrontmatter,
  toArticleSourceRow,
  type ArticleFrontmatterInput,
  type ArticleSourceRow,
} from "./frontmatter";
import { resolveOffline, roundtrip } from "./roundtrip";

/** frontmatter 本体だけ見るテスト用。除外の内訳は「書き出し対象の絞り込み」で見る */
const buildFrontmatter = (input: ArticleFrontmatterInput) => buildFrontmatterFull(input).frontmatter;

/**
 * 記事の frontmatter は push 時に DB のカラムから組み立て直される。
 * ここで担保するのは **値レベルの往復**、すなわち
 *
 *   ファイル → parse → DB カラム相当 → buildFrontmatter → serialize → parse
 *
 * を通しても frontmatter の値が変わらないこと。バイト単位の一致は保証しない
 * (意図的な正規化は frontmatter.ts の INTENTIONAL_NORMALIZATIONS を参照)。
 */

describe("splitFrontmatter", () => {
  it("frontmatter と本文を分ける", () => {
    const { yaml, body } = splitFrontmatter("---\ntitle: x\n---\n\nhello\n");
    expect(yaml).toBe("title: x\n");
    expect(body).toBe("\nhello\n");
  });

  it("BOM 付きでも frontmatter を見つける", () => {
    // BOM を落とさないと short_id なしと判定され、記事が黙ってスキップされる
    const { yaml, body } = splitFrontmatter("﻿---\ntitle: x\n---\n\nhello\n");
    expect(yaml).toBe("title: x\n");
    expect(body).toBe("\nhello\n");
  });

  it("終端の末尾に空白があっても本文にスペース行を残さない", () => {
    const { body } = splitFrontmatter("---\ntitle: x\n--- \n\nhello\n");
    expect(body).toBe("\nhello\n");
  });

  it("---- (4 本以上) は終端デリミタとして扱わない", () => {
    // 3 文字ぶんしか除去しないと本文の先頭に - が残る
    const { yaml, body } = splitFrontmatter("---\ntitle: x\n----\n\nhello\n---\n");
    expect(yaml).toBe("title: x\n----\n\nhello\n");
    expect(body).toBe("");
  });

  it("frontmatter が無ければ全文が本文", () => {
    const { yaml, body } = splitFrontmatter("# 見出し\n\n本文\n");
    expect(yaml).toBe("");
    expect(body).toBe("# 見出し\n\n本文\n");
  });

  it("本文中の水平線を終端と誤認しない", () => {
    const { yaml } = splitFrontmatter("---\ntitle: x\n---\n\nA\n\n---\n\nB\n");
    expect(yaml).toBe("title: x\n");
  });
});

describe("parseArticle の source 正規化", () => {
  it("lable 誤記を label として読む", () => {
    const { sources } = parseArticle("---\nsource:\n  - lable: お披露目での自己紹介\n---\n\nx\n");
    expect(sources).toEqual([{ id: undefined, url: undefined, label: "お披露目での自己紹介", date: undefined, ref: undefined }]);
  });

  it("素の文字列の出典を label として読む", () => {
    // Astro 側のスキーマは z.union([z.string(), z.object({…})]) で文字列も許している
    const { sources } = parseArticle("---\nsource:\n  - 坂井新奈トーク 2025.12.1\n---\n\nx\n");
    expect(sources).toEqual([{ label: "坂井新奈トーク 2025.12.1" }]);
  });

  it("中身が空のエントリは捨てる", () => {
    const { sources } = parseArticle("---\nsource:\n  - id:\n    url:\n    label:\n---\n\nx\n");
    expect(sources).toEqual([]);
  });

  it("id が 0 や文字列でも落とさない", () => {
    // `Number(v) || undefined` だと 0 / "0" が undefined になる
    const { sources } = parseArticle('---\nsource:\n  - id: 0\n    label: a\n  - id: "2"\n    label: b\n---\n\nx\n');
    expect(sources.map((s) => s.id)).toEqual([0, 2]);
  });

  it("source が配列でなければ空", () => {
    const { sources } = parseArticle("---\nsource:\n  id: 1\n  label: x\n---\n\nx\n");
    expect(sources).toEqual([]);
  });
});

describe("parseFrontmatterDate", () => {
  it("日付のみの表記を UTC 深夜として読む", () => {
    expect(parseFrontmatterDate("2026-03-14")?.toISOString()).toBe("2026-03-14T00:00:00.000Z");
  });

  it("ゼロ埋めが無くても UTC 深夜として読む", () => {
    // `new Date("2026-01-8")` はローカルタイム解釈になり、JST では UTC で前日にズレる
    // (event/お母さんと夢の国に.md に実在した)
    expect(parseFrontmatterDate("2026-01-8")?.toISOString()).toBe("2026-01-08T00:00:00.000Z");
    expect(parseFrontmatterDate("2026-1-8")?.toISOString()).toBe("2026-01-08T00:00:00.000Z");
  });

  it("時刻成分つきはそのまま読む", () => {
    expect(parseFrontmatterDate("2026-07-06T18:46:37.874Z")?.toISOString()).toBe("2026-07-06T18:46:37.874Z");
  });

  it("null / 空 / 不正値は null", () => {
    expect(parseFrontmatterDate(null)).toBeNull();
    expect(parseFrontmatterDate("")).toBeNull();
    expect(parseFrontmatterDate("これは日付ではない")).toBeNull();
  });

  it("暦日として存在しない日付は null", () => {
    // new Date("2026-02-30") は Invalid にならず 3/2 に繰り上がる。
    // 素通しすると打ち間違いが別の日付として DB に入り、push で原本を書き換える
    expect(parseFrontmatterDate("2026-02-30")).toBeNull();
    expect(parseFrontmatterDate("2026-06-31")).toBeNull();
    expect(parseFrontmatterDate("2026-13-01")).toBeNull();
    expect(parseFrontmatterDate("2026-00-15")).toBeNull();
    expect(parseFrontmatterDate("2026-1-99")).toBeNull();
  });

  it("Invalid Date を渡しても漏らさない", () => {
    // 漏らすと formatFrontmatterDate が RangeError を投げて push が落ちる
    expect(parseFrontmatterDate(new Date("nope"))).toBeNull();
    expect(formatFrontmatterDate("2026-13-01")).toBeUndefined();
    expect(formatFrontmatterDate(new Date("nope"))).toBeUndefined();
  });

  it("渡された Date を複製して返す", () => {
    const input = new Date("2026-03-14T00:00:00.000Z");
    expect(parseFrontmatterDate(input)).not.toBe(input);
    expect(parseFrontmatterDate(input)?.toISOString()).toBe(input.toISOString());
  });
});

describe("formatFrontmatterDate", () => {
  it("UTC 深夜ちょうどは日付だけに戻す", () => {
    expect(formatFrontmatterDate(new Date("2026-03-14T00:00:00.000Z"))).toBe("2026-03-14");
  });

  it("時刻成分があれば ISO のまま返す", () => {
    expect(formatFrontmatterDate(new Date("2026-07-06T18:46:37.874Z"))).toBe("2026-07-06T18:46:37.874Z");
  });

  it("null / 空 / 不正値は undefined", () => {
    expect(formatFrontmatterDate(null)).toBeUndefined();
    expect(formatFrontmatterDate("")).toBeUndefined();
    expect(formatFrontmatterDate("これは日付ではない")).toBeUndefined();
  });
});

describe("serializeArticle", () => {
  it("# で始まる値を quote する", () => {
    // quote しないと YAML コメント扱いになり、読み戻したとき null になる
    const out = serializeArticle({ label: "#5 勇気で踏み出せ!番外編" }, "本文\n");
    expect(out).toContain('label: "#5 勇気で踏み出せ!番外編"');
    expect(parseArticle(out).frontmatter.label).toBe("#5 勇気で踏み出せ!番外編");
  });

  it("空白の直後に # がある値を quote する", () => {
    const label = "日向坂で会いましょう #366「日向坂46最新相関図！」";
    const out = serializeArticle({ label }, "本文\n");
    expect(parseArticle(out).frontmatter.label).toBe(label);
  });

  it("undefined のキーは書き出さない", () => {
    const out = serializeArticle({ title: "x", type: undefined }, "本文\n");
    expect(out).not.toContain("type");
  });
});

describe("buildFrontmatter", () => {
  const base: ArticleFrontmatterInput = { shortId: "abc1234" };

  it("KNOWN_FRONTMATTER_KEYS の順に並べ、extra を後ろに置く", () => {
    const fm = buildFrontmatter({
      ...base,
      title: "タイトル",
      type: "attribute",
      tags: ["タグ"],
      publishedAt: new Date("2026-03-14T00:00:00.000Z"),
      frontmatterExtra: { featured: true },
    });
    expect(Object.keys(fm)).toEqual(["title", "short_id", "type", "tags", "published_at", "featured"]);
  });

  it("slug は専用カラムから書き出す (extra に逃がさない)", () => {
    // KNOWN キーに入れる前は Article.slug カラムと frontmatterExtra の
    // 二重管理になっていて、カラムを編集しても push に反映されなかった
    const fm = buildFrontmatter({ ...base, slug: "my-slug" });
    expect(fm.slug).toBe("my-slug");
    expect(Object.keys(fm)).toEqual(["short_id", "slug"]);
  });

  it("既定値と同じ boolean / 空配列はキーごと省く", () => {
    const fm = buildFrontmatter({ ...base, draft: false, unlisted: false, ongoing: false, tags: [], sources: [] });
    expect(Object.keys(fm)).toEqual(["short_id"]);
  });

  it("true の boolean は書き出す", () => {
    const fm = buildFrontmatter({ ...base, draft: true, unlisted: true, ongoing: true });
    expect(fm).toMatchObject({ draft: true, unlisted: true, ongoing: true });
  });

  it("source のキー順を id / url / label / date / ref に揃える", () => {
    const fm = buildFrontmatter({
      ...base,
      sources: resolveOffline([{ ref: "cuid1", date: "2025-12-28", label: "ラベル", url: "https://example.com", id: 1 }]),
    });
    expect(Object.keys((fm.source as Record<string, unknown>[])[0])).toEqual(["id", "url", "label", "date", "ref"]);
  });

  it("source は sortOrder 順に並べる (渡した順に依存しない)", () => {
    const rows = resolveOffline([{ id: 1, label: "a" }, { id: 2, label: "b" }]);
    const fm = buildFrontmatter({ ...base, sources: [rows[1], rows[0]] });
    expect((fm.source as { id: number }[]).map((s) => s.id)).toEqual([1, 2]);
  });

  it("frontmatterExtra が専用カラムと衝突してもカラム側を優先する", () => {
    const fm = buildFrontmatter({ ...base, title: "カラムの値", frontmatterExtra: { title: "extra の値" } });
    expect(fm.title).toBe("カラムの値");
  });

  it("lat / lng は 0 でも書き出す", () => {
    const fm = buildFrontmatter({ ...base, lat: 0, lng: 0 });
    expect(fm).toMatchObject({ lat: 0, lng: 0 });
  });
});

describe("書き出し対象の絞り込み (公開リポジトリに出るもの)", () => {
  const base: ArticleFrontmatterInput = { shortId: "abc1234" };
  const row = (over: Partial<ArticleSourceRow>): ArticleSourceRow => ({
    ...toArticleSourceRow({ id: 1, label: "ラベル" }, { assetId: "cuid1", status: ArticleSourceStatus.applied }, 0),
    ...over,
  });

  it("取り込みが作る行は public", () => {
    expect(row({}).classification).toBe(ClearanceLevel.public);
  });

  it("pending は載せず、件数だけ返す", () => {
    // akashic 側で紐づけただけの行。本文に反映されるまで frontmatter には出ない
    const built = buildFrontmatterFull({
      ...base,
      sources: [row({}), row({ status: ArticleSourceStatus.pending, sortOrder: 1, sourceNo: null })],
    });
    expect((built.frontmatter.source as unknown[]).length).toBe(1);
    expect(built.pending).toBe(1);
    expect(built.blocked).toEqual([]);
  });

  it("applied / unresolved なのに public でない行は載せず blocked で返す", () => {
    // 押した人の clearance で公開リポジトリに出る内容が変わる経路を塞ぐ。
    // 本文は ^[n] で参照しているので、黙って落とすと脚注が壊れた記事が公開される
    const internal = row({ classification: ClearanceLevel.internal, sortOrder: 1, sourceNo: 2 });
    const confidential = row({
      status: ArticleSourceStatus.unresolved,
      assetId: null,
      originalRef: "cuid-gone",
      classification: ClearanceLevel.confidential,
      sortOrder: 2,
      sourceNo: 3,
    });
    const built = buildFrontmatterFull({ ...base, sources: [row({}), internal, confidential] });
    expect((built.frontmatter.source as { id: number }[]).map((s) => s.id)).toEqual([1]);
    expect(built.pending).toBe(0);
    expect(built.blocked).toEqual([internal, confidential]);
  });

  it("pending は classification に依らず pending 扱い (blocked に混ぜない)", () => {
    const built = buildFrontmatterFull({
      ...base,
      sources: [row({ status: ArticleSourceStatus.pending, classification: ClearanceLevel.restricted })],
    });
    expect(built.frontmatter.source).toBeUndefined();
    expect(built.pending).toBe(1);
    expect(built.blocked).toEqual([]);
  });

  it("source が全部落ちたら source キーごと省く", () => {
    const built = buildFrontmatterFull({ ...base, sources: [row({ status: ArticleSourceStatus.pending })] });
    expect(Object.keys(built.frontmatter)).toEqual(["short_id"]);
  });
});

describe("ref の決め方 (assetId ?? originalRef)", () => {
  const base: ArticleFrontmatterInput = { shortId: "abc1234" };
  const first = (input: ArticleFrontmatterInput) =>
    (buildFrontmatterFull(input).frontmatter.source as Record<string, unknown>[])[0];

  it("applied は照合済みの assetId を ref に書く", () => {
    const rows = [toArticleSourceRow({ id: 1, label: "x", ref: "cuid-file" }, { assetId: "cuid-file", status: ArticleSourceStatus.applied }, 0)];
    expect(first({ ...base, sources: rows }).ref).toBe("cuid-file");
  });

  it("元ファイルに ref が無くても照合で applied になれば ref が生える", () => {
    // url / label で照合した 61 件。write-refs.ts がやっていた補完と同じで、
    // 初回 push で ref: が足される (合意済み: #74)
    const rows = [toArticleSourceRow({ id: 1, label: "x" }, { assetId: "cuid-matched", status: ArticleSourceStatus.applied }, 0)];
    const src = first({ ...base, sources: rows });
    expect(src.ref).toBe("cuid-matched");
    expect(rows[0].originalRef).toBeNull();
  });

  it("dangling (unresolved) は元ファイルの ref をそのまま書き戻す", () => {
    const rows = [toArticleSourceRow({ id: 1, label: "x", ref: "cuid-gone" }, { assetId: null, status: ArticleSourceStatus.unresolved }, 0)];
    expect(first({ ...base, sources: rows }).ref).toBe("cuid-gone");
  });

  it("applied でも originalRef を保持し、Asset が消えて assetId が null になっても ref が残る", () => {
    // onDelete: SetNull で assetId だけ落ちた状態。originalRef を applied で捨てていると
    // ここで ref が黙って消える
    const row = toArticleSourceRow({ id: 1, label: "x", ref: "cuid-file" }, { assetId: "cuid-file", status: ArticleSourceStatus.applied }, 0);
    expect(row.originalRef).toBe("cuid-file");
    expect(first({ ...base, sources: [{ ...row, assetId: null }] }).ref).toBe("cuid-file");
  });

  it("どちらも無ければ ref を書かない", () => {
    const rows = [toArticleSourceRow({ id: 1, label: "x" }, { assetId: null, status: ArticleSourceStatus.unresolved }, 0)];
    expect(first({ ...base, sources: rows })).not.toHaveProperty("ref");
  });
});

describe("値レベルの往復", () => {
  /** 往復させて、frontmatter の値と本文が変わらないことを見る */
  const expectStable = (raw: string) => {
    const once = roundtrip(raw);
    const twice = roundtrip(once);
    // 2 回目以降はバイト単位で安定する (= 編集していない記事に差分が出ない)
    expect(twice).toBe(once);
    return parseArticle(once);
  };

  it("代表的な記事が往復する", () => {
    const raw = [
      "---",
      "title: 2025年の漢字",
      "short_id: i81tjpQ",
      "type: attribute",
      "tags: [上村ひなの,2025年]",
      'published_at: "2026-03-14"',
      'updated_at: "2026-03-14"',
      "source:",
      "  - id: 1",
      "    label: 日向坂46の「ひ」(上村ひなの、坂井新奈、大野愛実)",
      "    date: 2025-12-28",
      "    ref: cmou6kv7r000bl804dkb9ea75",
      "---",
      "",
      "- 坂井新奈の2025年の漢字は「温」^[1]",
      "",
    ].join("\n");

    const { frontmatter, body } = expectStable(raw);
    expect(frontmatter).toEqual({
      title: "2025年の漢字",
      short_id: "i81tjpQ",
      type: "attribute",
      tags: ["上村ひなの", "2025年"],
      published_at: "2026-03-14",
      updated_at: "2026-03-14",
      source: [
        {
          id: 1,
          label: "日向坂46の「ひ」(上村ひなの、坂井新奈、大野愛実)",
          date: "2025-12-28",
          ref: "cmou6kv7r000bl804dkb9ea75",
        },
      ],
    });
    expect(body).toBe("- 坂井新奈の2025年の漢字は「温」^[1]\n");
  });

  it("# を含む label が往復しても壊れない", () => {
    const raw = [
      "---",
      "short_id: abc1234",
      "source:",
      '  - label: "#5 勇気で踏み出せ!番外編"',
      '  - label: "日向坂で会いましょう #366「最新相関図」"',
      "---",
      "",
      "本文",
      "",
    ].join("\n");
    const { frontmatter } = expectStable(raw);
    expect(frontmatter.source).toEqual([
      { label: "#5 勇気で踏み出せ!番外編" },
      { label: "日向坂で会いましょう #366「最新相関図」" },
    ]);
  });

  it("時刻成分つきの updated_at が往復する", () => {
    const raw = '---\nshort_id: abc1234\nupdated_at: "2026-07-06T18:46:37.874Z"\n---\n\n本文\n';
    const { frontmatter } = expectStable(raw);
    expect(frontmatter.updated_at).toBe("2026-07-06T18:46:37.874Z");
  });

  it("slug が往復する", () => {
    const raw = "---\nshort_id: abc1234\nslug: fukasawa-temple\n---\n\n本文\n";
    const { frontmatter, extra } = expectStable(raw);
    expect(frontmatter.slug).toBe("fukasawa-temple");
    // 専用カラムに入るので extra には残らない
    expect(extra.slug).toBeUndefined();
  });

  it("モデル化されていないキーが往復する", () => {
    const raw = [
      "---",
      "short_id: abc1234",
      "featured: true",
      "display_type: timeline",
      "locations:",
      "  - name: 深大寺",
      "    place_id: xyz",
      "---",
      "",
      "本文",
      "",
    ].join("\n");
    const { frontmatter } = expectStable(raw);
    expect(frontmatter.featured).toBe(true);
    expect(frontmatter.display_type).toBe("timeline");
    expect(frontmatter.locations).toEqual([{ name: "深大寺", place_id: "xyz" }]);
  });

  it("lable 誤記は label に正規化される (意図的)", () => {
    const raw = "---\nshort_id: abc1234\nsource:\n  - lable: お披露目での自己紹介\n---\n\n本文\n";
    const { frontmatter } = expectStable(raw);
    expect(frontmatter.source).toEqual([{ label: "お披露目での自己紹介" }]);
  });

  it("素の文字列の出典は { label } に正規化される (意図的)", () => {
    const raw = "---\nshort_id: abc1234\nsource:\n  - 坂井新奈トーク 2025.12.1\n---\n\n本文\n";
    const { frontmatter } = expectStable(raw);
    expect(frontmatter.source).toEqual([{ label: "坂井新奈トーク 2025.12.1" }]);
  });

  it("空の source エントリは落ちる (意図的)", () => {
    const raw = "---\nshort_id: abc1234\nsource:\n  - id:\n    url:\n    label:\n---\n\n本文\n";
    const { frontmatter } = expectStable(raw);
    expect(frontmatter.source).toBeUndefined();
  });

  it("frontmatter 直後に空行が無くても本文が壊れない", () => {
    const raw = "---\nshort_id: abc1234\n---\n本文の1行目\n本文の2行目\n";
    const { body } = expectStable(raw);
    expect(body).toBe("本文の1行目\n本文の2行目\n");
  });

  it("本文中の水平線が保たれる", () => {
    const raw = "---\nshort_id: abc1234\n---\n\nA\n\n---\n\nB\n";
    const { body } = expectStable(raw);
    expect(body).toBe("A\n\n---\n\nB\n");
  });
});
