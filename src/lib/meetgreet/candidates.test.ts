import { describe, expect, it } from "vitest";

import { classifyCandidates, classifyGroupKind, type CandidateAssetInput } from "./candidates";

// canonicalDate の規約: JST 深夜 = 前日 15:00 UTC
const jst = (ymd: string, hm = "00:00") => new Date(`${ymd}T${hm}:00+09:00`);

const BLOG_URL = "https://www.hinatazaka46.com/s/official/diary/detail/70435";
const STAFF_URL = "https://www.hinatazaka46.com/s/official/diary/manager/list?ima=0000#article-70538";

function asset(over: Partial<CandidateAssetInput> & { id: string }): CandidateAssetInput {
  return {
    kind: "image",
    title: over.id,
    canonicalDate: null,
    thumbnailUrl: null,
    source: null,
    text: null,
    hasTalkTag: false,
    ...over,
  };
}

const blogText = asset({
  id: "blog-text",
  kind: "text",
  title: "坂井新奈ブログ「待ち合わせ🎐」",
  canonicalDate: jst("2026-08-03", "16:20"),
  source: { url: BLOG_URL, title: "坂井新奈ブログ「待ち合わせ🎐」" },
  text: "まずは先日の京都でのリアルミーグリ本当にありがとうございました！",
});
const blogImg = (n: number) =>
  asset({
    id: `blog-img-${n}`,
    title: `坂井新奈ブログ「待ち合わせ🎐」 (${n}/11)`,
    canonicalDate: jst("2026-08-03", "16:20"),
    source: { url: BLOG_URL, title: "坂井新奈ブログ「待ち合わせ🎐」" },
  });
const talkImg = (id: string, ymd: string, hm: string) =>
  asset({
    id,
    title: `坂井新奈トーク ${ymd} ${hm}`,
    canonicalDate: jst(ymd, hm),
    source: { url: null, title: "Talk メッセージ #1" },
    hasTalkTag: true,
  });

const opts = (over: Partial<Parameters<typeof classifyCandidates>[1]> = {}) => ({
  date: "2026-08-01",
  inDossier: new Set<string>(),
  staffTexts: new Map<string, string>(),
  ...over,
});

describe("classifyGroupKind", () => {
  it("出典 URL で本人ブログ / 運営ブログを分ける", () => {
    expect(classifyGroupKind(blogText)).toBe("blog");
    expect(
      classifyGroupKind(asset({ id: "s", source: { url: STAFF_URL, title: "" } }))
    ).toBe("staff");
  });

  it("トークはタグか出典タイトルの Talk で判定する (kind は見ない)", () => {
    expect(classifyGroupKind(talkImg("t", "2026-08-02", "13:15"))).toBe("talk");
    expect(
      classifyGroupKind(asset({ id: "t2", source: { url: null, title: "Talk メッセージ #9" } }))
    ).toBe("talk");
  });

  it("どれでもなければその他", () => {
    expect(
      classifyGroupKind(asset({ id: "yt", source: { url: "https://www.youtube.com/shorts/x", title: "" } }))
    ).toBe("other");
  });
});

describe("classifyCandidates", () => {
  it("ブログは URL ごとに 1 グループで、本文がキーワードに当たれば画像も初期チェック", () => {
    const groups = classifyCandidates([blogImg(2), blogImg(10), blogText, blogImg(1)], opts());
    expect(groups).toHaveLength(1);
    const g = groups[0];
    expect(g.kind).toBe("blog");
    expect(g.title).toBe("坂井新奈ブログ「待ち合わせ🎐」");
    expect(g.url).toBe(BLOG_URL);
    expect(g.matched).toBe(true);
    // 本文 → 画像は (n/N) の数値順
    expect(g.assets.map((a) => a.id)).toEqual(["blog-text", "blog-img-1", "blog-img-2", "blog-img-10"]);
    expect(g.assets.every((a) => a.suggested)).toBe(true);
  });

  it("キーワードに当たらないブログは列挙するがチェックしない", () => {
    const groups = classifyCandidates(
      [{ ...blogText, text: "今日は映画を観ました" }, blogImg(1)],
      opts()
    );
    expect(groups[0].matched).toBe(false);
    expect(groups[0].assets.every((a) => !a.suggested)).toBe(true);
  });

  it("運営ブログは候補外の本文 (staffTexts) でキーワード判定する", () => {
    const staffImg = asset({
      id: "staff-img",
      title: "花火でも見に行く？🎆 (1/4)",
      canonicalDate: jst("2026-08-09"),
      source: { url: STAFF_URL, title: "花火でも見に行く？🎆" },
    });
    const miss = classifyCandidates([staffImg], opts());
    expect(miss[0].kind).toBe("staff");
    expect(miss[0].assets[0].suggested).toBe(false);

    const hit = classifyCandidates(
      [staffImg],
      opts({ staffTexts: new Map([[STAFF_URL, "京都のリアルミーグリの様子です"]]) })
    );
    expect(hit[0].matched).toBe(true);
    expect(hit[0].assets[0].suggested).toBe(true);
  });

  it("トーク画像 / 動画は当日〜翌日だけ初期チェック、テキストはキーワードで判定", () => {
    const groups = classifyCandidates(
      [
        talkImg("t-day", "2026-08-01", "10:31"),
        talkImg("t-next", "2026-08-02", "13:15"),
        talkImg("t-late", "2026-08-03", "09:00"),
        { ...talkImg("t-text-hit", "2026-08-05", "09:00"), kind: "text", text: "ミーグリありがとう" },
        { ...talkImg("t-text-miss", "2026-08-01", "09:00"), kind: "text", text: "おはよう" },
      ],
      opts()
    );
    expect(groups).toHaveLength(1);
    const byId = Object.fromEntries(groups[0].assets.map((a) => [a.id, a.suggested]));
    expect(byId).toEqual({
      "t-day": true,
      "t-next": true,
      "t-late": false,
      "t-text-hit": true,
      "t-text-miss": false,
    });
  });

  it("既にドシエにあるものは inDossier で、チェックは付けない", () => {
    const groups = classifyCandidates(
      [talkImg("t-next", "2026-08-02", "13:15")],
      opts({ inDossier: new Set(["t-next"]) })
    );
    expect(groups[0].assets[0]).toMatchObject({ inDossier: true, suggested: false });
  });

  it("並びは ブログ (日付順) → 運営ブログ → トーク → その他", () => {
    const groups = classifyCandidates(
      [
        asset({ id: "yt", source: { url: "https://www.youtube.com/shorts/x", title: "" } }),
        talkImg("t", "2026-08-02", "13:15"),
        asset({ id: "staff", source: { url: STAFF_URL, title: "" } }),
        { ...blogText, id: "blog-b", canonicalDate: jst("2026-08-05"), source: { url: BLOG_URL + "1", title: "" } },
        blogText,
      ],
      opts()
    );
    expect(groups.map((g) => g.kind)).toEqual(["blog", "blog", "staff", "talk", "other"]);
    expect(groups[0].assets[0].id).toBe("blog-text");
  });
});
