/**
 * 今日の発見 (#432) の純粋な部分。DB も API も触らない。
 *
 * - LLM に渡すプロンプトの組み立てと、返ってきた下書きの後処理 (`finalizeDrafts`)
 * - 一覧・今日の発見ノートの通し番号 (`numberDiscoveries`)
 *
 * 呼び出しは `src/lib/discoveries/llm.ts` (Claude) と `src/lib/domain/discoveries.ts` (DB)。
 */

import { z } from "zod";

export const DISCOVERY_CONFIDENCES = ["certain", "maybe", "hearsay"] as const;
export type DiscoveryConfidenceValue = (typeof DISCOVERY_CONFIDENCES)[number];

/** 下書きのもとになるブログ 1 本 */
export interface DraftSource {
  assetId: string;
  /** bot が付けた見出し (AssetText annotation) */
  heading: string;
  /** bot が抜き出した本文 (AssetText extracted)。無ければ空 */
  excerpt: string;
}

/** 保存する発見 1 件 */
export interface DiscoveryDraft {
  position: number;
  heading: string;
  excerpt: string;
  isFood: boolean;
  ingredients: string[];
  result: string | null;
  confidence: DiscoveryConfidenceValue;
}

/** LLM の返答の形 (Structured Output) */
export const DraftResponseSchema = z.object({
  blogs: z.array(
    z.object({
      /** プロンプトで振った番号 (b1, b2, …) */
      key: z.string(),
      discoveries: z.array(
        z.object({
          heading: z.string(),
          excerpt: z.string(),
          isFood: z.boolean(),
          ingredients: z.array(z.string()),
          result: z.string().nullable(),
          confidence: z.enum(DISCOVERY_CONFIDENCES),
        }),
      ),
    }),
  ),
});
export type DraftResponse = z.infer<typeof DraftResponseSchema>;
type DraftItem = DraftResponse["blogs"][number]["discoveries"][number];

const SYSTEM_PROMPT = `あなたは坂井新奈 (日向坂46) のブログの「今日の発見」コーナーを整理する係です。
「今日の発見」は、本人が食べ物を組み合わせて食べてみた発見を書くコーナーです (食べ物以外の発見が混ざる回もあります)。
渡されたブログごとに、発見を 1 件ずつに分け、それぞれについて次を出してください。

## 発見の数え方
- 別々の話題として書かれた発見は、それぞれ 1 件にする (例: 「充電は 100% より 78% のほうが安心する」と「いちごに醤油をかけると高級感が増すかも」は 2 件)
- 1 つの話が続いているだけなら 1 件にする (例: 「スイカを醤油につけると中トロ風。そのスイカとアボカドを海苔で巻くと美味しい」は 1 件)
- ほとんどのブログは 1 件です。迷ったら 1 件にする

## 各項目
- heading: 一覧に載せる見出し。発見が 1 件なら、渡された見出しをそのまま返す。2 件以上なら、渡された見出しを発見ごとに分けて書く (言い換えない)
- excerpt: ブログ本文のうち、その発見の部分。本文から一字一句そのまま写す (改行も残す)。発見が 1 件なら本文をそのまま返す
- isFood: 食べ物・飲み物の発見なら true。それ以外 (生活の発見・気持ちの発見・人が食べていた物の感想だけ) は false
- ingredients: 組み合わせた食べ物・飲み物。isFood が false なら空
  - 本人が書いた名前で書く。料理名・商品名はそれで 1 つ (「とんこつラーメン」「もみじ饅頭」「ドバイチョコもち」「ヨーグルッペ」)
  - 「蒸かした」「砕いた」「少しの」のような調理・分量の言葉は外す (「蒸かしたじゃがいも」→「じゃがいも」)
  - 英字・飾り文字はふつうのカタカナ・日本語にする (「𝑶𝑳𝑰𝑽𝑬 𝑶𝑰𝑳」→「オリーブオイル」)
  - 「既にある材料名」に同じ食べ物があれば、その名前に揃える (「チョコレート」と「チョコ」なら既にある方)
  - 今回渡したブログどうしでも、同じ食べ物は同じ名前に揃える。表記はひらがな寄りにする (「リンゴ」→「りんご」、「ハチミツ」「蜂蜜」→「はちみつ」、「ポテト」「フレンチフライ」→「フライドポテト」、「ブラックペッパー」→「黒こしょう」)。違う食べ物 (「じゃがいも」と「フライドポテト」、「バニラアイス」と「ソフトクリーム」) はまとめない
- result: 「〇〇になる」「〇〇風」「〇〇っぽい」「〇〇感」のように、組み合わせると別の食べ物の味になると書いてあるときだけ、その食べ物の名前 (「抹茶風味のアイスになる」→「抹茶アイス」、「みたらし団子になる」→「みたらし団子」)。「美味しい」「濃厚」「和のスイーツ」「トロピカルな味」のように特定の食べ物でないもの、isFood が false のものは null
- confidence: 本人の書き方の確かさ
  - certain: 言い切っている (「〜になる」「美味しい」「革命です」)
  - maybe: 試していない・自信がない書き方 (「〜かも」「可能性」「予感」「〜な気がする」)
  - hearsay: 人から聞いた話 (「〜らしい」「〜なんだって」)

返すのは JSON だけです。blogs の key は渡された key をそのまま使い、渡されたすべてのブログについて返してください。`;

