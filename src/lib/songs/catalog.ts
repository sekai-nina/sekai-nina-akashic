/**
 * Sony Music のディスコグラフィ JSON を作品 (Release) と曲 (Song) の入力に組み立てる (#167)。
 * **DB も HTTP も触らない純粋関数** (取得は sony.ts、書き込みは src/cli/import-songs.ts)。
 *
 * 公式サイト (hinatazaka46.com) のディスコグラフィは同じ JSON から描画している。形は
 * `items.discs[].contents[].{track_number,title}` で、盤 (TYPE-A〜D / 通常盤) ごとに 1 件。
 */

import { normalizeSongTitle } from "./normalize";

/** 一覧 (`/discography/start/N/count/M/callback/x`) の 1 件。使う項目だけ */
export interface CatalogItem {
  representative_goods_number: string;
  title: string;
  /** "シングル" | "アルバム" | "BD" | "DVD" */
  type: string;
  artistName: string;
  /** "2026.01.28" */
  release_date: string;
}

/**
 * 盤の詳細 (`/discography/<品番>/callback/<品番小文字>`)。
 * 実際の API は `discs[]` が **1 トラックにつき 1 要素** (`{ disc_number, title: "", contents: [1 件] }`)
 * で来る。1 ディスクに contents が並ぶ形でも同じに扱う。
 * 詳細が取れない盤 (発売前) は `discs: []` で渡す (作品のまとめ・代表品番の判定には使う)
 */
export interface CatalogDetail extends CatalogItem {
  discs: { disc_number: number; title: string; contents: { track_number: number; title: string }[] }[];
}

export interface ReleaseInput {
  /** 盤の【】を落とした作品名 */
  title: string;
  kind: "single" | "album";
  /** "YYYY-MM-DD" */
  releaseDate: string;
  artist: string;
  /** 代表品番 (通常盤があればそれ、無ければ最初の盤) */
  sonyCode: string;
  editions: { code: string; title: string }[];
  tracks: TrackInput[];
}

export interface TrackInput {
  title: string;
  normalizedTitle: string;
  discNo: number;
  trackNo: number;
  /** この曲が入っている盤の品番 */
  editions: string[];
}

/** JSONP (`callback({...})`) の中身を取り出す */
export function parseJsonp<T = unknown>(text: string): T {
  const start = text.indexOf("(");
  const end = text.lastIndexOf(")");
  if (start < 0 || end < start) throw new Error("JSONP の形ではありません");
  return JSON.parse(text.slice(start + 1, end)) as T;
}

/** CD の盤か (BD / DVD は曲マスタの対象外) */
export function isCdItem(item: Pick<CatalogItem, "type">): boolean {
  return item.type === "シングル" || item.type === "アルバム";
}

/**
 * 曲を数えるディスクか。初回盤の disc 2 はライブ映像の Blu-ray で、その中身
 * (Overture, ライブの曲順) は曲の収録ではない。**disc 1、またはタイトルに CD と書いてある
 * ディスクだけ**を CD とみなす (2 枚組アルバムは `DISC2／CD` の形で来る)
 */
export function isCdDisc(disc: { disc_number: number; title: string }): boolean {
  if (/blu-?ray|bd|dvd/i.test(disc.title)) return false;
  if (disc.disc_number === 1) return true;
  return /cd/i.test(disc.title);
}

/**
 * 曲として数えるトラックか。off vocal / instrumental / Overture (SE) と、
 * 既にある曲のライブ音源 (「JOYFUL LOVE(Live from Happy Train Tour 2023)」) は除く
 */
