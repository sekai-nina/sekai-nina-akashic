import { prisma } from "@/lib/db";

export interface WordFrequency {
  word: string;
  count: number;
}

const STOPWORDS = new Set([
  "する", "いる", "ある", "なる", "れる", "られる",
  "くる", "いく", "おる", "できる", "くれる", "もらう",
  "です", "ます", "ない", "この", "その", "あの", "どの",
  "こと", "もの", "ところ", "よう", "ため", "はず", "わけ",
  "から", "まで", "より", "ほど", "だけ", "しか", "ばかり",
  "とても", "すごく", "やっぱり", "ちょっと", "やはり",
  "それ", "これ", "あれ", "どれ", "ここ", "そこ", "あそこ",
  "そう", "こう", "ああ", "どう", "まだ", "もう", "とも",
  "けど", "でも", "だけど", "ただ", "なんか", "やっと",
  "思う", "行く", "言う", "見る", "知る", "来る", "出る",
  "入る", "持つ", "使う", "聞く", "書く", "読む", "食べる",
  "いい", "よい", "ほしい", "たい", "られ", "せる",
  "さん", "ちゃん", "くん", "たち", "など", "ぐらい",
  "https", "www", "com", "hinatazaka46", "official",
]);

/**
 * ブログ・トークのnormalizedContentを集計して頻出単語を返す。
 * SQLではなくアプリ側で集計する。
 */
export async function getWordFrequencies(limit = 100): Promise<WordFrequency[]> {
  const texts = await prisma.assetText.findMany({
    where: {
      textType: { in: ["body", "message_body"] },
      NOT: { normalizedContent: null },
      asset: {
        sourceType: { in: ["web", "import"] },
        kind: "text",
      },
    },
    select: { normalizedContent: true },
  });

  const freq = new Map<string, number>();

  for (const row of texts) {
    if (!row.normalizedContent) continue;
    const words = row.normalizedContent.split(/\s+/);
    for (const w of words) {
      if (w.length < 2) continue;
      // ASCII-only (URLs, numbers, etc.)
      if (/^[a-zA-Z0-9_\-.:/?=&%#+@]+$/.test(w)) continue;
      // Pure emoji/symbol
      if (/^[\p{Emoji}\p{S}\p{P}]+$/u.test(w)) continue;
      if (STOPWORDS.has(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }

  const sorted = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));

  return sorted;
}