/** LLM に渡すプロンプト。ブログには b1, b2, … と短い key を振る (cuid を写させない) */
export function buildDraftPrompt(sources: DraftSource[], vocabulary: string[]): { system: string; user: string } {
  const blogs = sources
    .map((s, i) => `### key: b${i + 1}\n見出し: ${s.heading}\n本文:\n${s.excerpt || s.heading}`)
    .join("\n\n");
  const vocab = vocabulary.length > 0 ? vocabulary.join("、") : "(まだありません)";
  return {
    system: SYSTEM_PROMPT,
    user: `## 既にある材料名\n${vocab}\n\n## ブログ\n\n${blogs}`,
  };
}

/** 空白・改行を除いた形。抜粋が本文の一部か調べるのに使う */
function squash(s: string): string {
  return s.replace(/\s+/g, "");
}

function cleanName(s: string): string {
  return s.normalize("NFKC").trim();
}

export interface FinalizeResult {
  /** key → 保存する発見。返答に無かったブログは入らない */
  drafts: Map<string, DiscoveryDraft[]>;
  /** 人に見てほしい点 (ブログの assetId 付き) */
  warnings: { assetId: string; message: string }[];
}

/**
 * LLM の返答を保存する形に直す。LLM に任せきりにしない決まりはここで強制する:
 *
 * - 発見が 1 件の回は、見出しと抜粋を bot の値 (annotation / extracted) のまま使う (言い換えさせない)
 * - 食べ物でない発見は材料・できあがりを空にする
 * - 材料は前後の空白を落とし、重複を除く。できあがりが空文字なら null
 * - 2 件以上に分けた回は、抜粋が本文に含まれているか確かめ、含まれなければ警告する
 */
export function finalizeDrafts(sources: DraftSource[], response: DraftResponse): FinalizeResult {
  const drafts = new Map<string, DiscoveryDraft[]>();
  const warnings: FinalizeResult["warnings"] = [];
  const byKey = new Map(response.blogs.map((b) => [b.key, b.discoveries]));

  sources.forEach((source, i) => {
    const items = byKey.get(`b${i + 1}`);
    if (!items || items.length === 0) {
      warnings.push({ assetId: source.assetId, message: "下書きが返ってきませんでした" });
      return;
    }
    const single = items.length === 1;
    const out = items.map((item: DraftItem, position): DiscoveryDraft => {
      const ingredients = item.isFood ? [...new Set(item.ingredients.map(cleanName).filter(Boolean))] : [];
      const result = item.isFood && item.result ? cleanName(item.result) || null : null;
      return {
        position,
        heading: single ? source.heading : item.heading.trim(),
        excerpt: single ? source.excerpt || source.heading : item.excerpt.trim(),
        isFood: item.isFood,
        ingredients,
        result,
        confidence: item.confidence,
      };
    });
    if (!single) {
      for (const d of out) {
        if (!d.heading) {
          d.heading = source.heading;
          warnings.push({ assetId: source.assetId, message: "分けた発見の見出しが空だったので、元の見出しを入れました" });
        }
      }
      const whole = squash(source.excerpt);
      for (const d of out) {
        if (!whole.includes(squash(d.excerpt))) {
          warnings.push({ assetId: source.assetId, message: `抜粋が本文と一致しません: ${d.heading}` });
        }
      }
      warnings.push({ assetId: source.assetId, message: `${out.length} 件に分けました` });
    }
    for (const d of out) {
      if (d.isFood && d.ingredients.length === 0) {
        warnings.push({ assetId: source.assetId, message: `食べ物なのに材料がありません: ${d.heading}` });
      }
    }
    drafts.set(source.assetId, out);
  });
  return { drafts, warnings };
}

