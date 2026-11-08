/**
 * 同時実行数を絞って items を順に処理する。結果は items と同じ順に並ぶ。
 * 1 件が投げたら全体が投げる (他の worker は走り切る) ので、失敗を結果に含めたいなら fn の中で受ける。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
