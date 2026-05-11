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
