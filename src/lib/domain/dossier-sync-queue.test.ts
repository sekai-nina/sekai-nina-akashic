import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ withSession: vi.fn() }));
vi.mock("./dossiers", () => ({ NOT_CLIP_POOL: {} }));
vi.mock("./dossier-materials", () => ({ PUBLISHABLE: new Set(["public", "internal"]) }));
import { computePending, type ArticleState, type DossierRow, type ItemRow } from "./dossier-sync-queue";
import { exclusionKey } from "@/lib/meetgreet/append";

const at = (day: number) => new Date(`2026-10-${String(day).padStart(2, "0")}T00:00:00Z`);
const BLOG = "https://www.hinatazaka46.com/s/official/diary/detail/1";
let seq = 0;

interface ItemPatch {
  excerpt?: string;
  createdAt?: Date;
  kind?: string;
  title?: string;
  url?: string | null;
  sourceKind?: string;
  classification?: string;
}
const item = (assetId: string, p: ItemPatch = {}): ItemRow => ({
  id: `item${++seq}`,
  assetId,
  excerpt: p.excerpt ?? "",
  createdAt: p.createdAt ?? at(24),
  asset: {
    kind: p.kind ?? "text",
    title: p.title ?? "坂井新奈ブログ「風の向くまま」",
    canonicalDate: null,
    classification: p.classification ?? "internal",
    sourceRecords: [{ sourceKind: p.sourceKind ?? "blog", title: "風の向くまま", url: p.url === undefined ? BLOG : p.url }],
  },
});
const row = (items: ItemRow[], patch: Partial<DossierRow> = {}): DossierRow => ({
  id: "d1",
  title: "企画",
  articleTemplate: null,
  articleExclusions: [],
  meetGreet: null,
  live: null,
  articles: [{ id: "a1" }],
  items,
  ...patch,
});
const state = (patch: Partial<ArticleState> = {}): ArticleState => ({
  citedAssets: new Set(),
  citedUrls: new Set(),
  bodies: [""],
  ...patch,
});
const pendingIds = (r: DossierRow, s: ArticleState) => computePending(r, s)?.clips.map((c) => c.assetId) ?? [];
const talk = (assetId: string) => item(assetId, { title: "Talk 2026.10.1 12:00", sourceKind: "other", url: null });

describe("computePending (スナップなど本文を AI / 人が書くテンプレート・未設定)", () => {
  it("出典になっていないアセットだけ、新しく入れた順に返す", () => {
    const items = [
      item("x", { createdAt: at(1) }),
      item("y", { createdAt: at(24), url: null }),
      item("z", { createdAt: at(10), url: null }),
    ];
    const p = computePending(row(items, { articleTemplate: "attribute" }), state({ citedAssets: new Set(["x"]) }));
    expect(p?.clips.map((c) => c.assetId)).toEqual(["y", "z"]);
    expect(p?.latestAt).toEqual(at(24));
  });

  it("記事の無い企画は反映待ちにしない (未記事化の側に出る)", () => {
    expect(computePending(row([item("x")], { articles: [] }), state())).toBeNull();
  });

  it("出典は URL でも突き合わせる (URL だけの出典・先頭画像が出典のブログ)", () => {
    expect(pendingIds(row([item("x")]), state({ citedUrls: new Set([BLOG]) }))).toEqual([]);
  });

  it("「今後足さない」のアセットは数えない", () => {
    expect(pendingIds(row([item("x")], { articleExclusions: [exclusionKey("source", "x")] }), state())).toEqual([]);
  });

  it("器のある企画は器の除外を見る", () => {
    const meetgreet = row([talk("t")], { articleTemplate: "meetgreet", meetGreet: { articleExclusions: ["asset:t"] } });
    expect(pendingIds(meetgreet, state())).toEqual([]);
    const live = row([talk("t")], { articleTemplate: "live", articleExclusions: ["asset:t"], live: { articleExclusions: [] } });
    expect(pendingIds(live, state())).toEqual(["t"]);
  });

  it("トークは ID で出典になっていれば反映済み", () => {
    expect(pendingIds(row([talk("t")], { articleTemplate: "meetgreet" }), state({ citedAssets: new Set(["t"]) }))).toEqual([]);
  });

  it("公開リポジトリに載せられない機密・見えないアセットは数えない", () => {
    const hidden: ItemRow = { ...item("h"), asset: null };
    expect(pendingIds(row([item("c", { classification: "confidential" }), hidden]), state())).toEqual([]);
  });

  it("同じアセットを抜粋ごとに入れたものは別々に数える (一覧と記事画面の件数が揃う)", () => {
    const items = [item("y", { excerpt: "一つ目", url: null }), item("y", { excerpt: "二つ目", url: null })];
    expect(pendingIds(row(items), state())).toEqual(["y", "y"]);
  });
});

