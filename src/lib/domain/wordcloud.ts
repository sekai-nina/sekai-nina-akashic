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
  // ASCII記号・数字のみ
  if (/^[a-zA-Z0-9_\-.:/?=&%#+@()\[\]{}|\\<>,;'"` ]+$/.test(w)) return false;
  if (/^[0-9０-９]+$/.test(w)) return false;
  // 罫線・装飾文字の繰り返し（┈┈┈, ───, ═══ 等）
  if (/^[┈─━═┃│┊┄┅┆┇┉╌╍╎╏═]{2,}$/.test(w)) return false;
  // 絵文字のみ
  if (/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D]+$/u.test(w)) return false;
  // 合成文字・修飾記号のみ（˘͈ᵕ˘͈, ·‪ 等）
  if (/[\u0300-\u036F\u0340-\u0360\u02B0-\u02FF]/.test(w)) return false;
  // 制御文字・ゼロ幅文字を含む
  if (/[\u200B-\u200F\u2028-\u202F\uFEFF\u00A0]/.test(w)) return false;
  // 記号のみ（🔅·‪ 等）
  if (/^[\p{S}\p{P}\p{M}\p{Z}]+$/u.test(w)) return false;
  // 日本語（漢字・カタカナ・ひらがな3文字以上）を含まない短い語
  if (w.length <= 2 && !/[\u4E00-\u9FFF\u30A0-\u30FF]/.test(w) && !/[\u3040-\u309F]{2,}/.test(w)) return false;
  if (STOPWORDS.has(w)) return false;
  return true;
}

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

// 坂井新奈のperson entity ID
const NINA_ENTITY_ID = "cmmtp8vrg0004mo381neyztvn";

/**
 * TF-IDFベースのワードクラウドデータを生成。
 *
 * TF: 坂井新奈のブログでの出現回数
 * IDF: log(全メンバーのブログ総数 / その語が出現するブログ数)
 *
 * → 全メンバーに共通する語（挨拶、定型文）のスコアが下がり、
 *   坂井新奈に特徴的な語が浮かび上がる。
 */
/**
 * @param limit 返却する単語数の上限
 * @param since この日付以降のブログを対象にする（省略時は全期間）
 */
export async function getWordFrequencies(limit = 100, since?: Date): Promise<WordFrequency[]> {
  // 坂井新奈のブログのアセットID一覧
  const ninaAssetEntities = await prisma.assetEntity.findMany({
    where: { entityId: NINA_ENTITY_ID },
    select: { assetId: true },
  });
  const ninaAssetIds = new Set(ninaAssetEntities.map((ae) => ae.assetId));

  // 全メンバーのブログテキストを取得（期間フィルタあり）
  const dateFilter = since ? { canonicalDate: { gte: since } } : {};
  const allBlogTexts = await prisma.assetText.findMany({
    where: {
      textType: "body",
      asset: { sourceType: "web", kind: "text", ...dateFilter },
    },
    select: { content: true, assetId: true },
  });

  // 坂井新奈のブログと全ブログに分ける
  const ninaDocs: string[] = [];
  const allDocs: string[] = [];
  for (const row of allBlogTexts) {
    if (!row.content) continue;
    allDocs.push(row.content);
    if (ninaAssetIds.has(row.assetId)) {
      ninaDocs.push(row.content);
    }
  }

  const totalDocs = allDocs.length;
  if (totalDocs === 0 || ninaDocs.length === 0) return [];

  // 坂井新奈のブログをトークン化 → TF
  const tf = new Map<string, number>();
  for (const doc of ninaDocs) {
    const tokens = await tokenizeText(doc);
    for (const w of tokens) {
      tf.set(w, (tf.get(w) || 0) + 1);
    }
  }

  // 全ブログをトークン化 → DF（各語が出現する文書数）
  const df = new Map<string, number>();
  for (const doc of allDocs) {
    const tokens = await tokenizeText(doc);
    const seen = new Set(tokens);
    for (const w of seen) {
      df.set(w, (df.get(w) || 0) + 1);
    }
  }

  // TF-IDF スコア計算
  const scores: [string, number][] = [];
  for (const [word, termFreq] of tf) {
    const docFreq = df.get(word) || 1;
    // 坂井新奈のブログに1回しか出ない語は除外
    if (termFreq < 2) continue;
    const idf = Math.log(totalDocs / docFreq);
    // IDFが0に近い（全文書に出る）語はスキップ
    if (idf < 0.1) continue;
    scores.push([word, termFreq * idf]);
  }

  scores.sort((a, b) => b[1] - a[1]);

  return scores
    .slice(0, limit)
    .map(([word, score]) => ({ word, score: Math.round(score * 100) / 100 }));
}
