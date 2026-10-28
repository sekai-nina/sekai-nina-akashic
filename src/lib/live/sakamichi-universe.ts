/**
 * Sakamichi Universe (https://meaning-of-goodbye.com/sakamichi-search/) からセトリを読む。
 *
 * 個人運営の坂道シリーズのデータベース。About で「データベースはオープンデータととらえて差し支えない、
 * 常識の範囲内で自由に利用してよい (報告不要)」とされている。出典として必ず名前と各ライブのページを残す
 * (公演の setlistSource)。叩くのは公開 REST (wp-json/sakamichi-universe/v1) で、1 公演 1 回だけ。
 *
 * 備考欄 (remark) は人が書いた自由文で、「C坂井」(センター)・「2-4期生+坂井」・「平尾・蔵盛・坂井・鶴崎」
 * のように、その曲に誰が出たかが書いてある。ここから坂井新奈の参加とセンターを推す (analyzeRemark)。
 * 備考が空なら「いつもの編成」なので、坂井新奈の参加楽曲 (fetchSuParticipationTitles) にあれば参加とみなす
 * (呼び出し側の既定。5 期生のライブ・ひなた坂46 LIVE は全曲参加)。
 *
 * fetch 以外は純粋関数 (テストは sakamichi-universe.test.ts)。
 */

export const SU_SOURCE_LABEL = "Sakamichi Universe";
const SU_API = "https://meaning-of-goodbye.com/wp-json/sakamichi-universe/v1";
const SU_GROUP = "hinata";
/** 備考で坂井新奈を指す書き方 (日向坂に坂井は 1 人) */
const NINA = "坂井";
/** Sakamichi Universe の坂井新奈のメンバー ID */
const NINA_SU_ID = 42;

export interface SuLive {
  livedate: string;
  /** "18:30:00" */
  starttime: string;
  title: string;
  stage: string;
  html_url: string;
  is_cancelled: boolean;
}

export interface SuSetlistItem {
  /** "1." / "EN1." / "WEN1." */
  order: string;
  title: string;
  remark: string;
}

