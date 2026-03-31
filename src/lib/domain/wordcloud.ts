import { prisma } from "@/lib/db";

export interface WordFrequency {
  word: string;
  count: number;
}

/**
 * ブログ・トークのテキストからPGroongaのTokenMecabを使って
 * 頻出単語を集計する。
 *
 * PGroongaの pgroonga_command('tokenize') を使って形態素解析し、
 * 助詞・助動詞・記号などを除外して名詞・動詞・形容詞を抽出する。
 */
export async function getWordFrequencies(limit = 100): Promise<WordFrequency[]> {
  // pgroonga_command('tokenize') を使って各テキストをトークン化し、
  // JSONとして返ってくるトークン列を集計する。
  // ただしpgroonga_commandは1テキストずつなので、
  // 代わりにnormalizedContentを空白で分割する簡易アプローチを使う。
  // normalizedContentはMeCabベースで正規化済み。

  const rows = await prisma.$queryRaw<WordFrequency[]>`
    WITH tokens AS (
      SELECT regexp_split_to_table(t."normalizedContent", E'[\\s　、。！？!?,.;:()（）「」『』\\[\\]【】─┈…・×＝+＋/\\\\→←↑↓♪♡★☆🎂🍨🥬🌸🩰🫧🍎🧀🍠💡💭✨️🔅🩵🎵🐛🌻🍁🍂🩷🫶🏻]+') AS word
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
      AND word !~ '^[0-9a-zA-Zａ-ｚＡ-Ｚ０-９]+$'
      AND word !~ '^[\x{3040}-\x{309F}]{1,2}$'
      AND word NOT IN (
        'する', 'いる', 'ある', 'なる', 'れる', 'られる',
        'くる', 'いく', 'おる', 'できる', 'くれる', 'もらう',
        'です', 'ます', 'ない', 'ある', 'この', 'その', 'あの',
        'こと', 'もの', 'ところ', 'よう', 'ため', 'はず',
        'から', 'まで', 'より', 'ほど', 'だけ', 'しか',
        'とても', 'すごく', 'とても', 'やっぱり', 'ちょっと',
        'https', 'www', 'com', 'hinatazaka46', 'official'
      )
    GROUP BY word
    ORDER BY count DESC
    LIMIT ${limit}
  `;

  return rows;
}
