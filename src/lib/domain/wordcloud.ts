import { prisma } from "@/lib/db";

export interface WordFrequency {
  word: string;
  count: number;
}

/**
 * ブログ・トークのnormalizedContent（MeCabベース正規化済み）を
 * 空白分割して頻出単語を集計する。
 */
export async function getWordFrequencies(limit = 100): Promise<WordFrequency[]> {
  const rows = await prisma.$queryRaw<WordFrequency[]>`
    WITH tokens AS (
      SELECT unnest(string_to_array(t."normalizedContent", ' ')) AS word
      FROM "AssetText" t
      JOIN "Asset" a ON a.id = t."assetId"
      WHERE a."sourceType" IN ('web', 'import')
        AND a.kind = 'text'
        AND t."textType" IN ('body', 'message_body')
        AND t."normalizedContent" IS NOT NULL
    )
    SELECT word, COUNT(*)::int AS count
    FROM tokens
    WHERE LENGTH(word) >= 2
      AND word !~ '^[0-9a-zA-Z_\-.:/?=&%#+@]+$'
      AND word NOT IN (
        'する', 'いる', 'ある', 'なる', 'れる', 'られる',
        'くる', 'いく', 'おる', 'できる', 'くれる', 'もらう',
        'です', 'ます', 'ない', 'この', 'その', 'あの', 'どの',
        'こと', 'もの', 'ところ', 'よう', 'ため', 'はず', 'わけ',
        'から', 'まで', 'より', 'ほど', 'だけ', 'しか', 'ばかり',
        'とても', 'すごく', 'やっぱり', 'ちょっと', 'やはり',
        'それ', 'これ', 'あれ', 'どれ', 'ここ', 'そこ', 'あそこ',
        'そう', 'こう', 'ああ', 'どう', 'まだ', 'もう', 'とも',
        'けど', 'でも', 'だけど', 'ただ', 'なんか', 'やっと',
        'https', 'www', 'com', 'hinatazaka46', 'official',
        'amp', 'nbsp', 'lt', 'gt', '&lt', '&gt'
      )
    GROUP BY word
    ORDER BY count DESC
    LIMIT ${limit}
  `;

  return rows;
}