/** 公式ブログの記事番号 (…/diary/detail/68357 の 68357)。同じ日のブログの並びに使う */
export function blogDetailNumber(url: string | null | undefined): number {
  const m = (url ?? "").match(/detail\/(\d+)/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}

export interface NumberableDiscovery {
  /** ブログの日付 (JST, YYYY-MM-DD) */
  date: string;
  /** 公式ブログの URL */
  url: string | null;
  position: number;
}

/**
 * 通し番号を振る。ブログの日付 → 記事番号 → ブログ内の順。番号は保存しない (並びが変われば振り直す)。
 * サイトの一覧記事 (`render-discovery.ts`) と同じ並び。
 */
export function numberDiscoveries<T extends NumberableDiscovery>(rows: T[]): (T & { no: number })[] {
  return [...rows]
    .sort(
      (a, b) =>
        a.date.localeCompare(b.date) || blogDetailNumber(a.url) - blogDetailNumber(b.url) || a.position - b.position,
    )
    .map((r, i) => ({ ...r, no: i + 1 }));
}

// ---------------------------------------------------------------------------
// 食べ物の分類 (DiscoveryFood)
// ---------------------------------------------------------------------------

/** 分類。並びはサイトの見出しの順 */
export const FOOD_CATEGORIES = ["fruit", "vegetable", "sweet", "dish", "dairy", "seasoning", "drink"] as const;
export type FoodCategoryValue = (typeof FOOD_CATEGORIES)[number];

export const CategorizeResponseSchema = z.object({
  foods: z.array(z.object({ name: z.string(), category: z.enum(FOOD_CATEGORIES) })),
});
export type CategorizeResponse = z.infer<typeof CategorizeResponseSchema>;

const CATEGORIZE_SYSTEM_PROMPT = `あなたは食べ物の名前を分類する係です。渡された食べ物・飲み物の名前を、それぞれ次のどれか 1 つに分けてください。

- fruit: 果物 (りんご・みかん・いちご・アボカド・梨)
- vegetable: 野菜・いも・豆・きのこ (きゅうり・ほうれん草・じゃがいも・さつまいも・枝豆・とうもろこし)
- sweet: 甘いもの。お菓子・デザート・アイス・和菓子・あんこ・甘いパン (バニラアイス・プリン・あんこ・メロンパン・ポテトチップス)
- dish: 主食・おかず・おつまみ。ご飯・パン・麺・肉・魚・海藻・漬物・料理 (そば・唐揚げ・ベーコン・海苔・たくあん・マグロのお刺身・フライドポテト)
- dairy: 乳製品・卵 (ヨーグルト・チーズ・クリームチーズ・牛乳・バター・ホイップクリーム)
- seasoning: 調味料・油・香辛料・甘味料・ジャム (醤油・味噌・はちみつ・塩・黒こしょう・オリーブオイル・メープルシロップ)
- drink: 飲み物 (コーラ・ミルクティー・コーヒー・オレンジジュース・メロンソーダ)

迷ったら、食べるときの主な役どころで選ぶ (ポテトチップスはお菓子なので sweet、フライドポテトはおかずなので dish、お味噌汁は dish)。
渡された名前は一字一句そのまま name に写し、すべての名前について返してください。返すのは JSON だけです。`;

export function buildCategorizePrompt(names: string[]): { system: string; user: string } {
  return { system: CATEGORIZE_SYSTEM_PROMPT, user: names.map((n) => `- ${n}`).join("\n") };
}

/** 分類の返答のうち、頼んだ名前のものだけを残す (名前を写し間違えたものは捨てて、次の回に回す) */
export function finalizeCategories(names: string[], response: CategorizeResponse): Map<string, FoodCategoryValue> {
  const asked = new Set(names);
  const out = new Map<string, FoodCategoryValue>();
  for (const f of response.foods) if (asked.has(f.name) && !out.has(f.name)) out.set(f.name, f.category);
  return out;
}

/** 下書きに出てくる食べ物の名前 (材料とできあがる味) */
export function foodNamesOf(drafts: Iterable<Pick<DiscoveryDraft, "ingredients" | "result">>): string[] {
  const names = new Set<string>();
  for (const d of drafts) {
    for (const n of d.ingredients) names.add(n);
    if (d.result) names.add(d.result);
  }
  return [...names];
}
