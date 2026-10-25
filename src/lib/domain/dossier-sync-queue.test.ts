import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db", () => ({ withSession: vi.fn() }));
vi.mock("./dossiers", () => ({ NOT_CLIP_POOL: {} }));
import { computePending } from "./dossier-sync-queue";

const text = { kind: "text", title: "ブログ" };
const at = (day: number) => new Date(`2026-10-${String(day).padStart(2, "0")}T00:00:00Z`);
const row = (patch: Record<string, unknown> = {}) => ({
  id: "d1",
  title: "おばあちゃんについて",
  articleExclusions: [],
  meetGreet: null,
  live: null,
  articles: [{ id: "a1" }],
  items: [
    { assetId: "x", createdAt: at(1), asset: text },
    { assetId: "y", createdAt: at(24), asset: text },
    { assetId: null, createdAt: at(25), asset: null },
  ],
  ...patch,
});

describe("computePending", () => {
  it("どの記事の出典にもなっていないアセットだけ数え、新しい順に並べる", () => {
    const items = [...row().items, { assetId: "z", createdAt: at(10), asset: text }];
    const p = computePending(row({ items }), new Map([["a1", new Set(["x"])]]), new Map());
    expect(p).toMatchObject({ dossierId: "d1", count: 2, assetIds: ["y", "z"], latestAt: at(24) });
  });

  it("記事の無い企画は反映待ちにしない (未記事化の側に出る)", () => {
    expect(computePending(row({ articles: [] }), new Map(), new Map())).toBeNull();
  });

  it("複数記事のどれかで出典になっていれば反映済み", () => {
    const p = computePending(
      row({ articles: [{ id: "a1" }, { id: "a2" }] }),
      new Map([["a1", new Set(["x"])], ["a2", new Set(["y"])]]),
      new Map()
    );
    expect(p).toBeNull();
  });

  it("「今後足さない」のアセットは数えない", () => {
    expect(computePending(row({ articleExclusions: ["asset:y"] }), new Map([["a1", new Set(["x"])]]), new Map())).toBeNull();
  });

  it("器のある企画は器の除外を見る (企画の除外は使われない)", () => {
    const cited = new Map([["a1", new Set(["x"])]]);
    expect(computePending(row({ meetGreet: { articleExclusions: ["asset:y"] } }), cited, new Map())).toBeNull();
    expect(
      computePending(row({ articleExclusions: ["asset:y"], live: { articleExclusions: [] } }), cited, new Map())
    ).toMatchObject({ assetIds: ["y"] });
  });

  it("同じアセットを抜粋ごとに入れたものはアイテム数で数え、アセットは 1 つにまとめる", () => {
    const p = computePending(
      row({ items: [{ assetId: "y", createdAt: at(2), asset: text }, { assetId: "y", createdAt: at(3), asset: text }] }),
      new Map(),
      new Map()
    );
    expect(p).toMatchObject({ count: 2, assetIds: ["y"], latestAt: at(3) });
  });
});

describe("computePending のブログ画像", () => {
  const image = (assetId: string, title: string) => ({ assetId, createdAt: at(24), asset: { kind: "image", title } });
  const items = [image("i1", "坂井新奈ブログ「風の向くまま」 (1/4)"), image("i2", "坂井新奈ブログ「風の向くまま」 (2/4)")];

  it("関連メディアの行に載っている画像は反映済み (画像は出典にならず、ブログ本文が出典)", () => {
    const body = "## 関連メディア\n\n- 【ブログ・画像】坂井新奈ブログ「風の向くまま」 (1/4)^[3]\n";
    const p = computePending(row({ items }), new Map(), new Map([["a1", body]]));
    expect(p).toMatchObject({ assetIds: ["i2"] });
  });

  it("題が本文に出てくるだけ (行の形でない) なら反映済みにしない", () => {
    const body = "坂井新奈ブログ「風の向くまま」 (1/4) について";
    expect(computePending(row({ items }), new Map(), new Map([["a1", body]]))).toMatchObject({ count: 2 });
  });

  it("アセットが見えないアイテムは数えない", () => {
    expect(computePending(row({ items: [{ assetId: "h", createdAt: at(1), asset: null }] }), new Map(), new Map())).toBeNull();
  });
});