export function isSongTrack(title: string): boolean {
  const t = title.trim();
  if (!t) return false;
  if (/off\s*vocal|\binst(?:\.|rumental)?\b|karaoke|カラオケ/i.test(t)) return false;
  if (/\(\s*live\s+(?:from|at|ver)/i.test(t) || /（\s*live\s+(?:from|at|ver)/i.test(t)) return false;
  if (/^overture$/i.test(t)) return false;
  return true;
}

/**
 * 「Cage（東村芽依 金村美玖 河田陽菜 丹生明里）」→「Cage」。
 * ユニット曲は盤によってメンバー名が括弧で付くので落とす。括弧の中が空白区切りの
 * 2 語以上で、数字・英字を含まない (= 人名の列) ときだけ
 */
export function stripUnitCredit(title: string): string {
  const m = title.match(/^(.*?)\s*[（(]([^（）()]+)[）)]\s*$/);
  if (!m) return title;
  const inner = m[2].trim();
  const tokens = inner.split(/\s+/);
  if (tokens.length < 2 || /[0-9A-Za-z０-９Ａ-Ｚａ-ｚ]/.test(inner)) return title;
  return m[1].trim() || title;
}

/**
 * Sony の種別を信用できない作品。「Kind of love」は 17th シングルだが catalog では
 * アルバム (盤あたり 3 曲) になっている。ordinal (何枚目) は持たないが kind だけは直す
 */
const KIND_OVERRIDES: Record<string, "single" | "album"> = {
  "SRCL-13718": "single",
};

/** 「クリフハンガー【初回仕様限定盤 TYPE-A】」→「クリフハンガー」。[通常盤] / (TYPE-A) も落とす */
export function stripEditionSuffix(title: string): string {
  return title
    .replace(/【[^】]*】/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/[（(][^）)]*(?:盤|type|TYPE|Type)[^）)]*[）)]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 「2026.01.28」→「2026-01-28」 */
export function toDateString(sonyDate: string): string {
  const m = sonyDate.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/);
  if (!m) throw new Error(`発売日の形が想定外です: ${sonyDate}`);
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

/** 「けやき坂46（日向坂46）」→「けやき坂46」。それ以外は「日向坂46」 */
export function normalizeArtist(artistName: string): string {
  if (artistName.includes("けやき坂46")) return "けやき坂46";
  if (artistName.includes("日向坂46")) return "日向坂46";
  return artistName.trim();
}

/** 通常盤か (タイトルに盤の区別が無い、または「通常盤」と書いてある) */
function isRegularEdition(title: string): boolean {
  return !/【|\[/.test(title) || /通常盤/.test(title);
}

/**
 * 盤の詳細をまとめて作品ごとに畳む。作品の同一性は (アーティスト, 作品名, 発売日)。
 * 収録曲は全盤の和集合で、番号は品番順で最初に現れた盤のもの
 */
export function groupEditions(details: CatalogDetail[]): ReleaseInput[] {
  const groups = new Map<string, { editions: CatalogDetail[] }>();
  for (const d of details) {
    if (!isCdItem(d)) continue;
    const key = `${normalizeArtist(d.artistName)}|${stripEditionSuffix(d.title)}|${d.release_date}`;
    const g = groups.get(key) ?? { editions: [] };
    g.editions.push(d);
    groups.set(key, g);
  }

  const out: ReleaseInput[] = [];
  for (const g of groups.values()) {
    const editions = [...g.editions].sort((a, b) =>
      a.representative_goods_number.localeCompare(b.representative_goods_number)
    );
    const regular = editions.find((e) => isRegularEdition(e.title)) ?? editions[0];
    const tracks = new Map<string, TrackInput>();
    for (const e of editions) {
      for (const disc of e.discs) {
        if (!isCdDisc(disc)) continue;
        for (const c of disc.contents) {
          if (!isSongTrack(c.title)) continue;
          const title = stripUnitCredit(c.title.replace(/\s+/g, " ").trim());
          const normalizedTitle = normalizeSongTitle(title);
          const t = tracks.get(normalizedTitle);
          if (t) {
            if (!t.editions.includes(e.representative_goods_number)) t.editions.push(e.representative_goods_number);
            continue;
          }
          tracks.set(normalizedTitle, {
            title,
            normalizedTitle,
            discNo: disc.disc_number,
            trackNo: c.track_number,
            editions: [e.representative_goods_number],
          });
        }
      }
    }
    out.push({
      title: stripEditionSuffix(regular.title),
      kind: KIND_OVERRIDES[regular.representative_goods_number] ?? (regular.type === "アルバム" ? "album" : "single"),
      releaseDate: toDateString(regular.release_date),
      artist: normalizeArtist(regular.artistName),
      sonyCode: regular.representative_goods_number,
      editions: editions.map((e) => ({ code: e.representative_goods_number, title: e.title })),
      tracks: [...tracks.values()].sort((a, b) => a.discNo - b.discNo || a.trackNo - b.trackNo),
    });
  }
  return out.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate) || a.sonyCode.localeCompare(b.sonyCode));
}
