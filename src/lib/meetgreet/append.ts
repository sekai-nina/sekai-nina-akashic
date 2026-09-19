/**
 * 既存の記事に「増えた分だけ」足す (#109)。
 *
 * `diff_dossier.py` の移植。**既存の本文・脚注番号・並び順には一切さわらない**のが鉄則で、
 * 編集者が手で入れた `![rep]` マーカーや `{q}…{/q}`、文章の微調整を壊さないため。
 *
 * DB に触らない純粋関数。`isPureAppend` で「既存行が消えていないこと」を機械的に検査する。
 */

import type { ArticleParts, RenderedSource } from "./article";

const H_QUOTES = "## 本人の感想（ブログより）";
const H_REPORTS = "## ファンによるミーグリレポ";
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

function toBody(sections: Section[]): string {
  const out: string[] = [];
  for (const s of sections) {
    if (s.heading) out.push(s.heading);
    out.push(...s.lines);
  }
  return out.join("\n").replace(/\n+$/, "") + "\n";
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
  const section: Section = { heading, lines: [""] };
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

/** 行の中身 (脚注番号を除いた部分) が既に本文にあるか */
function hasLine(body: string, line: string): boolean {
  const core = line.replace(/\^\[\d+\]\s*$/, "").trim();
  return core.length > 0 && body.includes(core);
}

export interface ExistingSource {
  sourceNo: number | null;
  assetId: string | null;
  url: string | null;
}

export interface AppendPlan {
  body: string;
  /** 追加する出典 (sourceNo は採番済み) */
  newSources: RenderedSource[];
  added: { quotes: number; reports: number; talks: number; blogImages: number; tiktoks: number };
  /** 何も増えなかった */
  empty: boolean;
}

/** TikTok の URL から video ID を取り出す (短縮 URL からは取れない) */
export function tiktokVideoId(url: string): string | null {
  return url.match(/\/video\/(\d+)/)?.[1] ?? null;
}

/** X の URL を比べるための正規化 */
function normUrl(url: string): string {
  return url.trim().split("?")[0].replace(/\/+$/, "").replace(/^https?:\/\/(www\.)?twitter\.com\//, "https://x.com/");
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
}): AppendPlan {
  const { existingBody, parts } = input;

  // 1. 出典の対応づけ: 既存にあるものはその番号、無いものは末尾に採番
  const byAsset = new Map<string, number>();
  const byUrl = new Map<string, number>();
  let maxNo = 0;
  for (const e of input.existingSources) {
    if (e.sourceNo == null) continue;
    maxNo = Math.max(maxNo, e.sourceNo);
    if (e.assetId) byAsset.set(e.assetId, e.sourceNo);
    if (e.url) byUrl.set(normUrl(e.url), e.sourceNo);
  }
  const renumberMap = new Map<number, number>();
  const newSources: RenderedSource[] = [];
  for (const s of input.sources) {
    const hit =
      (s.assetId ? byAsset.get(s.assetId) : undefined) ??
      (s.url ? byUrl.get(normUrl(s.url)) : undefined);
    if (hit !== undefined) {
      renumberMap.set(s.sourceNo, hit);
      continue;
    }
    maxNo += 1;
    renumberMap.set(s.sourceNo, maxNo);
    newSources.push({ ...s, sourceNo: maxNo });
  }

  const sections = parseSections(existingBody);
  const added = { quotes: 0, reports: 0, talks: 0, blogImages: 0, tiktoks: 0 };

  // 2. 本人の感想: 本文に無い抜粋だけを足す
  const freshQuotes = parts.quotes
    .map((q) => ({
      ...q,
      excerpts: q.excerpts.filter((ex) => {
        const head = ex.split("\n").find((l) => l.trim())?.trim() ?? "";
        return head.length > 0 && !existingBody.includes(head);
      }),
    }))
    .filter((q) => q.excerpts.length > 0);
  if (freshQuotes.length > 0) {
    const sec = ensureSection(sections, H_QUOTES, [H_REPORTS, H_MEDIA]);
    const at = appendIndex(sec.lines);
    const lines: string[] = [];
    for (const q of freshQuotes) {
      for (const ex of q.excerpts) {
        lines.push(ex.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
        lines.push("");
        added.quotes++;
      }
      lines[lines.length - 1] = `*引用: [${q.label}（${q.date}）](${q.url})*^[${renumberMap.get(q.sourceNo) ?? q.sourceNo}]`;
      lines.push("");
    }
    sec.lines.splice(at, 0, ...lines);
  }

  // 3. レポ: 末尾に足す
  const seenReports = new Set(
    (existingBody.match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/[^\s)]+/g) ?? []).map(normUrl)
  );
  const freshReports = parts.reports.filter((u) => !seenReports.has(normUrl(u)));
  if (freshReports.length > 0) {
    const sec = ensureSection(sections, H_REPORTS, [H_MEDIA]);
    if (sec.lines.every((l) => l.trim() === "")) {
      sec.lines = ["", "ファンが投稿したミート＆グリートの感想（X）。", ""];
    }
    sec.lines.splice(appendIndex(sec.lines), 0, ...freshReports.map((u) => `![](${u})`));
    added.reports = freshReports.length;
  }

  // 4. TikTok。**video ID で突き合わせる** (ドシエには短縮 URL (vt.tiktok.com)、
  // 記事には解決済みの URL が載るので、URL の文字列比較だと毎回「新規」になる)
  const freshTiktoks = parts.tiktoks.filter((u) => {
    const id = tiktokVideoId(u);
    if (id) return !existingBody.includes(id);
    return !existingBody.includes(normUrl(u));
  });
  if (freshTiktoks.length > 0) {
    ensureSection(sections, H_MEDIA, []);
    const sec = ensureSection(sections, H_TIKTOK, [H_TALK, H_BLOG_IMAGES]);
    sec.lines.splice(appendIndex(sec.lines), 0, ...freshTiktoks.map((u) => `![](${u})`));
    added.tiktoks = freshTiktoks.length;
  }

  // 5. トーク: 時系列の正しい位置に差し込む (脚注番号は飛んでよい。順序 > 番号の連続性)
  const freshTalks = parts.talks.filter((t) => !hasLine(existingBody, t.line));
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

  // 6. ブログ画像: 末尾に足す
  const freshImages = parts.blogImages.filter((b) => !hasLine(existingBody, b.line));
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
