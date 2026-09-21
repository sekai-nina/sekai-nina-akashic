/**
 * 既存の記事に「増えた分だけ」足す (#109)。
 *
 * `diff_dossier.py` の移植。**既存の本文・脚注番号・並び順には一切さわらない**のが鉄則で、
 * 編集者が手で入れた `![rep]` マーカーや `{q}…{/q}`、文章の微調整を壊さないため。
 *
 * DB に触らない純粋関数。`isPureAppend` で「既存行が消えていないこと」を機械的に検査する。
 */

import {
  MEETGREET_REPORTS_LAYOUT,
  normalizeSourceUrl,
  normalizeTweetUrl,
  type ArticleParts,
  type RenderedSource,
} from "./article";
import type { ExclusionKind } from "./types";

/**
 * 章の置き方 (#170)。テンプレートごとに違うのはここだけで、「まだ無いものだけ足す」規則は同じ。
 * 既定はミーグリ記事の形
 */
export interface AppendLayout {
  /**
   * 引用を入れる章の見出し。**null なら見出しを作らず本文の先頭の節 (地の文) の末尾に足す**
   * (言葉記事は引用そのものが本文で、章も出典行も持たない)
   */
  quotesHeading: string | null;
  /** 引用の後ろに `*引用: […]*^[n]` の出典行を置くか */
  quoteAttribution: boolean;
  /** ファンのレポの章 */
  reports: { heading: string; lead: string };
}

export const MEETGREET_APPEND_LAYOUT: AppendLayout = {
  quotesHeading: "## 本人の感想（ブログより）",
  quoteAttribution: true,
  reports: MEETGREET_REPORTS_LAYOUT,
};

const H_MEDIA = "## 関連メディア";
const H_TIKTOK = "### TikTok";
const H_TALK = "### トーク";
const H_BLOG_IMAGES = "### ブログ（画像）";

/** 見出しで区切った本文 */
interface Section {
  heading: string | null;
  lines: string[];
}

function parseSections(body: string): Section[] {
  const sections: Section[] = [{ heading: null, lines: [] }];
  for (const line of body.split("\n")) {
    if (/^#{2,3} /.test(line)) sections.push({ heading: line.trim(), lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }
  return sections;
}

/**
 * 節を本文に戻す。**末尾の空行を削らない。**
 * 削ると「既存の行が消えた」と判定され (isPureAppend)、本文末に空行が 2 つある記事は
 * 永久に追記できなくなる。
 */
function toBody(sections: Section[]): string {
  const out: string[] = [];
  for (const s of sections) {
    if (s.heading) out.push(s.heading);
    out.push(...s.lines);
  }
  const body = out.join("\n");
  return body.endsWith("\n") ? body : `${body}\n`;
}

/** 末尾の空行を除いた位置 (= 追記する場所) */
function appendIndex(lines: string[]): number {
  let i = lines.length;
  while (i > 0 && lines[i - 1].trim() === "") i--;
  return i;
}

function findSection(sections: Section[], heading: string): Section | undefined {
  return sections.find((s) => s.heading === heading);
}

/**
 * 見出しが無ければ作る。`after` に挙げた見出しの後ろ、`before` に挙げた見出しの前に置く
 * (節の並びを既定の順序に保つ)。
 */
function ensureSection(sections: Section[], heading: string, before: string[]): Section {
  const found = findSection(sections, heading);
  if (found) return found;
  // フル生成と同じく見出しの直後に空行を置く (両経路の出力を同じ形に保つ)
  const section: Section = { heading, lines: ["", ""] };
  const idx = sections.findIndex((s) => s.heading && before.includes(s.heading));
  if (idx >= 0) sections.splice(idx, 0, section);
  else sections.push(section);
  return section;
}

/** トークのタイトルから並べ替え用の値を作る ("… 2026.8.2 13:15" → "2026-08-02 13:15") */
export function talkSortKeyFromLine(line: string): string {
  const m = line.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})\s+(\d{1,2}):(\d{2})/);
  if (!m) return "";
  const [, y, mo, d, h, mi] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")} ${h.padStart(2, "0")}:${mi}`;
}

/** `^[12]` などの脚注番号を差し替える */
function renumber(line: string, map: Map<number, number>): string {
  return line.replace(/\^\[(\d+)\]/g, (whole, n) => {
    const to = map.get(Number(n));
    return to === undefined ? whole : `^[${to}]`;
  });
}

/** 行の末尾の `^[n]` から番号を取り出す */
function footnoteOf(line: string): number | null {
  const m = line.match(/\^\[(\d+)\]\s*$/);
  return m ? Number(m[1]) : null;
}

