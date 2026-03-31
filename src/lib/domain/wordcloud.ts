import { prisma } from "@/lib/db";

export interface WordFrequency {
  word: string;
  count: number;
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
  "いただく", "くださる", "いただける", "ございる",  // 敬語補助
  "みる", "おく", "あげる", "やる",  // 補助動詞
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
  // 1文字漢字（意味薄）
  "方", "事", "時", "人", "日", "中", "前", "後", "上", "下",
  "気", "目", "手", "所", "回", "年", "今",
]);

/**
 * PGroongaのTokenMecabで形態素解析し、頻出単語を集計する。
 * テキストをチャンクに結合してまとめてtokenizeすることでクエリ数を削減。
 */
export async function getWordFrequencies(limit = 100): Promise<WordFrequency[]> {
  // 全テキストを取得
  const texts = await prisma.assetText.findMany({
    where: {
      textType: { in: ["body", "message_body"] },
      normalizedContent: { not: { equals: "" } },
      asset: {
        sourceType: { in: ["web", "import"] },
        kind: "text",
      },
    },
    select: { content: true },
  });

  // テキストをチャンクに結合（1チャンク最大50000文字）
  const CHUNK_SIZE = 50000;
  const chunks: string[] = [];
  let current = "";
  for (const row of texts) {
    if (!row.content) continue;
    const text = row.content.slice(0, 5000); // 1テキスト最大5000文字
    if (current.length + text.length > CHUNK_SIZE) {
      chunks.push(current);
      current = text;
    } else {
      current += "\n" + text;
    }
  }
  if (current) chunks.push(current);

  const freq = new Map<string, number>();

  for (const chunk of chunks) {
    try {
      const result = await prisma.$queryRawUnsafe<[{ pgroonga_command: string }]>(
        `SELECT pgroonga_command('tokenize', ARRAY['string', $1, 'tokenizer', 'TokenMecab("use_base_form", true)'])`,
        chunk
      );

      if (!result[0]?.pgroonga_command) continue;

      const parsed = JSON.parse(result[0].pgroonga_command);
      const tokens = parsed[1] as { value: string }[];
      if (!tokens) continue;

      for (const token of tokens) {
        const w = token.value;
        if (w.length < 2) continue;
        if (/^[a-zA-Z0-9_\-.:/?=&%#+@()\[\]{}|\\<>,;'"` ]+$/.test(w)) continue;
        if (/^[0-9０-９]+$/.test(w)) continue;
        if (STOPWORDS.has(w)) continue;
        freq.set(w, (freq.get(w) || 0) + 1);
      }
    } catch (e) {
      console.error("Tokenize chunk error:", e);
    }
  }

  const sorted = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));

  return sorted;
}