async function suGet<T>(path: string): Promise<T> {
  // 開演時刻のコロンは %3A にすると 404 になる (WordPress の経路の正規表現が生のコロンを要る)
  const res = await fetch(`${SU_API}${path}`, {
    headers: { "User-Agent": "sekai-nina-akashic (setlist import; https://sekai-nina.com)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Sakamichi Universe ${res.status} ${path}`);
  return (await res.json()) as T;
}

/** 日向坂のライブを新しい順に、since (YYYY-MM-DD) より古いページに入るまで読む */
export async function fetchSuLives(since: string): Promise<SuLive[]> {
  const out: SuLive[] = [];
  for (let page = 1; page <= 20; page++) {
    const data = await suGet<{ items: SuLive[]; meta: { has_more: boolean } }>(
      `/lives?group=${SU_GROUP}&per_page=100&page=${page}`
    );
    out.push(...data.items);
    const oldest = data.items[data.items.length - 1]?.livedate ?? "";
    if (!data.meta.has_more || oldest < since) break;
  }
  return out.filter((l) => l.livedate >= since);
}

export async function fetchSuSetlist(live: Pick<SuLive, "livedate" | "starttime">): Promise<SuSetlistItem[]> {
  const data = await suGet<{ items: SuSetlistItem[] }>(
    `/lives/${SU_GROUP}/${live.livedate}/${live.starttime}/setlist?per_page=100`
  );
  return data.items;
}

/** 坂井新奈の参加楽曲 (CD の歌唱メンバーに入っている曲) の曲名 */
export async function fetchSuParticipationTitles(): Promise<string[]> {
  const data = await suGet<{ items: { title: string }[] }>(
    `/members/${SU_GROUP}/${NINA_SU_ID}/participation-songs?per_page=100`
  );
  return data.items.map((s) => s.title);
}

/** 「EN1.」→ アンコール、「WEN1.」→ Wアンコール、ほかは本編 */
export function sectionOfOrder(order: string): string {
  const t = order.trim().toUpperCase();
  if (t.startsWith("WEN")) return "Wアンコール";
  if (t.startsWith("EN")) return "アンコール";
  return "";
}

export interface RemarkReading {
  center: boolean;
  /** ほかの人がセンター (「C松尾」)。坂井新奈のセンターを既定から足さない */
  otherCenter: boolean;
  /** true / false は備考から読めた。null は読めない (既定に任せる) */
  participated: boolean | null;
  /** 判断の根拠 (dry-run と画面に出す) */
  reason: string;
}

// 1〜4 文字の名前を「・」でつないだ並び (「平尾・蔵盛・坂井・鶴崎」)。「〜はスタンドマイク」のような文は外す
const NAME = "[一-龥々ぁ-んァ-ヶー]{1,4}";
const NAME_LIST = new RegExp(`^${NAME}(・${NAME})+$`);
const SOLO = new RegExp(`^${NAME}ソロ$`);

/**
 * 備考から坂井新奈のセンター・参加を読む。
 *
 * - 「C〜」の並びに坂井があればセンター (W センター「C坂井・鶴崎」も)。センターは参加扱い
 * - 坂井の名前がどこかにある・「全員」・5 期生を含む期の指定 → 参加
 * - 坂井の無い名前の並び・「〜ソロ」・5 期生を含まない期の指定・「オリメン」→ 不参加
 * - 「C大野・松尾」(センターだけ) や演出の説明だけなら読めない (null)
 */
export function analyzeRemark(remark: string): RemarkReading {
  const text = remark
    .normalize("NFKC")
    // 「［メンバーシャッフルメドレー］」「（柿崎・齊藤を除く）」「「なんでも知りたGirl」」は誰が出たかではない
    .replace(/\[[^\]]*\]|［[^］]*］|\([^)]*\)|（[^）]*）|「[^」]*」/g, "")
    .trim();
  if (!text) return { center: false, otherCenter: false, participated: null, reason: "" };

  let center = false;
  let otherCenter = false;
  let joined = false;
  let excluded: string | null = null;
  for (const raw of text.split(/[／/、,]/)) {
    let seg = raw.trim();
    if (!seg) continue;
    // 「C松田+5期生」「C坂井・鶴崎」: + の前がセンター
    const c = seg.match(/^C([^+＋]+)(?:[+＋](.*))?$/);
    if (c) {
      if (c[1].split("・").includes(NINA)) center = true;
      else otherCenter = true;
      seg = (c[2] ?? "").trim();
      if (!seg) continue;
    }
    if (seg.includes(NINA)) joined = true;
    if (seg.includes("全員")) joined = true;
    // 「2-4期生」「5期生」「4期生+大田・大野」「OGを含む1期生」「2-4期」
    for (const g of seg.matchAll(/(\d)(?:-(\d))?期/g)) {
      const from = Number(g[1]);
      const to = g[2] ? Number(g[2]) : from;
      if (from <= 5 && 5 <= to) joined = true;
      else excluded ??= `${g[0]}生の曲`;
    }
    if (NAME_LIST.test(seg) || SOLO.test(seg)) excluded ??= `${seg} の曲`;
    if (seg.startsWith("オリメン")) excluded ??= "オリジナルメンバーの曲";
  }
  if (center) return { center, otherCenter, participated: true, reason: "備考にセンター坂井" };
  if (joined) return { center, otherCenter, participated: true, reason: "備考に坂井・全員・5期生" };
  if (excluded) return { center, otherCenter, participated: false, reason: `備考: ${excluded}` };
  return { center, otherCenter, participated: null, reason: "" };
}

/**
 * Akashic の公演に当たる Sakamichi Universe のライブを選ぶ。同じ日が 1 つならそれ、
 * 昼夜 2 回なら公演の呼び分け (「昼」「夜」/「1公演目」) で選ぶ。選べなければ候補を全部返す
 */
export function matchSuLive(
  perf: { date: string; label: string },
  lives: SuLive[]
): { live: SuLive | null; candidates: SuLive[] } {
  const sameDay = lives
    .filter((l) => l.livedate === perf.date && !l.is_cancelled)
    .sort((a, b) => a.starttime.localeCompare(b.starttime));
  if (sameDay.length === 1) return { live: sameDay[0], candidates: sameDay };
  if (sameDay.length === 0) return { live: null, candidates: [] };
  const label = perf.label.normalize("NFKC");
  let pick: SuLive | undefined;
  if (/昼|午前|1公演目|第1部|一部/.test(label)) pick = sameDay[0];
  else if (/夜|午後|2公演目|第2部|二部/.test(label)) pick = sameDay[sameDay.length - 1];
  return { live: pick ?? null, candidates: sameDay };
}

export interface SuSetlistRow {
  title: string;
  section: string;
  participated: boolean;
  center: boolean;
  remark: string;
  /** 参加をどう決めたか */
  reason: string;
}

export interface FallbackReading {
  participated: boolean;
  /** 既定でもセンター (今の記録など)。備考がほかの人をセンターにしていれば使わない */
  center?: boolean;
  reason: string;
}

/**
 * Sakamichi Universe のセトリを公演のセトリの行にする。備考で読めない曲の参加は fallback (曲名 → 参加か) に任せる。
 * センターは備考の「C坂井」か、備考がほかの人をセンターにしていないときの fallback のセンター
 */
export function toSetlistRows(items: SuSetlistItem[], fallback: (title: string) => FallbackReading): SuSetlistRow[] {
  return items.map((it) => {
    const r = analyzeRemark(it.remark);
    const fb = fallback(it.title);
    const base = r.participated === null ? fb : { participated: r.participated, reason: r.reason };
    const center = r.center || (!r.otherCenter && fb.center === true);
    return {
      title: it.title.trim(),
      section: sectionOfOrder(it.order),
      participated: base.participated || center,
      center,
      remark: it.remark,
      reason: base.reason,
    };
  });
}

/**
 * 坂井新奈の出る顔ぶれ全員で全曲をやるライブ (5 期生のライブ・ひなた坂46 LIVE) か。
 * 備考が「C小西」のようにセンターだけなら全員で披露しているので、読めない曲は参加にする
 */
export function isWholeLineupLive(title: string): boolean {
  return /五期生|5期生|ひなた坂46\s*LIVE/i.test(title.normalize("NFKC"));
}