/** 抜粋の identity に使う先頭行 (重複判定と除外キーで同じものを使う) */
function quoteHead(excerpt: string): string {
  return excerpt.split("\n").find((l) => l.trim())?.trim() ?? "";
}

/** 脚注番号を外した行の中身 */
function lineCore(line: string): string {
  return line.replace(/\^\[\d+\]\s*$/, "").trim();
}

/**
 * その行が既に本文にあるか。**行ごとの完全一致で見る。**
 *
 * 部分一致 (`body.includes`) だと、`(n/m)` が付かない 1 枚だけのブログ画像の題
 * (`…「待ち合わせ」`) が `…「待ち合わせ」 (1/11)` に前方一致して取りこぼす。
 * アセット ID では判定できない: ブログ画像は 1 本のブログ (本文アセット) を出典として
 * 共有するので、画像自身の ID は出典に現れない。
 */
function hasLine(bodyLines: Set<string>, line: string): boolean {
  const core = lineCore(line);
  return core.length > 0 && bodyLines.has(core);
}

export interface ExistingSource {
  sourceNo: number | null;
  assetId: string | null;
  url: string | null;
}

/** 追記で足される 1 項目 (画面がチェックボックスを出すのに使う) */
export interface AppendItem {
  key: string;
  kind: ExclusionKind;
  /** 画面に出す短い説明 */
  label: string;
}

export interface AppendPlan {
  body: string;
  /** 追加する出典 (sourceNo は採番済み) */
  newSources: RenderedSource[];
  added: { quotes: number; reports: number; talks: number; blogImages: number; tiktoks: number };
  /** 足されるものの一覧。ここから外したものを除外リストに入れる */
  additions: AppendItem[];
  /** 何も増えなかった */
  empty: boolean;
}

/**
 * 「足さない」と決めたものを覚えるためのキー (#134)。
 *
 * 追記は「記事の本文に無い = まだ足していない」としか判断できないので、人が意図的に
 * 消したもの (X 側で削除されたレポなど) を外したことをここで覚える。
 *
 * **効くのは「これから足すもの」だけ。** 既に追記済みのものを後から外しても、そのとき
 * 作った `ArticleSource` は残る (手で本文の行を消した場合も同じで、これは #134 以前からの
 * 課題)。frontmatter から出典を取り下げるのは記事の編集画面から行う。
 */
export type { ExclusionKind } from "./types";

/** 文字列の短い指紋 (FNV-1a)。抜粋のキーに使う */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export function exclusionKey(kind: ExclusionKind, value: string): string {
  // ツイートは status ID だけで持つ。ユーザー名が変わっても、mobile.twitter.com 等の
  // 表記で入っても同じキーになる
  if (kind === "report") {
    const id = value.match(/\/status\/(\d+)/)?.[1];
    return `report:${id ?? normalizeTweetUrl(value)}`;
  }
  // video ID が取れない短縮 URL は記事に載らない (resolveTiktokUrl が落とす) ので、
  // ここに来るのは本来 ID 付きだけ。念のため URL そのままで持つ
  if (kind === "tiktok") return `tiktok:${tiktokVideoId(value) ?? value}`;
  // 抜粋は**先頭行**で見る。重複判定も先頭行なので identity を揃える
  // (下の行を直しただけで別キーになると、除外したはずの引用が復活する)
  if (kind === "quote") return `quote:${fingerprint(quoteHead(value))}`;
  return `asset:${value}`; // talk / blogImage はアセット単位
}

/** TikTok の URL から video ID を取り出す (短縮 URL からは取れない) */
export function tiktokVideoId(url: string): string | null {
  return url.match(/\/video\/(\d+)/)?.[1] ?? null;
}

/**
 * 既存の本文に、まだ載っていないものだけを足す。
 *
 * 出典は**末尾に番号を足すだけ**で、既存の番号は絶対に振り直さない (`^[N]` がずれるため)。
 */
