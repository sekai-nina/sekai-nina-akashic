/**
 * 公演のセットリスト (全曲) の純粋関数。**クライアント部品からも読むので zod / DB を持ち込まない。**
 *
 * - `parseSetlistText`: 公式・ファンの投稿から貼ったセトリの文字列を曲の行にする
 * - `deriveLiveSongs`: 公演ごとのセトリから、LiveSong (共通披露曲 / 追加曲 / センター曲) を組み直す
 */

/** 本編は空文字。アンコール類はこの表記に寄せる */
export const SETLIST_SECTIONS = ["", "アンコール", "Wアンコール"] as const;

/** 1 公演のセトリに入れられる曲数 (アンコール込みで 30 前後) */
export const MAX_SETLIST_ITEMS = 80;

export interface ParsedSetlistLine {
  title: string;
  /** 「アンコール」「Wアンコール」。本編は空 */
  section: string;
}

/** 見出し行 (「アンコール」「-ENCORE-」「【本編】」) を区切りの表記にする。見出しでなければ null */
function sectionHeading(line: string): string | null {
  const t = line
    .normalize("NFKC")
    .replace(/^[\s\-–—=＝~〜【\[<＜(（]+|[\s\-–—=＝~〜】\]>＞)）:：]+$/g, "")
    .trim()
    .toLowerCase();
  if (/^(本編|main)$/.test(t)) return "";
  if (/^(w|ダブル|double)\s*(アンコール|encore|en)$/.test(t)) return "Wアンコール";
  if (/^(アンコール|encore|en)$/.test(t)) return "アンコール";
  return null;
}

/** 曲ではない行 (MC・VTR・Overture など)。番号を落としたあとの文字列で判定する */
const NOT_A_SONG = /^(mc\d*|vtr\d*|overture|over ture|se|影ナレ|開演|終演|幕間|interlude|ダンストラック|dance track)$/i;

/**
 * 貼ったセトリを曲の行にする。
 *
 * - 1 行 1 曲。「M1」「01.」「EN1」「WEN1」「1曲目」などの番号は落とす (EN / WEN はアンコールの印にする)
 * - 「アンコール」「-ENCORE-」などの見出し行から後ろをその区切りにする
 * - 改行が無く「A / B / C」で区切ってあれば、それで割る
 * - MC・VTR・Overture・空行・「※」で始まる注記は落とす。同じ曲が 2 回あれば 2 行のまま (再披露)
 */
export function parseSetlistText(text: string): ParsedSetlistLine[] {
  const raw = text.replace(/\r\n?/g, "\n").trim();
  if (!raw) return [];
  const lines = raw.includes("\n") ? raw.split("\n") : raw.split(/\s*[/／]\s*/);

  const out: ParsedSetlistLine[] = [];
  let section = "";
  for (const line of lines) {
    const trimmed = line.replace(/\s+/g, " ").trim();
    if (!trimmed || /^[※*＊#＃]/.test(trimmed)) continue;
    const heading = sectionHeading(trimmed);
    if (heading !== null) {
      section = heading;
      continue;
    }
    let lineSection = section;
    let title = trimmed;
    // 番号の前置き。EN / WEN はアンコールの印でもある (見出しの無いセトリに多い)
    // 印 (M / EN / WEN) があれば番号の後ろの区切りは任意。数字だけのときは区切りか空白を要る
    // (「21世紀〜」のように数字で始まる曲名の頭を削らない)
    const tagged = title.match(/^(W\s*EN|EN|M|E)\s*[0-9０-９]+\s*[.．:：)）\]】\-－、]?\s*(.+)$/i);
    const numbered = tagged ? null : title.match(/^[0-9０-９]+\s*(?:曲目|[.．:：)）\]】\-－、]|\s)\s*(.+)$/);
    if (tagged) {
      const tag = tagged[1].replace(/\s/g, "").toUpperCase();
      if (tag === "WEN") lineSection = "Wアンコール";
      else if (tag === "EN" || tag === "E") lineSection = lineSection || "アンコール";
      title = tagged[2].trim();
    } else if (numbered) {
      title = numbered[1].trim();
    }
    if (!title || NOT_A_SONG.test(title.normalize("NFKC").trim())) continue;
    out.push({ title, section: lineSection });
  }
  return out.slice(0, MAX_SETLIST_ITEMS);
}

/** セトリの 1 曲 (派生の計算に要るものだけ) */
export interface SetlistEntry {
  songId: string;
  participated: boolean;
  center: boolean;
}

export interface PerformanceSongsInput {
  id: string;
  /** セトリ (順番どおり)。無い公演は null で、従来の手入力 (legacy) を使う */
  setlist: SetlistEntry[] | null;
  /** 手入力の公演限定の曲 (セトリが無いときだけ見る) */
  legacySongs: string[];
  legacyCenter: string[];
}

export interface DerivedLiveSongs {
  /** 全公演で披露した曲 (最初の公演の順) */
  common: string[];
  /** 公演ごとの追加曲とセンター曲 */
  performances: { id: string; songs: string[]; centerSongs: string[] }[];
}

const uniq = (list: readonly string[]) => [...new Set(list)];

/**
 * 公演ごとの「坂井新奈が出た曲」から LiveSong の形を組み直す (値は songId)。
 *
 * セトリのある公演は参加した曲 (センター曲は必ず参加扱い)、無い公演は従来の手入力
 * (共通披露曲 + 追加曲) をその公演の曲とみなす。共通披露曲は全公演の共通部分、追加曲は残り。
 * 公演が 1 つなら全部が共通披露曲になる (ミニライブ等の今までの入れ方と同じ)
 */
export function deriveLiveSongs(performances: PerformanceSongsInput[], legacyCommon: string[]): DerivedLiveSongs {
  const sets = performances.map((p) => {
    if (!p.setlist) {
      return { id: p.id, performed: uniq([...legacyCommon, ...p.legacySongs]), center: uniq(p.legacyCenter) };
    }
    return {
      id: p.id,
      performed: uniq(p.setlist.filter((s) => s.participated || s.center).map((s) => s.songId)),
      center: uniq(p.setlist.filter((s) => s.center).map((s) => s.songId)),
    };
  });
  if (sets.length === 0) return { common: [], performances: [] };
  const common = sets[0].performed.filter((id) => sets.every((s) => s.performed.includes(id)));
  return {
    common,
    performances: sets.map((s) => ({
      id: s.id,
      songs: s.performed.filter((id) => !common.includes(id)),
      centerSongs: s.center,
    })),
  };
}