describe("computePending の抜粋 (引用を本文に足すテンプレート)", () => {
  const excerpt = "今日はレッスンでした\n次の行";

  it("ブログが出典済みでも、先頭行が本文に無い抜粋は未反映", () => {
    const r = row([item("x", { excerpt })], { articleTemplate: "quote_blog" });
    expect(pendingIds(r, state({ citedAssets: new Set(["x"]), bodies: ["> 別の抜粋"] }))).toEqual(["x"]);
    expect(pendingIds(r, state({ bodies: ["> 今日はレッスンでした"] }))).toEqual([]);
  });

  it("差分で外した抜粋 (quote: キー) は数えない", () => {
    const r = row([item("x", { excerpt })], {
      articleTemplate: "meetgreet",
      meetGreet: { articleExclusions: [exclusionKey("quote", excerpt)] },
    });
    expect(pendingIds(r, state())).toEqual([]);
  });

  it("運営ブログの抜粋・抜粋の無い本文は引用にならないので数えない", () => {
    const staff = item("s", { excerpt, url: "https://www.hinatazaka46.com/s/official/diary/manager/1" });
    expect(pendingIds(row([staff, item("x")], { articleTemplate: "meetgreet" }), state())).toEqual([]);
  });

  it("言葉 (ブログ) は抜粋以外 (画像・トーク) を数えない", () => {
    const image = item("i", { kind: "image", title: "坂井新奈ブログ「風の向くまま」 (1/4)" });
    expect(pendingIds(row([image, talk("t")], { articleTemplate: "quote_blog" }), state())).toEqual([]);
  });
});

describe("computePending のブログ画像", () => {
  const img1 = item("i1", { kind: "image", title: "坂井新奈ブログ「風の向くまま」 (1/4)" });
  const img2 = item("i2", { kind: "image", title: "坂井新奈ブログ「風の向くまま」 (2/4)" });
  const line = "- 【ブログ・画像】坂井新奈ブログ「風の向くまま」 (1/4)^[3]";

  it("関連メディアの行に載っている画像は反映済み (画像は出典にならず、ブログ本文が出典)", () => {
    const body = `## 関連メディア\n\n${line}\n`;
    expect(pendingIds(row([img1, img2], { articleTemplate: "meetgreet" }), state({ bodies: [body] }))).toEqual(["i2"]);
  });

  it("行で足すテンプレートでは、ブログの出典が URL で当たっても行が無ければ未反映", () => {
    expect(pendingIds(row([img1], { articleTemplate: "outing" }), state({ citedUrls: new Set([BLOG]) }))).toEqual(["i1"]);
  });

  it("スナップでは、ブログの出典が URL で当たれば画像も反映済み (差分に出ない)", () => {
    expect(pendingIds(row([img1], { articleTemplate: "attribute" }), state({ citedUrls: new Set([BLOG]) }))).toEqual([]);
  });

  it("題が本文に出てくるだけ (行の形でない) なら反映済みにしない", () => {
    const body = "坂井新奈ブログ「風の向くまま」 (1/4) について";
    expect(pendingIds(row([img1], { articleTemplate: "meetgreet" }), state({ bodies: [body] }))).toEqual(["i1"]);
  });

  it("複数記事のどれかに載っていれば反映済み", () => {
    const r = row([img1], { articleTemplate: "meetgreet", articles: [{ id: "a1" }, { id: "a2" }] });
    expect(pendingIds(r, state({ bodies: ["", line] }))).toEqual([]);
  });
});
