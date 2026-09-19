/**
 * 過去のドシエ・X コレクションを MeetGreet として取り込む (#118)。
 *
 * `/meetgreets` を作る前から、ミーグリごとにドシエを手で作って X レポも集めてあった。
 * その 35 件ぶんを拾い直すための解析。DB に触らない純粋関数なのでテストがある。
 */

import type { MeetGreetFormat } from "@prisma/client";

/**
 * ドシエ名から日付・呼び分け・形式を読む。
 * 手作業時代の命名は `2026-08-01 京都リアミ` / `2026-08-09 通常オンミ` の形で、
 * 呼び分けは 通常 / 初限 / 全国 / 通常版 / 京都 / 横浜 / 幕張 と揺れるが形自体は崩れていない。
 */
const DOSSIER_TITLE_RE = /^(\d{4}-\d{2}-\d{2})\s*(.*?)(オンミ|リアミ)$/;

export interface ParsedDossierTitle {
  date: string;
  label: string;
  format: MeetGreetFormat;
}

export function parseDossierTitle(title: string): ParsedDossierTitle | null {
  const m = title.trim().match(DOSSIER_TITLE_RE);
  if (!m) return null;
  const [, date, label, kind] = m;
  // 実在しない日付 (2026-02-30 等) は弾く
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) return null;
  return { date, label: label.trim(), format: kind === "オンミ" ? "online" : "real" };
}

/**
 * X コレクション名からシングル名を読み、記事 frontmatter の表記に揃える。
 *
 * 収集の名前は `17th『Kind of love』…` と `17thシングル『Kind of love』…` が混在している。
 * 公開サイトの記事 (`meetgreet.single`) は `17thシングル「Kind of love」` の形なので、
 * **「シングル」を補い、括弧を「」に揃える**。
 */
const SINGLE_RE = /(\d+)\s*th\s*(?:シングル)?\s*[『「]([^』」]+)[』」]/;

export function parseSingleFromCollectionName(name: string): string {
  const m = name.match(SINGLE_RE);
  if (!m) return "";
  return `${m[1]}thシングル「${m[2]}」`;
}
