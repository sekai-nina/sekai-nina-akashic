import { prisma } from "@/lib/db";

export interface WordFrequency {
  word: string;
  score: number;
}

const STOPWORDS = new Set([
  // 助詞
  "の", "を", "に", "は", "が", "で", "と", "も", "や", "か",
  "へ", "な", "よ", "ね", "わ", "て", "だ", "ば", "し", "から",
  "まで", "より", "ほど", "だけ", "しか", "ばかり", "けど",
  "って", "とか", "のだ", "ので", "たり", "など", "について",
  // 助動詞・補助動詞
  "する", "いる", "ある", "なる", "れる", "られる", "せる", "させる",
  "です", "ます", "ない", "た", "ぬ", "たい", "てる", "ておる",
  "くる", "いく", "おる", "できる", "くれる", "もらう", "しまう",
  "いただく", "くださる", "いただける", "ございる",
  "みる", "おく", "あげる", "やる",
  // 代名詞・指示詞
  "この", "その", "あの", "どの", "こと", "もの", "ところ",
  "それ", "これ", "あれ", "どれ", "ここ", "そこ",
  "そんな", "こんな", "あんな", "どんな",
  // 副詞・接続詞
  "そう", "こう", "どう", "まだ", "もう", "とても", "すごく",
  "そして", "でも", "ただ", "なので", "ちょっと", "やっぱり",
  "また", "すぎる", "少し", "最近", "いつも",
  // 形式名詞・接尾辞
  "よう", "ため", "はず", "わけ", "ほう", "という",
  "さん", "ちゃん", "くん", "さま", "たち",
  // 汎用動詞・形容詞
  "思う", "言う", "見る", "知る", "行く", "来る", "出る", "入る",
  "書く", "読む", "聞く", "持つ", "使う", "会う", "感じる",
  "いい", "よい", "すごい", "なれる",
  // 1文字漢字
  "方", "事", "時", "人", "日", "中", "前", "後", "上", "下",
  "気", "目", "手", "所", "回", "年", "今",
]);

function isValidWord(w: string): boolean {
  if (w.length < 2) return false;
  if (/^[a-zA-Z0-9_\-.:/?=&%#+@()\[\]{}|\\<>,;'"` ]+$/.test(w)) return false;
  if (/^[0-9０-９]+$/.test(w)) return false;
  if (STOPWORDS.has(w)) return false;
  return true;
}

/**
 * テキストをPGroonga TokenMecabでトークン化し、有効な単語のリストを返す。
 */
async function tokenizeText(text: string): Promise<string[]> {
  const words: string[] = [];
  try {
    const result = await prisma.$queryRawUnsafe<[{ pgroonga_command: string }]>(
      `SELECT pgroonga_command('tokenize', ARRAY['string', $1, 'tokenizer', 'TokenMecab("use_base_form", true)'])`,
      text.slice(0, 10000)
    );
    if (!result[0]?.pgroonga_command) return words;
    const parsed = JSON.parse(result[0].pgroonga_command);
    const tokens = parsed[1] as { value: string }[];
    if (!tokens) return words;
    for (const t of tokens) {
      if (isValidWord(t.value)) words.push(t.value);
    }
  } catch {
    // skip
  }
  return words;
}

/**
 * TF-IDFベースのワードクラウドデータを生成。
 *
 * 文書単位:
 *   - ブログ: 1記事 = 1文書
 *   - トーク: 1週間分 = 1文書
 *
 * TF = 単語の全文書での総出現回数
 * IDF = log(総文書数 / その単語が出現する文書数)
 * スコア = TF * IDF
 */
export async function getWordFrequencies(limit = 100): Promise<WordFrequency[]> {
  // ブログテキストを取得（1記事 = 1文書）
  const blogTexts = await prisma.assetText.findMany({
    where: {
      textType: "body",
      asset: { sourceType: "web", kind: "text" },
    },
    select: { content: true },
  });

  // トークテキストを日付付きで取得
  const talkTexts = await prisma.assetText.findMany({
    where: {
      textType: { in: ["body", "message_body"] },
      asset: { sourceType: "import", kind: "text" },
    },
    select: {
      content: true,
      asset: { select: { canonicalDate: true } },
    },
  });

  // トークを1週間単位でグループ化
  const talkWeeks = new Map<string, string[]>();
  for (const t of talkTexts) {
    if (!t.content) continue;
    const date = t.asset.canonicalDate ?? new Date();
    const d = new Date(date);
    // ISO週の月曜日を算出
    const day = d.getDay();
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((day + 6) % 7));
    const weekKey = monday.toISOString().slice(0, 10);
    if (!talkWeeks.has(weekKey)) talkWeeks.set(weekKey, []);
    talkWeeks.get(weekKey)!.push(t.content);
  }

  // 全文書リスト: ブログ各記事 + トーク週まとめ
  const documents: string[] = [];
  for (const b of blogTexts) {
    if (b.content) documents.push(b.content);
  }
  for (const [, texts] of talkWeeks) {
    documents.push(texts.join("\n"));
  }

  const totalDocs = documents.length;
  if (totalDocs === 0) return [];

  // 各文書をトークン化
  const docTokens: string[][] = [];
  for (const doc of documents) {
    docTokens.push(await tokenizeText(doc));
  }

  // TF: 全文書での総出現回数
  const tf = new Map<string, number>();
  // DF: その単語が出現する文書数
  const df = new Map<string, number>();

  for (const tokens of docTokens) {
    const seen = new Set<string>();
    for (const w of tokens) {
      tf.set(w, (tf.get(w) || 0) + 1);
      seen.add(w);
    }
    for (const w of seen) {
      df.set(w, (df.get(w) || 0) + 1);
    }
  }

  // TF-IDF スコア計算
  const scores: [string, number][] = [];
  for (const [word, termFreq] of tf) {
    const docFreq = df.get(word) || 1;
    // 1文書にしか出ない語も除外（ノイズの可能性が高い）
    if (docFreq < 2) continue;
    const idf = Math.log(totalDocs / docFreq);
    scores.push([word, termFreq * idf]);
  }

  scores.sort((a, b) => b[1] - a[1]);

  return scores
    .slice(0, limit)
    .map(([word, score]) => ({ word, score: Math.round(score * 100) / 100 }));
}
