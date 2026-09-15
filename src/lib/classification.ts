import { ClearanceLevel, Prisma } from "@prisma/client";

const LEVEL_ORDER: Record<ClearanceLevel, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

/**
 * Returns classification levels accessible to a user with given clearance.
 * Higher clearance includes all lower levels.
 */
export function accessibleClassifications(
  userClearance: ClearanceLevel
): ClearanceLevel[] {
  const maxLevel = LEVEL_ORDER[userClearance];
  return (Object.entries(LEVEL_ORDER) as [ClearanceLevel, number][])
    .filter(([, v]) => v <= maxLevel)
    .map(([k]) => k);
}

/**
 * Prisma WHERE clause fragment for filtering assets by classification.
 */
export function classificationFilter(userClearance: ClearanceLevel | string) {
  return {
    classification: { in: accessibleClassifications(userClearance as ClearanceLevel) },
  };
}

/**
 * Raw SQL WHERE clause fragment for filtering assets by classification.
 * Expects the Asset table to be aliased as "a" or specify the alias.
 */
export function classificationFilterSql(
  userClearance: ClearanceLevel | string,
  alias = "a"
): Prisma.Sql {
  const levels = accessibleClassifications(userClearance as ClearanceLevel);
  const values = levels.map((l) => Prisma.sql`${l}::"ClearanceLevel"`);
  return Prisma.sql`${Prisma.raw(`"${alias}"."classification"`)} IN (${Prisma.join(values)})`;
}

/**
 * Assert that a user has sufficient clearance for an asset.
 * Throws if insufficient — fail-closed design.
 */
export function assertClearance(
  userClearance: ClearanceLevel | string,
  assetClassification: ClearanceLevel | string
): void {
  const userLevel = LEVEL_ORDER[userClearance as ClearanceLevel];
  const assetLevel = LEVEL_ORDER[assetClassification as ClearanceLevel];
  if (userLevel === undefined || assetLevel === undefined) {
    throw new Error("Access denied: unknown clearance level");
  }
  if (userLevel < assetLevel) {
    throw new Error("Access denied: insufficient clearance");
  }
}

/**
 * 機密レベルの引き下げ (例: restricted -> public) にあたるかを返す。
 *
 * `assertClearance` は「自分のクリアランスより上を付ける」操作しか止めない。
 * 引き下げは常に自分のクリアランス以下なので素通りし、RLS も USING / WITH CHECK の
 * 両方が通るため止まらない。機械 (MCP 経由の AI) からの再分類を防ぐのに使う。
 */
export function isClassificationDowngrade(
  current: ClearanceLevel | string,
  requested: ClearanceLevel | string
): boolean {
  const currentLevel = LEVEL_ORDER[current as ClearanceLevel];
  const requestedLevel = LEVEL_ORDER[requested as ClearanceLevel];
  // 未知の値は fail-closed で「引き下げ」扱いにして止める
  if (currentLevel === undefined || requestedLevel === undefined) return true;
  return requestedLevel < currentLevel;
}
