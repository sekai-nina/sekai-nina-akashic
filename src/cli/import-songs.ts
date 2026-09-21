/**
 * 公式ディスコグラフィ (Sony Music の JSON API) を曲マスタに流し込む (#167)。
 *
 * 1. 既存の Song の normalizedTitle を normalizeSongTitle で計算し直す (migration は仮の値)
 * 2. 一覧 → CD の盤の詳細を取り、TYPE-A〜D / 通常盤を 1 作品にまとめる (src/lib/songs/catalog.ts)
 * 3. Release / ReleaseTrack / Song を upsert。曲は normalizedTitle で既存に寄せ、表記が違えば公式に直す。
 *    作品から消えた曲の ReleaseTrack は消す
 * 4. どの作品にも入っていない Song (ライブ限定アレンジ、誤字) を一覧に出す。誰も参照していない
 *    (披露も収録も無く、人が何も書いていない) 行は消す
 *
 * 何度流しても同じ結果になる。新しいシングルが出たら流し直す。
 * 書き込みは DIRECT_URL (postgres ロール)。3 テーブルとも非保護だが CLI の慣習に合わせる。
 * 既定は dry-run、--apply で書く。
 *
 * Usage:
 *   pnpm cli:import-songs [--apply] [--artist hinatazaka46]
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { groupEditions, isCdItem, type CatalogDetail, type ReleaseInput } from "../lib/songs/catalog";
import { normalizeSongTitle } from "../lib/songs/normalize";
import { fetchCatalog, fetchDetail } from "../lib/songs/sony";

if (!process.env.DIRECT_URL) {
  console.error("DIRECT_URL が未設定です (このスクリプトは postgres ロールで書きます)");
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DIRECT_URL } } });
const apply = process.argv.includes("--apply");
const artistArg = process.argv.indexOf("--artist");
const artist = artistArg >= 0 ? process.argv[artistArg + 1] : "hinatazaka46";
if (!artist || artist.startsWith("--")) {
  console.error("--artist にはアーティストのフォルダ名 (hinatazaka46 等) を指定してください");
  process.exit(1);
}

interface KnownSong {
  id: string;
  title: string;
  artist: string;
}

async function main() {
  console.log(`曲マスタの取り込み (${artist})${apply ? "" : " (DRY RUN。--apply で書きます)"}`);

  // 1. 既存の Song の名寄せキーを揃える。**先に全件で衝突を見てから**書く
  //    (1 行ずつ書くと、後ろの行の仮の値とぶつかって生の unique 違反で止まる)
  const songs = await prisma.song.findMany({
    select: { id: true, title: true, normalizedTitle: true, artist: true },
    orderBy: { title: "asc" },
  });
  const byNormalized = new Map<string, KnownSong>();
  const rekey: { id: string; title: string; from: string; to: string }[] = [];
  for (const s of songs) {
    const n = normalizeSongTitle(s.title);
    const dup = byNormalized.get(n);
    if (dup) {
      console.error(
        `名寄せキーが衝突しています: 「${dup.title}」と「${s.title}」→ 先に一方を消すか統合してください (/songs)`
      );
      process.exit(1);
    }
    byNormalized.set(n, { id: s.id, title: s.title, artist: s.artist });
    if (n !== s.normalizedTitle) rekey.push({ id: s.id, title: s.title, from: s.normalizedTitle, to: n });
  }
  for (const r of rekey) {
    console.log(`  normalizedTitle: 「${r.title}」 ${r.from} → ${r.to}`);
    if (apply) await prisma.song.update({ where: { id: r.id }, data: { normalizedTitle: r.to } });
  }

  // 2. 取得。詳細が取れない盤 (発売前) も作品のまとめには入れる
  //    (通常盤の詳細だけ無い状態で代表品番が TYPE-A に決まり、次回に別の作品ができるのを防ぐ)
  const catalog = await fetchCatalog(artist);
  const cds = catalog.filter(isCdItem);
  console.log(`一覧 ${catalog.length} 件のうち CD ${cds.length} 盤の詳細を取ります…`);
  const details: CatalogDetail[] = [];
  for (const item of cds) {
    try {
      details.push(await fetchDetail(artist, item.representative_goods_number));
    } catch (e) {
      console.warn(`  取れません: ${item.representative_goods_number} ${item.title} (${e instanceof Error ? e.message : e})`);
      details.push({ ...item, discs: [] });
    }
  }
  const releases = groupEditions(details);
  console.log(`作品 ${releases.length} 件 (シングル ${releases.filter((r) => r.kind === "single").length} / アルバム ${releases.filter((r) => r.kind === "album").length})`);

  // 3. 書き込み
  let newSongs = 0;
  let renamed = 0;
  let newReleases = 0;
  let removedTracks = 0;
  const catalogKeys = new Set<string>();
  for (const r of releases) {
    const exists = await prisma.release.findUnique({ where: { sonyCode: r.sonyCode }, select: { id: true } });
    if (!exists) newReleases++;
    console.log(`\n${r.releaseDate} [${r.kind}] ${r.title} (${r.sonyCode}, ${r.editions.length} 盤, ${r.tracks.length} 曲)${exists ? "" : " *新規*"}`);
    const releaseId = apply ? await upsertRelease(r) : (exists?.id ?? "(dry)");
    const songIds: string[] = [];
    for (const t of r.tracks) {
      catalogKeys.add(t.normalizedTitle);
      const known = byNormalized.get(t.normalizedTitle);
      let songId: string;
      if (known) {
        songId = known.id;
        const data: { title?: string; artist?: string } = {};
        if (known.title !== t.title) {
          console.log(`  表記を公式に: 「${known.title}」→「${t.title}」`);
          renamed++;
          data.title = t.title;
          known.title = t.title;
        }
        // アーティストは初出の作品のものにする (空のときだけ埋める)
        if (!known.artist) {
          data.artist = r.artist;
          known.artist = r.artist;
        }
        if (apply && Object.keys(data).length > 0) await prisma.song.update({ where: { id: known.id }, data });
      } else {
        newSongs++;
        console.log(`  + ${t.title}`);
        songId = apply
          ? (await prisma.song.create({ data: { title: t.title, normalizedTitle: t.normalizedTitle, artist: r.artist }, select: { id: true } })).id
          : "(dry)";
        byNormalized.set(t.normalizedTitle, { id: songId, title: t.title, artist: r.artist });
      }
      songIds.push(songId);
      if (apply) {
        await prisma.releaseTrack.upsert({
          where: { releaseId_songId: { releaseId, songId } },
          update: { discNo: t.discNo, trackNo: t.trackNo, editions: t.editions },
          create: { releaseId, songId, discNo: t.discNo, trackNo: t.trackNo, editions: t.editions },
        });
      }
    }
    // 作品から消えた曲 (Sony 側の題の修正等) の紐づけを外す
    if (apply) {
      const gone = await prisma.releaseTrack.deleteMany({ where: { releaseId, songId: { notIn: songIds } } });
      if (gone.count > 0) {
        console.log(`  紐づけを外した: ${gone.count} 曲`);
        removedTracks += gone.count;
      }
    }
  }

  // 4. どの作品にも入っていない曲 (dry-run では名寄せキーで判定、apply 後は DB で判定)
  const orphans = apply
    ? await prisma.song.findMany({
        where: { tracks: { none: {} } },
        select: { id: true, title: true, note: true, participation: true, _count: { select: { liveSongs: true } } },
        orderBy: { title: "asc" },
      })
    : [...byNormalized.entries()]
        .filter(([k]) => !catalogKeys.has(k))
        .map(([, s]) => ({ id: s.id, title: s.title, note: "", participation: "unknown" as const, _count: { liveSongs: -1 } }));
  if (orphans.length > 0) {
    console.log(`\nどの作品にも入っていない曲 (${orphans.length}): ライブ限定アレンジか誤字。/songs で確認してください`);
    let pruned = 0;
    for (const o of orphans) {
      // 誰も参照せず人も何も書いていない行は、取り込みが作って要らなくなったもの (題の修正等)。消す
      const unused = apply && o._count.liveSongs === 0 && !o.note && o.participation === "unknown";
      console.log(`  ${o.title}${apply ? ` (披露 ${o._count.liveSongs} 回)` : ""}${unused ? " → 参照が無いので消します" : ""}`);
      if (unused) {
        await prisma.song.delete({ where: { id: o.id } });
        pruned++;
      }
    }
    if (pruned > 0) console.log(`  消した: ${pruned} 曲`);
  }

  console.log(`\n作品: 新規 ${newReleases} / 曲: 新規 ${newSongs}, 表記修正 ${renamed}, 紐づけ解除 ${removedTracks}${apply ? "" : " (DRY RUN)"}`);
}

async function upsertRelease(r: ReleaseInput): Promise<string> {
  const data = {
    title: r.title,
    kind: r.kind,
    releaseDate: r.releaseDate,
    artist: r.artist,
    editions: r.editions,
  };
  const row = await prisma.release.upsert({
    where: { sonyCode: r.sonyCode },
    update: data,
    create: { ...data, sonyCode: r.sonyCode },
    select: { id: true },
  });
  return row.id;
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
