/**
 * 一度きりの後片付け: YouTube の SourceRecord の publisher をチャンネル名に付け直す (#101)。
 *
 * youtube_watch は publisher を一律 "YouTube" で登録していた。動画タイトルはチャンネル名で
 * 始まらないので、DataSource の titlePattern (`日向坂ちゃんねる%`) では 4 月以降の新着を拾えず、
 * 収集カバレッジにも `/status` の鮮度チェックにも乗っていなかった。
 *
 * bot が付けるチャンネルのタグ (Entity type=tag) からチャンネルを決め、publisher を付け直す。
 * あわせて hinachan / official_ch の DataSource を publisherPattern で見分けるように直す
 * (`seed-coverage` の再実行は設定タブで直した他の DataSource も上書きするので使わない)。
 * タグの無い行 (手で登録した MV など) はチャンネルが分からないので触らない。
 *
 * Usage:
 *   pnpm cli:fix-youtube-publisher            # 下見 (何もしない)
 *   pnpm cli:fix-youtube-publisher --apply    # 実行
 */
import { prismaInternal } from "@/lib/db";

const APPLY = process.argv.includes("--apply");

/** DataSource.key → チャンネル名 (= youtube_watch のタグ名 = 新しい publisher) */
const CHANNELS = { hinachan: "日向坂ちゃんねる", official_ch: "日向坂46公式チャンネル" } as const;

async function main() {
  if (!process.env.DIRECT_URL?.trim()) {
    console.error("DIRECT_URL が未設定です (prismaInternal が DATABASE_URL に無言でフォールバックする)");
    process.exit(1);
  }
  const names = Object.values(CHANNELS);

  const records = await prismaInternal.sourceRecord.findMany({
    where: { url: { contains: "youtu" }, OR: [{ publisher: null }, { publisher: { startsWith: "YouTube" } }] },
    select: {
      id: true,
      publisher: true,
      title: true,
      asset: {
        select: { entities: { where: { entity: { type: "tag", canonicalName: { in: names } } }, select: { entity: { select: { canonicalName: true } } } } },
      },
    },
  });

  const updates: { id: string; from: string | null; to: string }[] = [];
  let untagged = 0;
  let ambiguous = 0;
  for (const r of records) {
    const tags = [...new Set(r.asset.entities.map((e) => e.entity.canonicalName))];
    if (tags.length === 0) untagged++;
    else if (tags.length > 1) ambiguous++;
    else updates.push({ id: r.id, from: r.publisher, to: tags[0] });
  }
  const byChannel = Object.fromEntries(names.map((n) => [n, updates.filter((u) => u.to === n).length]));
  console.log(`対象 ${records.length} 件: 付け直す ${updates.length} 件`, byChannel, `/ タグ無し ${untagged} 件 / タグが 2 つ ${ambiguous} 件 (どちらも触らない)`);

  const sources = await prismaInternal.dataSource.findMany({
    where: { key: { in: Object.keys(CHANNELS) } },
    select: { key: true, publisherPattern: true, titlePattern: true },
  });
  for (const s of sources) {
    const to = `${CHANNELS[s.key as keyof typeof CHANNELS]}%`;
    console.log(`DataSource ${s.key}: publisherPattern ${s.publisherPattern} → ${to}, titlePattern ${s.titlePattern} → null`);
  }

  if (!APPLY) {
    console.log("下見のみ。--apply で書き込む");
    return;
  }
  await prismaInternal.$transaction(async (tx) => {
    for (const name of names) {
      const ids = updates.filter((u) => u.to === name).map((u) => u.id);
      if (ids.length) await tx.sourceRecord.updateMany({ where: { id: { in: ids } }, data: { publisher: name } });
    }
    for (const [key, name] of Object.entries(CHANNELS)) {
      await tx.dataSource.update({ where: { key }, data: { publisherPattern: `${name}%`, titlePattern: null } });
    }
  });
  console.log("書き込みました");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prismaInternal.$disconnect());
