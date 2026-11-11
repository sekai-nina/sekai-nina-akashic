import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ withClearance: vi.fn(), prisma: {} }));
vi.mock("./discoveries", () => ({ AUTO_DRAFT_MAX_ATTEMPTS: 3, DISCOVERY_TAG_NAME: "今日の発見" }));
import { SaveBlogSchema, newestFirst, reviewQueue } from "./discovery-review";
import type { DiscoveryView } from "./discoveries";

function view(no: number, assetId: string, reviewed: boolean): DiscoveryView {
  return {
    no,
    id: `d${no}`,
    assetId,
    position: 0,
    heading: `発見 ${no}`,
    excerpt: "",
    isFood: true,
    ingredients: [],
    result: null,
    confidence: "certain",
    reviewed,
    date: "2026-01-01",
    blogTitle: "",
    url: null,
  };
}

describe("reviewQueue", () => {
  it("確かめていない発見のあるブログを、通し番号の順に重複なく並べる", () => {
    const all = [view(1, "a", true), view(2, "b", false), view(3, "b", false), view(4, "c", true), view(5, "d", false)];
    expect(reviewQueue(all)).toEqual(["b", "d"]);
  });

  it("2 件のうち 1 件だけ確定していないブログも確認待ちに入る", () => {
    expect(reviewQueue([view(1, "a", true), view(2, "a", false)])).toEqual(["a"]);
  });
});

describe("newestFirst", () => {
  it("新しい番号から並べ、元の配列は変えない", () => {
    const all = [view(1, "a", true), view(2, "b", true)];
    expect(newestFirst(all).map((d) => d.no)).toEqual([2, 1]);
    expect(all.map((d) => d.no)).toEqual([1, 2]);
  });
});

describe("SaveBlogSchema", () => {
  const ok = {
    heading: " ケーキとプリン ",
    excerpt: "ケーキとプリン🍮\n一緒に食べると革命です",
    isFood: true,
    ingredients: ["ケーキ", " プリン "],
    result: null,
    confidence: "certain",
  };

  it("前後の空白を落として受け付ける", () => {
    const r = SaveBlogSchema.parse([ok]);
    expect(r[0].heading).toBe("ケーキとプリン");
    expect(r[0].ingredients).toEqual(["ケーキ", "プリン"]);
  });

  it("発見が 0 件・見出しが空・確信度が不正なら弾く", () => {
    expect(SaveBlogSchema.safeParse([]).success).toBe(false);
    expect(SaveBlogSchema.safeParse([{ ...ok, heading: "  " }]).success).toBe(false);
    expect(SaveBlogSchema.safeParse([{ ...ok, confidence: "rare" }]).success).toBe(false);
  });
});
