/**
 * スケッチ生成の設定 (#136)。**全体で 1 行**。
 *
 * プロンプト本体と画風の見本がコードに埋め込みで、直すのにデプロイが要った。
 * ここに置いて画面から直せるようにする。
 *
 * **行が無い / 空のときは組み込みの既定を使う。** 設定を入れ忘れて生成が止まるより、
 * いまの文面で動き続けるほうが事故が小さい (`AiSetting` と同じ考え方)。
 */

import { classificationFilter } from "@/lib/classification";
import { withClearance } from "@/lib/db";
import { getR2PublicUrl } from "@/lib/r2";
import { MAX_EXTERNAL_AI_CLEARANCE } from "@/lib/meetgreet/config";
import { STYLE_REFERENCE_KEY } from "@/lib/meetgreet/sketch";
import { SKETCH_PROMPT } from "@/lib/meetgreet/sketch-prompt";

export const SINGLETON_ID = "singleton";

/**
 * **設定は固定のクリアランスで読む。**
 *
 * 行は internal なので、操作している人のクリアランスで読むと public の人には
 * 無言で 0 行になり、「既定の文面で生成された」ことに誰も気づけない
 * (`renderArticlesForPush` の `PUSH_CLEARANCE` と同じ考え方)。
 * 設定は個人のデータではなく運用の設定なので、読みは一律この値で行う。
 */
const SETTING_CLEARANCE = MAX_EXTERNAL_AI_CLEARANCE;

/** 見本に選べる上限。**生成のたびに外部 AI へ送るので、参照写真と同じ天井を掛ける** */
export const MAX_STYLE_REFERENCE_CLEARANCE = MAX_EXTERNAL_AI_CLEARANCE;

/** 見本の候補として出す枚数 (画面と検証で同じものを使う) */
export const CONFIRMED_SKETCH_LIMIT = 24;

export interface SketchSettingView {
  /** 実際に使われるプロンプト (未設定なら組み込みの既定) */
  prompt: string;
  /** 画面で「既定のまま」と見せるため */
  isDefaultPrompt: boolean;
  /** 実際に使われる画風の見本の R2 key */
  styleReferenceKey: string;
  isDefaultStyleReference: boolean;
  /** 見本の表示用 URL (R2 未設定なら null) */
  styleReferenceUrl: string | null;
  updatedAt: Date | null;
  updatedByName: string | null;
}

/** 組み込みの既定 (画面で「既定に戻す」を出すのに使う) */
export const DEFAULT_SKETCH_PROMPT = SKETCH_PROMPT;
export const DEFAULT_STYLE_REFERENCE_KEY = STYLE_REFERENCE_KEY;

function view(row: {
  prompt: string;
  styleReferenceKey: string;
  updatedAt: Date;
  updatedBy: { name: string } | null;
} | null): SketchSettingView {
  const prompt = row?.prompt.trim() ? row.prompt : DEFAULT_SKETCH_PROMPT;
  const styleReferenceKey = row?.styleReferenceKey.trim()
    ? row.styleReferenceKey
    : DEFAULT_STYLE_REFERENCE_KEY;
  const url = getR2PublicUrl(styleReferenceKey);
  return {
    prompt,
    isDefaultPrompt: prompt === DEFAULT_SKETCH_PROMPT,
    styleReferenceKey,
    isDefaultStyleReference: styleReferenceKey === DEFAULT_STYLE_REFERENCE_KEY,
    styleReferenceUrl: /^https?:\/\//.test(url) ? url : null,
    updatedAt: row?.updatedAt ?? null,
    updatedByName: row?.updatedBy?.name ?? null,
  };
}

/** 画風の見本に使える「確定済みスケッチ」。差し替えの選択肢に出す (#136) */
export interface ConfirmedSketch {
  key: string;
  url: string;
  /** どの回のものか (選ぶときの手がかり) */
  label: string;
}

export async function listConfirmedSketches(
  clearance: string,
  limit = CONFIRMED_SKETCH_LIMIT
): Promise<ConfirmedSketch[]> {
  const rows = await withClearance(clearance, (tx) =>
    tx.meetGreet.findMany({
      // **機密レベルの天井を掛ける。** RLS だけだと「操作している人に見えるもの」で
      // 止まり、restricted の回のスケッチを見本にできてしまう。見本は生成のたびに
      // 外部 AI へ送られ、ミーグリ画面を開ける人全員に表示される
      where: {
        sketchKey: { not: null },
        ...classificationFilter(MAX_STYLE_REFERENCE_CLEARANCE),
      },
      orderBy: { date: "desc" },
      take: limit,
      select: { sketchKey: true, date: true, venue: true, label: true },
    })
  );
  return rows.flatMap((r) => {
    if (!r.sketchKey) return [];
    const url = getR2PublicUrl(r.sketchKey);
    if (!/^https?:\/\//.test(url)) return [];
    return [
      {
        key: r.sketchKey,
        url,
        label: [r.date, r.venue?.trim() || r.label].filter(Boolean).join(" "),
      },
    ];
  });
}

export async function getSketchSetting(): Promise<SketchSettingView> {
  const row = await withClearance(SETTING_CLEARANCE, (tx) =>
    tx.sketchSetting.findUnique({
      where: { id: SINGLETON_ID },
      select: {
        prompt: true,
        styleReferenceKey: true,
        updatedAt: true,
        updatedBy: { select: { name: true } },
      },
    })
  );
  return view(row);
}

export interface SketchSettingInput {
  /** 空文字・未設定なら既定に戻す */
  prompt?: string;
  styleReferenceKey?: string;
}

export async function updateSketchSetting(
  input: SketchSettingInput,
  userId: string
): Promise<SketchSettingView> {
  // 既定と同じ文面を入れたら「未設定」に畳む (既定を直したときに追随するように)
  const prompt =
    input.prompt === undefined
      ? undefined
      : input.prompt.trim() === "" || input.prompt === DEFAULT_SKETCH_PROMPT
        ? ""
        : input.prompt;
  const styleReferenceKey =
    input.styleReferenceKey === undefined
      ? undefined
      : input.styleReferenceKey.trim() === "" ||
          input.styleReferenceKey === DEFAULT_STYLE_REFERENCE_KEY
        ? ""
        : input.styleReferenceKey.trim();

  await withClearance(SETTING_CLEARANCE, (tx) =>
    tx.sketchSetting.upsert({
      where: { id: SINGLETON_ID },
      create: {
        id: SINGLETON_ID,
        prompt: prompt ?? "",
        styleReferenceKey: styleReferenceKey ?? "",
        updatedById: userId,
      },
      update: {
        ...(prompt !== undefined && { prompt }),
        ...(styleReferenceKey !== undefined && { styleReferenceKey }),
        updatedById: userId,
      },
    })
  );
  return getSketchSetting();
}
