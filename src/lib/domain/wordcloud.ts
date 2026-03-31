import { prisma } from "@/lib/db";

export interface WordFrequency {
  word: string;
  count: number;
}

const STOPWORDS = new Set([
  // 動詞・助動詞
  "する", "いる", "ある", "なる", "れる", "られる",
  "くる", "いく", "おる", "できる", "くれる", "もらう",
  "思う", "行く", "言う", "見る", "知る", "来る", "出る",
  "入る", "持つ", "使う", "聞く", "書く", "読む", "食べる",
  // 助詞・接続詞・副詞
  "です", "ます", "ない", "この", "その", "あの", "どの",
  "こと", "もの", "ところ", "よう", "ため", "はず", "わけ",
  "から", "まで", "より", "ほど", "だけ", "しか", "ばかり",
  "とても", "すごく", "やっぱり", "ちょっと", "やはり",
  "それ", "これ", "あれ", "どれ", "ここ", "そこ", "あそこ",
  "そう", "こう", "ああ", "どう", "まだ", "もう", "とも",
  "けど", "でも", "だけど", "ただ", "なんか", "やっと",
  "いい", "よい", "ほしい", "たい", "られ", "せる",
  "さん", "ちゃん", "くん", "たち", "など", "ぐらい",
  "そして", "なので", "まずは", "ということで", "そういえば",
  "そしてそして", "もうひとつ", "今日は",
  // 定型文（ブログ挨拶等）
  "おやすみ!", "おはよー!", "おはよう!", "おはよ!", "おーはよ!",
  "ゆっくり休んでね", "ゆっくりねてね",
  "です!", "頑張ります",
  // 自己紹介定型
  "神奈川県出身", "16歳", "17歳", "高校2年生", "高校二年生",
  "高校二年生16歳", "高校二年生17歳",
  "日向坂46", "櫻坂46",
  // URL/HTML
  "https", "www", "com", "hinatazaka46", "official",
  "&lt;今日の発見&gt;", "【今日の発見】", "amp", "nbsp", "&lt", "&gt",
]);

// 制御文字・合成文字（ combining marks）を含むか
function hasControlOrCombining(s: string): boolean {
  return /[\u0300-\u036F\u0340-\u0360\u1AB0-\u1AFF\u0600-\u06FF]/.test(s);
}

// 日本語の実質的な単語か（漢字・カタカナ・ひらがな3文字以上を含む）
function hasJapanese(s: string): boolean {
  return /[\u4E00-\u9FFF\u30A0-\u30FF]/.test(s) || /[\u3040-\u309F]{3,}/.test(s);
}

/**
 * ブログ・トークのnormalizedContentを集計して頻出単語を返す。
 */
export async function getWordFrequencies(limit = 100): Promise<WordFrequency[]> {
  const texts = await prisma.assetText.findMany({
    where: {
      textType: { in: ["body", "message_body"] },
      normalizedContent: { not: { equals: "" } },
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
      // ASCII-only
      if (/^[a-zA-Z0-9_\-.:/?=&%#+@()]+$/.test(w)) continue;
      // 制御文字・合成文字を含む
      if (hasControlOrCombining(w)) continue;
      // 絵文字のみ
      if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}]+$/u.test(w)) continue;
      // 記号のみ
      if (/^[\p{S}\p{P}\s]+$/u.test(w)) continue;
      // 日本語を含まない短い文字列
      if (w.length <= 3 && !hasJapanese(w)) continue;
      // ストップワード
      if (STOPWORDS.has(w)) continue;
      // 先頭・末尾のゴミを除去して正規化
      const cleaned = w.replace(/^[%$#&*~`|\\]+/, "").replace(/[!！。、？?…)+\]]+$/, "");
      if (cleaned.length < 2) continue;
      if (STOPWORDS.has(cleaned)) continue;

      freq.set(cleaned, (freq.get(cleaned) || 0) + 1);
    }
  }

  const sorted = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));

  return sorted;
}
