export interface WordFrequency {
  word: string;
  score: number;
}

/**
 * ワードクラウドデータを生成。
 * PGroonga (MeCab) 依存を除去したため、一旦無効化。
 * TODO: kuromoji.js 等で再実装する
 */
export async function getWordFrequencies(_limit = 100, _since?: Date): Promise<WordFrequency[]> {
  return [];
}
