import { describe, expect, it } from "vitest";
import {
  blogDetailNumber,
  buildCategorizePrompt,
  buildDraftPrompt,
  finalizeCategories,
  finalizeDrafts,
  foodNamesOf,
  numberDiscoveries,
  type DraftResponse,
  type DraftSource,
} from "./core";

const single: DraftSource = {
  assetId: "a1",
  heading: "ポテトとはちみつを一緒に食べると美味しい可能性がある",
  excerpt: "<今日の発見>  \n  \nポテトとはちみつがなんだか美味しい可能性✨️",
};

/** 2025-10-19「きょう！」と同じ形 (食べ物以外の発見と食べ物の発見が 1 本に入っている) */
const double: DraftSource = {
  assetId: "a2",
  heading: "充電100%のときより78%くらいのほうが安心する ／ いちごに少し醤油をかけると高級感が増す可能性がある",
  excerpt:
    "今日の発見〜は  \n  \n充電100％のときより、78％くらいのほうがなんか安心する！\n\nん？食べ物の組み合わせじゃなくなってるって??  \n  \n  \n  \nじゃあ、  \n  \nいちごにすこーし醤油をかけると高級感が増したりするかも",
};

function item(over: Partial<DraftResponse["blogs"][number]["discoveries"][number]> = {}) {
  return {
    heading: "言い換えた見出し",
    excerpt: "言い換えた本文",
    isFood: true,
    ingredients: ["ポテト", "はちみつ"],
    result: null,
    confidence: "maybe" as const,
    ...over,
  };
}

describe("buildDraftPrompt", () => {
  it("ブログに短い key を振り、既にある材料名を渡す", () => {
    const { user } = buildDraftPrompt([single, double], ["はちみつ", "醤油"]);
    expect(user).toContain("### key: b1");
    expect(user).toContain("### key: b2");
    expect(user).toContain("はちみつ、醤油");
    expect(user).not.toContain("a1");
  });

  it("本文が無いブログは見出しを本文として渡す", () => {
    const { user } = buildDraftPrompt([{ ...single, excerpt: "" }], []);
    expect(user).toContain(`本文:\n${single.heading}`);
    expect(user).toContain("(まだありません)");
  });
});

describe("finalizeDrafts", () => {
  it("発見が 1 件の回は見出しと抜粋を bot の値のまま使う", () => {
    const { drafts, warnings } = finalizeDrafts([single], { blogs: [{ key: "b1", discoveries: [item()] }] });
    const [d] = drafts.get("a1")!;
    expect(d.heading).toBe(single.heading);
    expect(d.excerpt).toBe(single.excerpt);
    expect(d.position).toBe(0);
    expect(warnings).toEqual([]);
  });

  it("2 件に分けた回は LLM の見出し・抜粋を使い、position を振る", () => {
    const { drafts, warnings } = finalizeDrafts([double], {
      blogs: [
        {
          key: "b1",
          discoveries: [
            item({
              heading: "充電100%のときより78%くらいのほうが安心する",
              excerpt: "充電100％のときより、78％くらいのほうがなんか安心する！",
              isFood: false,
              ingredients: ["充電"],
              result: "安心",
              confidence: "certain",
            }),
            item({
              heading: "いちごに少し醤油をかけると高級感が増す可能性がある",
              excerpt: "いちごにすこーし醤油をかけると\n高級感が増したりするかも",
              ingredients: ["いちご", "醤油"],
            }),
          ],
        },
      ],
    });
    const rows = drafts.get("a2")!;
    expect(rows.map((r) => r.position)).toEqual([0, 1]);
    expect(rows[1].heading).toBe("いちごに少し醤油をかけると高級感が増す可能性がある");
    // 食べ物以外は材料・できあがりを空にする
    expect(rows[0].ingredients).toEqual([]);
    expect(rows[0].result).toBeNull();
    // 改行の違いは無視して本文に含まれていれば警告しない
    expect(warnings.map((w) => w.message)).toEqual(["2 件に分けました"]);
  });

  it("分けた抜粋が本文に無ければ警告する", () => {
    const { warnings } = finalizeDrafts([double], {
      blogs: [{ key: "b1", discoveries: [item({ excerpt: "充電の話" }), item({ excerpt: "いちごにすこーし醤油" })] }],
    });
    expect(warnings.filter((w) => w.message.startsWith("抜粋が本文と一致しません"))).toHaveLength(1);
  });

  it("材料の空白・重複・全角英数を整え、空のできあがりは null にする", () => {
    const { drafts } = finalizeDrafts([single], {
      blogs: [{ key: "b1", discoveries: [item({ ingredients: [" ポテト ", "ポテト", "", "ＭＣＴオイル"], result: " " })] }],
    });
    const [d] = drafts.get("a1")!;
    expect(d.ingredients).toEqual(["ポテト", "MCTオイル"]);
    expect(d.result).toBeNull();
  });

  it("返答に無いブログと、材料の無い食べ物の発見を警告する", () => {
    const { drafts, warnings } = finalizeDrafts([single, double], {
      blogs: [{ key: "b1", discoveries: [item({ ingredients: [] })] }],
    });
    expect(drafts.has("a2")).toBe(false);
    expect(warnings).toEqual([
      { assetId: "a1", message: `食べ物なのに材料がありません: ${single.heading}` },
      { assetId: "a2", message: "下書きが返ってきませんでした" },
    ]);
  });
});

