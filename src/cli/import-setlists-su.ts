/**
 * 過去の公演のセトリを Sakamichi Universe からまとめて入れる。
 *
 * 1. Akashic の全ライブの公演を、Sakamichi Universe のライブと日付 (昼夜は公演の呼び分け) で突き合わせる
 * 2. 公演ごとにセトリを読み、参加 (備考 → 全員で披露するライブか → 坂井新奈の参加楽曲) とセンター (備考の「C坂井」) を付ける
 * 3. 今の披露曲 (共通披露曲 + 追加曲・センター曲) と比べた差をレポートに書く
 * 4. --apply のときだけ replacePerformanceSetlist で保存する (出典は Sakamichi Universe とそのライブのページ)
 *
 * 既にセトリのある公演は飛ばす (--overwrite で上書き)。Sakamichi Universe へは 1 公演 1 回、1 秒あけて読む。
 * 書き込みは画面と同じ経路 (withSession + 監査ログ) で、--as のユーザーとして書く。
 *
 * Usage:
 *   pnpm cli:import-setlists-su [--out report.md] [--live <liveId>] [--overwrite] [--apply] [--as <email>]
 */

import "dotenv/config";
import { writeFileSync } from "node:fs";
import { prismaInternal } from "../lib/db";
import { previewSuSetlist } from "../lib/domain/live-su";
import { listLives, replacePerformanceSetlist } from "../lib/domain/lives";
import { listSongKeys, listSongParticipation } from "../lib/domain/songs";
import { fetchSuLives, fetchSuParticipationTitles } from "../lib/live/sakamichi-universe";
import { normalizeSongTitle } from "../lib/songs/normalize";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const apply = flag("--apply");
const overwrite = flag("--overwrite");
const onlyLive = opt("--live");
const out = opt("--out") ?? "setlist-su-report.md";
const asEmail = opt("--as");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function actingUser() {
  const users = await prismaInternal.user.findMany({
    where: asEmail ? { email: asEmail } : { role: "admin" },
    select: { id: true, email: true, role: true, clearance: true },
  });
  if (users.length !== 1) {
    console.error(asEmail ? `ユーザーが見つかりません: ${asEmail}` : "admin が 1 人ではありません。--as <email> で指定してください");
    process.exit(1);
  }
  return users[0];
}

async function main() {
  const user = await actingUser();
  const [lives, participation, songKeys] = await Promise.all([
    listLives(user),
    listSongParticipation(),
    listSongKeys(),
  ]);
  const known = new Set(songKeys);
  const targets = lives.filter((l) => !onlyLive || l.id === onlyLive);
  const since = targets.flatMap((l) => l.performances.map((p) => p.date)).sort()[0];
  if (!since) {
    console.log("公演がありません");
    return;
  }
  const suLives = await fetchSuLives(since);
  const ninaSongs = await fetchSuParticipationTitles();
  console.log(`Sakamichi Universe: ${since} 以降のライブ ${suLives.length} 件`);

  const report: string[] = [
    `# Sakamichi Universe からのセトリ取り込み (${apply ? "保存した" : "dry-run"})`,
    "",
    "参加の根拠: 「備考」= Sakamichi Universe の備考欄、「全員で披露するライブ」= 5期生のライブ・ひなた坂46 LIVE なので全曲参加、「参加楽曲 (SU)」/「参加楽曲でない」= 備考が無い (いつもの編成) ので坂井新奈の参加楽曲かで決めた",
    "",
  ];
  const tally = { matched: 0, saved: 0, skipped: 0, unmatched: 0, changed: 0 };

  for (const live of [...targets].reverse()) {
    report.push(`## ${live.name}`, "");
    for (const p of live.performances) {
      const head = `### ${p.date}${p.label ? ` ${p.label}` : ""} ${p.venue}`;
      if (p.setlist.length > 0 && !overwrite) {
        report.push(head, "", "既にセトリあり (飛ばした)", "");
        tally.skipped++;
        continue;
      }
      const res = await previewSuSetlist(
        { ...p, current: { songs: [...live.commonSongs, ...p.songs], centerSongs: p.centerSongs } },
        participation,
        { lives: suLives, ninaSongs }
      );
      await sleep(1000);
      if (!res.ok) {
        const cands = res.candidates.map((c) => `${c.starttime.slice(0, 5)} ${c.title}`).join(" / ");
        report.push(head, "", `**見つからない** (${res.reason}${cands ? `: ${cands}` : ""})`, "");
        tally.unmatched++;
        continue;
      }
      tally.matched++;

      // 今の披露曲 (手入力 / これまでの組み直し) との差
      const before = new Set([...live.commonSongs, ...p.songs].map(normalizeSongTitle));
      const beforeCenter = new Set(p.centerSongs.map(normalizeSongTitle));
      const after = res.rows.filter((r) => r.participated);
      const afterKeys = new Set(after.map((r) => normalizeSongTitle(r.title)));
      const added = after.filter((r) => !before.has(normalizeSongTitle(r.title))).map((r) => r.title);
      const removed = [...live.commonSongs, ...p.songs].filter((t) => !afterKeys.has(normalizeSongTitle(t)));
      const centers = res.rows.filter((r) => r.center).map((r) => r.title);
      const centerDiff =
        centers.length !== beforeCenter.size || centers.some((t) => !beforeCenter.has(normalizeSongTitle(t)));
      if (added.length || removed.length || centerDiff) tally.changed++;

      report.push(
        head,
        "",
        `← [${res.live.title}](${res.live.html_url}) ${res.live.starttime.slice(0, 5)} 開演・${res.rows.length} 曲`,
        "",
        "| # | 曲 | 区切り | 参加 | センター | 根拠 | 備考 (SU) |",
        "|---|---|---|---|---|---|---|",
        ...res.rows.map(
          (r, i) =>
            `| ${i + 1} | ${r.title}${known.has(normalizeSongTitle(r.title)) ? "" : " ⚠曲マスタに無い"} | ${r.section || "本編"} | ${r.participated ? "○" : "×"} | ${r.center ? "C" : ""} | ${r.reason} | ${r.remark.replace(/\|/g, "／")} |`
        ),
        ""
      );
      if (added.length || removed.length || centerDiff) {
        report.push(
          `**今の披露曲との差**: ${added.length ? `増える ${added.join(" / ")}` : ""}${added.length && removed.length ? "、" : ""}${removed.length ? `減る ${removed.join(" / ")}` : ""}${centerDiff ? `${added.length || removed.length ? "、" : ""}センター ${[...p.centerSongs].join(" / ") || "なし"} → ${centers.join(" / ") || "なし"}` : ""}`,
          ""
        );
      } else {
        report.push("今の披露曲と同じ", "");
      }

      if (apply) {
        await replacePerformanceSetlist(
          user,
          live,
          p.id,
          res.rows.map(({ title, section, participated, center }) => ({ title, section, participated, center })),
          res.source
        );
        tally.saved++;
      }
    }
  }

  report.unshift(
    `- 突き合わせ: ${tally.matched} 公演 / 見つからない ${tally.unmatched} / 既にセトリあり ${tally.skipped}`,
    `- 今の披露曲と差がある公演: ${tally.changed}`,
    apply ? `- 保存: ${tally.saved} 公演` : "- 保存はしていない (--apply で保存)",
    ""
  );
  writeFileSync(out, report.join("\n") + "\n");
  console.log(`${out} に書きました`, tally);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prismaInternal.$disconnect());
