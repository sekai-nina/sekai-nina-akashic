import { describe, expect, it } from "vitest";
import { deriveRadioItems, isRelevantMaterial, itemKeysForAsset, radioItemMatchesAsset, type MaterialAsset } from "./material-items";

const radio = (shortId = "year1", title = "【1年目】ラジオ出演一覧", body = [
  "本文中の | 9 | は数えない", "",
  "| # | 放送日 | 番組名 | 出演メンバー | 関連リンク |", "| --- | --- | --- | --- | --- |",
  "| 2 | 2025/7/11 | TOKAI RADIO「OH!MY CHANNEL!」 | 坂井新奈 | [告知](https://x.com/official/status/2) |",
  "| 3 | 2025/7/11 | FM AICHI「COUNTDOWN FRIDAY」 | 坂井新奈 | |",
  "", "| 99 | 2025/7/12 | 表外 | | |",
].join("\n")) => ({ shortId, title, body });

const asset = (date: string | null, overrides: Partial<MaterialAsset> = {}): MaterialAsset => ({
  id: "asset", title: "録音", canonicalDate: date ? new Date(date) : null, classification: "internal",
  sourceRecords: [{ url: "https://talk.test/1", publisher: "Talk (Sony Music)", title: "トーク" }],
  ...overrides,
});
const talk = { key: "talk", itemRule: "talk_date" as const, publisherPattern: "Talk (Sony Music)%", titlePattern: null };

describe("ラジオ出演一覧の導出", () => {
  it("実記事と同じ列で読み、同日複数放送を別素材にする", () => {
    const items = deriveRadioItems([radio()]);
    expect(items.map((i) => [i.itemKey, i.itemDate])).toEqual([["year1:2", "2025-07-11"], ["year1:3", "2025-07-11"]]);
    expect(items[0].sourceUrls).toEqual(["https://x.com/official/status/2"]);
  });
  it("年度ごとの同じ番号を区別し、リンク・表記の編集でキーを変えない", () => {
    const edited = radio("year1"); edited.body = edited.body.replace("CHANNEL!", "CHANNEL! 特集");
    expect(deriveRadioItems([edited])[0].itemKey).toBe("year1:2");
    expect(deriveRadioItems([radio(), radio("year2", "【2年目】ラジオ出演一覧")])).toHaveLength(4);
    expect(deriveRadioItems([radio("root", "ラジオ出演一覧", "- [[【1年目】ラジオ出演一覧]]")])).toEqual([]);
  });
  it("別の記事・別の表・不正な日付・合計行を導出しない", () => {
    expect(deriveRadioItems([radio("x", "その他のラジオ出演一覧")])).toEqual([]);
    expect(deriveRadioItems([radio("x", "ラジオ出演一覧", "| # | 日付 | タイトル |\n| - | - | - |\n| 1 | 2025/1/1 | x |")])).toEqual([]);
    const body = "| # | 放送日 | 番組名 |\n| - | - | - |\n| 1 | 2025/2/30 | a |\n| 合計 | 2025/1/1 | a |\n| 2 | 2025/2/28 | b |";
    expect(deriveRadioItems([radio("x", "ラジオ出演一覧", body)]).map((i) => i.itemKey)).toEqual(["x:2"]);
  });
  it("列の順序とエスケープされたパイプに対応する", () => {
    const body = "| 番組名 | # | 放送日 |\n| :-- | --: | --- |\n| A\\|B | 1 | 2026/1/2 |";
    expect(deriveRadioItems([radio("x", "ラジオ出演一覧", body)])[0].itemTitle).toBe("A|B");
  });
  it("出典 URL または放送日と番組名でアセットを対応させる。同日だけでは対応させない", () => {
    const item = deriveRadioItems([radio()])[0];
    expect(radioItemMatchesAsset(item, asset("2025-07-10T15:00:00Z", { title: "TOKAI RADIO「OH!MY CHANNEL!」 録音" }))).toBe(true);
    expect(radioItemMatchesAsset(item, asset("2025-07-10T15:00:00Z"))).toBe(false);
    expect(radioItemMatchesAsset(item, asset("2025-07-11T15:00:00Z", { title: "TOKAI RADIO「OH!MY CHANNEL!」" }))).toBe(false);
    expect(radioItemMatchesAsset(item, asset(null, { sourceRecords: [{ url: item.sourceUrls![0], title: null, publisher: null }] }))).toBe(true);
  });
});

describe("トークの素材は JST の日単位", () => {
  it("UTC 15時で切り替わり、同じ JST 日の複数アセットで同じキーになる", () => {
    expect(itemKeysForAsset(talk, asset("2026-10-15T14:59:59.999Z"))).toEqual(["2026-10-15"]);
    expect(itemKeysForAsset(talk, asset("2026-10-15T15:00:00.000Z"))).toEqual(["2026-10-16"]);
    expect(itemKeysForAsset(talk, asset("2026-10-16T14:59:59.999Z"))).toEqual(["2026-10-16"]);
    expect(itemKeysForAsset(talk, asset("2025-12-31T15:00:00Z"))).toEqual(["2026-01-01"]);
  });
  it("日付が無い・publisher が違うアセットは含めない", () => {
    expect(itemKeysForAsset(talk, asset(null))).toEqual([]);
    expect(itemKeysForAsset({ ...talk, publisherPattern: "別の配信元%" }, asset("2026-10-16T00:00:00Z"))).toEqual([]);
  });
});

it("URL 素材は同じ URL を重複させず、publisher と番組タイトルを両方確認する", () => {
  const a = asset(null); a.sourceRecords.push(a.sourceRecords[0]);
  expect(itemKeysForAsset({ ...talk, itemRule: "source_url" }, a)).toEqual(["https://talk.test/1"]);
  expect(itemKeysForAsset({ ...talk, itemRule: "source_url", titlePattern: "#_ %|#__ %" }, a)).toEqual([]);
});

it("分母は本人著・言及・手動対象の和集合。済も対象で、済を外しても手動対象は残る", () => {
  const automatic = new Set(["author", "mention"]);
  expect(isRelevantMaterial("author", automatic)).toBe(true);
  expect(isRelevantMaterial("mention", automatic)).toBe(true);
  expect(isRelevantMaterial("other", automatic)).toBe(false);
  expect(isRelevantMaterial("other", automatic, { included: true, done: false })).toBe(true);
  expect(isRelevantMaterial("other", automatic, { included: false, done: true })).toBe(true);
  expect(isRelevantMaterial("other", automatic, { included: false, done: false })).toBe(false);
});
