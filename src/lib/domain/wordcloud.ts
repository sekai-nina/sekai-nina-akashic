import { prisma } from "@/lib/db";
import kuromoji from "kuromoji";
import path from "path";

export interface WordFrequency {
  word: string;
  score: number;
}

// 坂井新奈の Entity ID
const NINA_ENTITY_ID = "cmmtp8vrg0004mo381neyztvn";

// ストップワード（助詞・助動詞・一般的すぎる語など）
const STOPWORDS = new Set([
  // 助詞・接続詞
  "の", "に", "は", "を", "た", "が", "で", "て", "と", "し", "れ", "さ",
  "ある", "いる", "する", "なる", "られ", "ない", "よう", "よる",
  "この", "その", "あの", "どの", "ここ", "そこ", "あそこ",
  "これ", "それ", "あれ", "どれ",
  "こと", "もの", "ため", "とき", "ところ",
  "から", "まで", "より", "ほど", "など", "くらい", "ぐらい",
  "でも", "けど", "けれど", "だけ", "しか", "ばかり",
  "そして", "また", "しかし", "でも", "だから", "それで",
  "とても", "すごく", "かなり", "ちょっと", "もう", "まだ", "やっぱり",
  "ちゃん", "さん", "くん", "たち",
  // 一般動詞（基本形）
  "いう", "思う", "行く", "来る", "見る", "出る", "入る", "知る",
  "言う", "聞く", "書く", "読む", "食べる", "飲む", "使う",
  "できる", "なれる", "もらう", "くれる", "あげる",
  // 一般形容詞
  "いい", "良い", "多い", "少ない", "大きい", "小さい", "新しい", "古い",
  // 一般名詞
  "人", "方", "日", "年", "月", "時", "中", "前", "後", "上", "下",
  "今", "私", "僕", "自分", "皆", "みんな", "感じ", "気持ち",
  "本当", "最近", "一番", "全部", "全て", "色々",
]);

// 品詞フィルタ: 名詞、動詞、形容詞の基本形のみ抽出
const ALLOWED_POS = new Set(["名詞", "動詞", "形容詞"]);
const EXCLUDED_POS_DETAIL = new Set([
  "非自立", "代名詞", "接尾", "数", "接続詞的", "助動詞語幹",
]);

// URL / 英語ノイズ除去
const URL_NOISE = new Set([
  "https", "http", "www", "com", "jp", "co", "org", "net", "html",
  "amp", "th", "st", "nd", "rd", "detail", "official", "hinatazaka",
]);

// Emoji / 記号除去パターン
const SYMBOL_RE = /[\p{Emoji}\p{S}\p{P}\p{M}\u2500-\u257F\u2580-\u259F]/gu;

let tokenizerPromise: Promise<kuromoji.Tokenizer<kuromoji.IpadicFeatures>> | null = null;

function getTokenizer(): Promise<kuromoji.Tokenizer<kuromoji.IpadicFeatures>> {
  if (!tokenizerPromise) {
    tokenizerPromise = new Promise((resolve, reject) => {
      kuromoji
        .builder({ dicPath: path.join(process.cwd(), "data/kuromoji-dict/") })
        .build((err, tokenizer) => {
          if (err) reject(err);
          else resolve(tokenizer);
        });
    });
  }
  return tokenizerPromise;
}

function extractWords(text: string, tokenizer: kuromoji.Tokenizer<kuromoji.IpadicFeatures>): string[] {
  const tokens = tokenizer.tokenize(text);
  const words: string[] = [];

  for (const token of tokens) {
    const pos = token.pos;
    const posDetail = token.pos_detail_1;

    if (!ALLOWED_POS.has(pos)) continue;
    if (EXCLUDED_POS_DETAIL.has(posDetail)) continue;

    // 基本形を使う（活用形の正規化）
    const word = token.basic_form !== "*" ? token.basic_form : token.surface_form;

    // フィルタ
    if (!word || word.length < 2) continue;
    if (STOPWORDS.has(word)) continue;
    if (URL_NOISE.has(word.toLowerCase())) continue;
    if (SYMBOL_RE.test(word)) continue;
    // ひらがなのみで2文字以下は除外
    if (/^[\u3040-\u309F]{1,2}$/.test(word)) continue;
    // ASCII英数のみの短い語を除外（URL断片など）
    if (/^[a-zA-Z0-9]{1,4}$/.test(word)) continue;

    words.push(word);
  }

  return words;
}

/**
 * 坂井新奈のブログテキストからワードクラウドデータを生成する。
 * TF-IDF スコアリング: 新奈のブログに特徴的な語を上位に。
 */
export async function getWordFrequencies(limit = 100, since?: Date): Promise<WordFrequency[]> {
  const tokenizer = await getTokenizer();

  // 坂井新奈のブログ本文を取得
  const dateFilter = since ? { canonicalDate: { gte: since } } : {};
  const texts = await prisma.assetText.findMany({
    where: {
      textType: { in: ["body", "message_body"] },
      asset: {
        sourceType: "web",
        kind: "text",
        entities: { some: { entityId: NINA_ENTITY_ID } },
        ...dateFilter,
      },
    },
    select: { content: true, assetId: true },
  });

  if (texts.length === 0) return [];

  // 記事ごとの単語集合（IDF計算用）
  const docCount = new Map<string, Set<string>>(); // word → set of assetIds
  const globalFreq = new Map<string, number>(); // word → total count

  for (const { content, assetId } of texts) {
    const words = extractWords(content, tokenizer);
    const seen = new Set<string>();

    for (const word of words) {
      globalFreq.set(word, (globalFreq.get(word) ?? 0) + 1);

      if (!seen.has(word)) {
        seen.add(word);
        if (!docCount.has(word)) docCount.set(word, new Set());
        docCount.get(word)!.add(assetId);
      }
    }
  }

  // 全記事数
  const totalDocs = new Set(texts.map((t) => t.assetId)).size;

  // TF-IDF スコアリング
  const scored: WordFrequency[] = [];
  for (const [word, tf] of globalFreq) {
    const df = docCount.get(word)?.size ?? 1;
    // 1記事のみに出現する語は除外（ノイズ軽減）
    if (df < 2) continue;
    const idf = Math.log(totalDocs / df);
    const score = tf * idf;
    scored.push({ word, score: Math.round(score * 100) / 100 });
  }

  // スコア降順でソートしてtop N
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