describe("numberDiscoveries", () => {
  it("日付 → 公式ブログの記事番号 → ブログ内の順で通し番号を振る", () => {
    const rows = [
      { id: "c", date: "2026-03-14", url: "https://www.hinatazaka46.com/s/official/diary/detail/68357", position: 0 },
      { id: "b2", date: "2026-02-01", url: "https://www.hinatazaka46.com/s/official/diary/detail/9999", position: 1 },
      { id: "b1", date: "2026-02-01", url: "https://www.hinatazaka46.com/s/official/diary/detail/9999", position: 0 },
      { id: "a", date: "2026-02-01", url: "https://www.hinatazaka46.com/s/official/diary/detail/10000", position: 0 },
    ];
    expect(numberDiscoveries(rows).map((r) => [r.no, r.id])).toEqual([
      [1, "b1"],
      [2, "b2"],
      [3, "a"],
      [4, "c"],
    ]);
  });

  it("URL の無いブログは同じ日の最後に並べる", () => {
    expect(blogDetailNumber(null)).toBe(Number.MAX_SAFE_INTEGER);
    expect(blogDetailNumber("https://example.com/diary/detail/123?ima=0")).toBe(123);
  });
});

describe("分類", () => {
  it("頼んだ名前だけを残し、名前を写し間違えたものは捨てる", () => {
    const got = finalizeCategories(["はちみつ", "バナナ"], {
      foods: [
        { name: "はちみつ", category: "seasoning" },
        { name: "ばなな", category: "fruit" },
        { name: "はちみつ", category: "sweet" },
      ],
    });
    expect([...got]).toEqual([["はちみつ", "seasoning"]]);
  });

  it("材料とできあがる味の名前を重複なく集める", () => {
    expect(
      foodNamesOf([
        { ingredients: ["バナナ", "マヨネーズ"], result: "プリン" },
        { ingredients: ["バナナ", "醤油"], result: null },
      ]),
    ).toEqual(["バナナ", "マヨネーズ", "プリン", "醤油"]);
  });

  it("名前を 1 行ずつ渡す", () => {
    expect(buildCategorizePrompt(["はちみつ", "バナナ"]).user).toBe("- はちみつ\n- バナナ");
  });
});

describe("finalizeDrafts の見出し", () => {
  it("分けた発見の見出しが空なら元の見出しを入れて警告する", () => {
    const { drafts, warnings } = finalizeDrafts([double], {
      blogs: [{ key: "b1", discoveries: [item({ heading: " ", excerpt: "充電100％" }), item({ excerpt: "いちごにすこーし醤油" })] }],
    });
    expect(drafts.get("a2")![0].heading).toBe(double.heading);
    expect(warnings.some((w) => w.message.startsWith("分けた発見の見出しが空"))).toBe(true);
  });
});
