import { after } from "next/server";
import { createAsset, type CreateAssetData } from "./assets";
import { extractTestimonials } from "./testimonials";
import { invalidateAssets } from "@/lib/cache";

/** 坂井新奈のentityId（口コミ抽出対象） */
export const NINA_ENTITY_ID = "cmmtp8vrg0004mo381neyztvn";

export type AssetIntakeData = Omit<CreateAssetData, "classification"> & {
  classification?: CreateAssetData["classification"];
};

/**
 * 外部からのアセット作成の共通経路。REST (`POST /api/v1/assets`) と
 * MCP (`akashic_create_asset`) の両方がここを通る。
 *
 * createAsset との違いは付帯処理の有無:
 * - classification の既定値 (internal) を埋める
 * - web(ブログ)由来なら口コミ抽出をバックグラウンドで走らせる
 * - 一覧・統計のキャッシュを飛ばす
 *
 * クリアランス超過の書き込みは createAsset 内の assertClearance が投げる。
 * リクエストスコープ外 (CLI 等) からは after() が使えないので呼ばないこと。
 */
export async function intakeAsset(
  data: AssetIntakeData,
  userId: string | null,
  clearance: string
) {
  const asset = await createAsset(
    // `??` ではなく `||` — REST の旧実装が falsy 判定だったので、空文字も internal に倒す
    { ...data, classification: data.classification || "internal" },
    userId,
    clearance
  );

  // ブログ本文からの口コミ抽出はこのアセットだけに絞って非同期で走らせる
  if (data.sourceType === "web" && process.env.OPENAI_API_KEY) {
    after(async () => {
      try {
        await extractTestimonials({
          entityId: NINA_ENTITY_ID,
          limit: 20,
          assetId: asset.id,
        });
      } catch (err) {
        console.error("[testimonials] background extraction failed:", err);
      }
    });
  }

  invalidateAssets();

  return asset;
}