export function planAppend(input: {
  existingBody: string;
  parts: ArticleParts;
  /** フル生成したときの出典 (assetId / url で既存と突き合わせる) */
  sources: RenderedSource[];
  existingSources: ExistingSource[];
  /** 「足さない」と決めたもののキー (#134) */
  excluded?: readonly string[];
  /** 章の置き方。省略時はミーグリ記事の形 */
  layout?: AppendLayout;
}): AppendPlan {
  const { existingBody, parts } = input;
  const layout = input.layout ?? MEETGREET_APPEND_LAYOUT;
  const H_QUOTES = layout.quotesHeading;
  const H_REPORTS = layout.reports.heading;
  const excluded = new Set(input.excluded ?? []);
  const additions: AppendItem[] = [];
  /** 除外されていなければ一覧に足して true を返す */
  const takenKeys = new Set<string>();
  const take = (kind: ExclusionKind, value: string, label: string): boolean => {
    const key = exclusionKey(kind, value);
    if (excluded.has(key)) return false;
    const dup = takenKeys.has(key);
    takenKeys.add(key);
    // **キーが同じなら同じもの** — ドシエに同じレポが x.com と twitter.com の 2 表記で
    // 入っていると、同じ行が 2 本並ぶ。落とす
    if (dup && kind !== "quote") return false;
    // 抜粋だけは別扱い。キーは**先頭行**の指紋なので、先頭行が同じ別の抜粋がありうる。
    // 落とすと本文が欠けるので両方足し、チェックボックスは 1 つにまとめる
    // (連動して見えるのを避ける。外せばどちらも足さない)
    if (!dup) additions.push({ key, kind, label });
    return true;
  };

  // 既に本文にある行 (脚注番号を外したもの)。トーク / ブログ画像の重複判定に使う
  const bodyLines = new Set(existingBody.split("\n").map(lineCore).filter((l) => l.length > 0));
  const sections = parseSections(existingBody);
  const added = { quotes: 0, reports: 0, talks: 0, blogImages: 0, tiktoks: 0 };

  // --- 1. 何を足すか決める (ここで除外を効かせる) ---

  const freshQuotes = parts.quotes
    .map((q) => ({
      ...q,
      excerpts: q.excerpts.filter((ex) => {
        const head = quoteHead(ex);
        if (head.length === 0 || existingBody.includes(head)) return false;
        return take("quote", ex, `引用「${head.slice(0, 24)}…」`);
      }),
    }))
    .filter((q) => q.excerpts.length > 0);

  const seenReports = new Set(
    (existingBody.match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^\s)]+/g) ?? []).map(normalizeTweetUrl)
  );
  const freshReports = parts.reports.filter(
    (u) => !seenReports.has(normalizeTweetUrl(u)) && take("report", u, `レポ ${u}`)
  );

  // TikTok は **video ID で突き合わせる** (ドシエには短縮 URL、記事には解決済みの URL が
  // 載るので、URL の文字列比較だと毎回「新規」になる)
  const freshTiktoks = parts.tiktoks.filter((u) => {
    const id = tiktokVideoId(u);
    const already = id ? existingBody.includes(id) : existingBody.includes(normalizeTweetUrl(u));
    return !already && take("tiktok", u, `TikTok ${u}`);
  });

  const freshTalks = parts.talks.filter(
    (t) => !hasLine(bodyLines, t.line) && take("talk", t.assetId, lineCore(t.line))
  );

  const freshImages = parts.blogImages.filter(
    (b) => !hasLine(bodyLines, b.line) && take("blogImage", b.assetId, lineCore(b.line))
  );

  // --- 2. 足すものが参照する出典にだけ番号を振る ---
  //
  // **除外したものの出典を作らないこと。** 本文から消えても ArticleSource が残ると、
  // 記事の frontmatter に載って公開リポジトリに push されてしまう (#134 が防ぎたい漏れ)。
  // 番号は applySources が max+1 で順に採るので、飛び番を作らないことも大事。
  const neededSourceNos = new Set<number>();
  for (const q of freshQuotes) neededSourceNos.add(q.sourceNo);
  for (const b of freshImages) {
    const n = footnoteOf(b.line);
    if (n !== null) neededSourceNos.add(n);
  }
  // トークも**本文の `^[n]` から引く** (画像と同じ)。assetId で引くと、突き合わせが
  // 外れたときに行だけ出て宛先の無い脚注が残る
  for (const t of freshTalks) {
    const n = footnoteOf(t.line);
    if (n !== null) neededSourceNos.add(n);
  }

  const byAsset = new Map<string, number>();
  const byUrl = new Map<string, number>();
  let maxNo = 0;
  for (const e of input.existingSources) {
    if (e.sourceNo == null) continue;
    maxNo = Math.max(maxNo, e.sourceNo);
    if (e.assetId) byAsset.set(e.assetId, e.sourceNo);
    if (e.url) byUrl.set(normalizeSourceUrl(e.url), e.sourceNo);
  }
  const renumberMap = new Map<number, number>();
  const newSources: RenderedSource[] = [];
  for (const s of input.sources) {
    const hit =
      (s.assetId ? byAsset.get(s.assetId) : undefined) ??
      (s.url ? byUrl.get(normalizeSourceUrl(s.url)) : undefined);
    if (hit !== undefined) {
      renumberMap.set(s.sourceNo, hit);
      continue;
    }
    if (!neededSourceNos.has(s.sourceNo)) continue; // 足すものが無い出典は作らない
    maxNo += 1;
    renumberMap.set(s.sourceNo, maxNo);
    newSources.push({ ...s, sourceNo: maxNo });
  }

  // --- 3. 本文に差し込む ---

  if (freshQuotes.length > 0) {
    // 見出しが無い形 (言葉記事) は先頭の節 = 地の文の末尾に足す
    const sec = H_QUOTES ? ensureSection(sections, H_QUOTES, [H_REPORTS, H_MEDIA]) : sections[0];
    let at = appendIndex(sec.lines);
    const lines: string[] = [];
    // 引用はブロックなので、前の行と空行で区切る。区切らないと直前の引用と 1 つの
    // ブロックに繋がる (言葉記事は抜粋ごとに空行で分けるのが形)。
    // 節を作ったばかり (= 空行だけ) なら見出し直後の空行は残して、その次に入れる
    if (at === 0 && sec.lines[0]?.trim() === "") at = 1;
    else if (at > 0 && sec.lines[at - 1].trim() !== "") lines.push("");
    for (const q of freshQuotes) {
      for (const ex of q.excerpts) {
        lines.push(ex.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
        lines.push("");
        added.quotes++;
      }
      if (layout.quoteAttribution) {
        lines[lines.length - 1] = `*引用: [${q.label}（${q.date}）](${q.url})*^[${renumberMap.get(q.sourceNo) ?? q.sourceNo}]`;
        lines.push("");
      }
    }
    sec.lines.splice(at, 0, ...lines);
  }

  if (freshReports.length > 0) {
    const sec = ensureSection(sections, H_REPORTS, [H_MEDIA]);
    if (sec.lines.every((l) => l.trim() === "")) {
      sec.lines = ["", layout.reports.lead, ""];
    }
    sec.lines.splice(appendIndex(sec.lines), 0, ...freshReports.map((u) => `![](${u})`));
    added.reports = freshReports.length;
  }

  if (freshTiktoks.length > 0) {
    ensureSection(sections, H_MEDIA, []);
    const sec = ensureSection(sections, H_TIKTOK, [H_TALK, H_BLOG_IMAGES]);
    sec.lines.splice(appendIndex(sec.lines), 0, ...freshTiktoks.map((u) => `![](${u})`));
    added.tiktoks = freshTiktoks.length;
  }

  // トークは時系列の正しい位置に差し込む (脚注番号は飛んでよい。順序 > 番号の連続性)
  if (freshTalks.length > 0) {
    ensureSection(sections, H_MEDIA, []);
    const sec = ensureSection(sections, H_TALK, [H_BLOG_IMAGES]);
    for (const t of freshTalks) {
      const line = renumber(t.line, renumberMap);
      const key = talkSortKeyFromLine(t.line);
      let at = appendIndex(sec.lines);
      if (key) {
        for (let i = 0; i < sec.lines.length; i++) {
          const k = talkSortKeyFromLine(sec.lines[i]);
          if (k && k > key) {
            at = i;
            break;
          }
        }
      }
      sec.lines.splice(at, 0, line);
      added.talks++;
    }
  }

  if (freshImages.length > 0) {
    ensureSection(sections, H_MEDIA, []);
    const sec = ensureSection(sections, H_BLOG_IMAGES, []);
    sec.lines.splice(
      appendIndex(sec.lines),
      0,
      ...freshImages.map((b) => renumber(b.line, renumberMap))
    );
    added.blogImages = freshImages.length;
  }

  const total = added.quotes + added.reports + added.talks + added.blogImages + added.tiktoks;
  return {
    body: toBody(sections),
    newSources,
    added,
    additions,
    empty: total === 0 && newSources.length === 0,
  };
}

/**
 * 既存の行がすべて残っているか (= 純粋な追記か)。
 * 1 行でも消えていたら適用しない。`![rep]` や `{q}` の手編集を守るための最後の砦。
 */
export function isPureAppend(before: string, after: string): boolean {
  const a = before.split("\n");
  const b = after.split("\n");
  let i = 0;
  for (const line of b) {
    if (i < a.length && a[i] === line) i++;
  }
  return i === a.length;
}

/** 追記でどの行が増えたかを行単位で返す (画面に差分を出す用) */
export function appendDiff(before: string, after: string): { added: number[]; lines: string[] } {
  const a = before.split("\n");
  const b = after.split("\n");
  const added: number[] = [];
  let i = 0;
  for (let j = 0; j < b.length; j++) {
    if (i < a.length && a[i] === b[j]) i++;
    else added.push(j);
  }
  return { added, lines: b };
}
