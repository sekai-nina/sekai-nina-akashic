import { describe, expect, it } from "vitest";

import {
  buildFrontmatter,
  formatFrontmatterDate,
  parseArticle,
  parseFrontmatterDate,
  serializeArticle,
  splitFrontmatter,
  type ArticleFrontmatterInput,
} from "./frontmatter";
import { roundtrip } from "./roundtrip";

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
      sources: [{ ref: "cuid1", date: "2025-12-28", label: "ラベル", url: "https://example.com", id: 1 }],
    });
    expect(Object.keys((fm.source as Record<string, unknown>[])[0])).toEqual(["id", "url", "label", "date", "ref"]);
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
