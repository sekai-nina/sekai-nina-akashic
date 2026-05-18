-- ============================================================
-- Dossier (特定支援) feature
-- - Drop the legacy Collection / CollectionItem tables
-- - Add Dossier, DossierItem, DossierPlaceCandidate
-- - Add Place.status (confirmed / candidate)
-- - Set up RLS for the new tables
-- ============================================================

-- ------------------------------------------------------------
-- 1. Drop legacy Collection tables (data is intentionally discarded)
-- ------------------------------------------------------------
DROP POLICY IF EXISTS collectionitem_select ON "CollectionItem";
DROP POLICY IF EXISTS collectionitem_insert ON "CollectionItem";
DROP POLICY IF EXISTS collectionitem_update ON "CollectionItem";
DROP POLICY IF EXISTS collectionitem_delete ON "CollectionItem";

DROP TABLE IF EXISTS "CollectionItem";
DROP TABLE IF EXISTS "Collection";

-- ------------------------------------------------------------
-- 2. New enums
-- ------------------------------------------------------------
CREATE TYPE "DossierAccessMode" AS ENUM ('private', 'clearance');
CREATE TYPE "DossierItemKind"   AS ENUM ('asset_ref', 'external_link', 'external_image');
CREATE TYPE "PlaceStatus"       AS ENUM ('confirmed', 'candidate');

-- ------------------------------------------------------------
-- 3. Place.status
-- ------------------------------------------------------------
ALTER TABLE "Place" ADD COLUMN "status" "PlaceStatus" NOT NULL DEFAULT 'confirmed';
CREATE INDEX "Place_status_idx" ON "Place"("status");

-- ------------------------------------------------------------
-- 4. Dossier
-- ------------------------------------------------------------
CREATE TABLE "Dossier" (
  "id"             TEXT NOT NULL,
  "ownerId"        TEXT NOT NULL,
  "title"          TEXT NOT NULL,
  "summary"        TEXT NOT NULL DEFAULT '',
  "classification" "ClearanceLevel"    NOT NULL DEFAULT 'internal',
  "viewMode"       "DossierAccessMode" NOT NULL DEFAULT 'private',
  "editMode"       "DossierAccessMode" NOT NULL DEFAULT 'private',
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Dossier_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "Dossier" ADD CONSTRAINT "Dossier_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Dossier_ownerId_idx"        ON "Dossier"("ownerId");
CREATE INDEX "Dossier_classification_idx" ON "Dossier"("classification");
CREATE INDEX "Dossier_updatedAt_idx"      ON "Dossier"("updatedAt");

-- ------------------------------------------------------------
-- 5. DossierItem
-- ------------------------------------------------------------
CREATE TABLE "DossierItem" (
  "id"                    TEXT NOT NULL,
  "dossierId"             TEXT NOT NULL,
  "kind"                  "DossierItemKind" NOT NULL DEFAULT 'asset_ref',
  "assetId"               TEXT,
  "externalUrl"           TEXT,
  "externalImageKey"      TEXT,
  "externalImageThumbKey" TEXT,
  "caption"               TEXT NOT NULL DEFAULT '',
  "note"                  TEXT NOT NULL DEFAULT '',
  "excerpt"               TEXT NOT NULL DEFAULT '',
  "excerptType"           "TextType",
  "excerptStart"          INTEGER,
  "excerptEnd"            INTEGER,
  "sortOrder"             INTEGER NOT NULL DEFAULT 0,
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DossierItem_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "DossierItem" ADD CONSTRAINT "DossierItem_dossierId_fkey"
  FOREIGN KEY ("dossierId") REFERENCES "Dossier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DossierItem" ADD CONSTRAINT "DossierItem_assetId_fkey"
  FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "dossier_item_dossier_asset_unique" ON "DossierItem"("dossierId", "assetId");
CREATE INDEX "DossierItem_dossierId_idx" ON "DossierItem"("dossierId");
CREATE INDEX "DossierItem_assetId_idx"   ON "DossierItem"("assetId");

-- ------------------------------------------------------------
-- 6. DossierPlaceCandidate
-- ------------------------------------------------------------
CREATE TABLE "DossierPlaceCandidate" (
  "id"            TEXT NOT NULL,
  "dossierId"     TEXT NOT NULL,
  "placeId"       TEXT,
  "name"          TEXT NOT NULL DEFAULT '',
  "latitude"      DOUBLE PRECISION,
  "longitude"     DOUBLE PRECISION,
  "address"       TEXT,
  "googleMapsUrl" TEXT,
  "note"          TEXT NOT NULL DEFAULT '',
  "confidence"    INTEGER NOT NULL DEFAULT 0,
  "sortOrder"     INTEGER NOT NULL DEFAULT 0,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DossierPlaceCandidate_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "DossierPlaceCandidate" ADD CONSTRAINT "DossierPlaceCandidate_dossierId_fkey"
  FOREIGN KEY ("dossierId") REFERENCES "Dossier"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DossierPlaceCandidate" ADD CONSTRAINT "DossierPlaceCandidate_placeId_fkey"
  FOREIGN KEY ("placeId") REFERENCES "Place"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "DossierPlaceCandidate_dossierId_idx" ON "DossierPlaceCandidate"("dossierId");
CREATE INDEX "DossierPlaceCandidate_placeId_idx"   ON "DossierPlaceCandidate"("placeId");

-- ------------------------------------------------------------
-- 7. RLS for Dossier
-- ownerId-based for 'private', clearance-based for 'clearance' mode.
-- Requires both app.user_id and app.clearance session settings.
-- clearance_rank() is defined in 20260511000000_add_rls.
-- ------------------------------------------------------------
ALTER TABLE "Dossier" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Dossier" FORCE  ROW LEVEL SECURITY;

CREATE POLICY dossier_select ON "Dossier" FOR SELECT TO app_runtime USING (
  "ownerId" = current_setting('app.user_id', true)
  OR (
    "viewMode" = 'clearance'
    AND clearance_rank(classification::text)
        <= clearance_rank(current_setting('app.clearance', true))
  )
);
CREATE POLICY dossier_insert ON "Dossier" FOR INSERT TO app_runtime WITH CHECK (
  "ownerId" = current_setting('app.user_id', true)
  AND clearance_rank(classification::text)
      <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY dossier_update ON "Dossier" FOR UPDATE TO app_runtime
  USING (
    "ownerId" = current_setting('app.user_id', true)
    OR (
      "editMode" = 'clearance'
      AND clearance_rank(classification::text)
          <= clearance_rank(current_setting('app.clearance', true))
    )
  )
  WITH CHECK (
    "ownerId" = current_setting('app.user_id', true)
    OR (
      "editMode" = 'clearance'
      AND clearance_rank(classification::text)
          <= clearance_rank(current_setting('app.clearance', true))
    )
  );
CREATE POLICY dossier_delete ON "Dossier" FOR DELETE TO app_runtime USING (
  "ownerId" = current_setting('app.user_id', true)
);

-- ------------------------------------------------------------
-- 8. RLS for DossierItem
-- Visible/mutable iff the parent Dossier passes its own SELECT/UPDATE policy.
-- For mutation we additionally require the asset (if any) to be accessible
-- under the active clearance — mirrors the pattern used by CollectionItem.
-- ------------------------------------------------------------
ALTER TABLE "DossierItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DossierItem" FORCE  ROW LEVEL SECURITY;

CREATE POLICY dossieritem_select ON "DossierItem" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Dossier" WHERE id = "DossierItem"."dossierId")
);
CREATE POLICY dossieritem_insert ON "DossierItem" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (
    SELECT 1 FROM "Dossier" d
    WHERE d.id = "DossierItem"."dossierId"
      AND (
        d."ownerId" = current_setting('app.user_id', true)
        OR (
          d."editMode" = 'clearance'
          AND clearance_rank(d.classification::text)
              <= clearance_rank(current_setting('app.clearance', true))
        )
      )
  )
  AND (
    "assetId" IS NULL
    OR EXISTS (
      SELECT 1 FROM "Asset" a
      WHERE a.id = "DossierItem"."assetId"
        AND clearance_rank(a.classification::text)
            <= clearance_rank(current_setting('app.clearance', true))
    )
  )
);
CREATE POLICY dossieritem_update ON "DossierItem" FOR UPDATE TO app_runtime
  USING (
    EXISTS (
      SELECT 1 FROM "Dossier" d
      WHERE d.id = "DossierItem"."dossierId"
        AND (
          d."ownerId" = current_setting('app.user_id', true)
          OR (
            d."editMode" = 'clearance'
            AND clearance_rank(d.classification::text)
                <= clearance_rank(current_setting('app.clearance', true))
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Dossier" d
      WHERE d.id = "DossierItem"."dossierId"
        AND (
          d."ownerId" = current_setting('app.user_id', true)
          OR (
            d."editMode" = 'clearance'
            AND clearance_rank(d.classification::text)
                <= clearance_rank(current_setting('app.clearance', true))
          )
        )
    )
  );
CREATE POLICY dossieritem_delete ON "DossierItem" FOR DELETE TO app_runtime USING (
  EXISTS (
    SELECT 1 FROM "Dossier" d
    WHERE d.id = "DossierItem"."dossierId"
      AND (
        d."ownerId" = current_setting('app.user_id', true)
        OR (
          d."editMode" = 'clearance'
          AND clearance_rank(d.classification::text)
              <= clearance_rank(current_setting('app.clearance', true))
        )
      )
  )
);

-- ------------------------------------------------------------
-- 9. RLS for DossierPlaceCandidate (same shape as DossierItem)
-- ------------------------------------------------------------
ALTER TABLE "DossierPlaceCandidate" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "DossierPlaceCandidate" FORCE  ROW LEVEL SECURITY;

CREATE POLICY dossierplace_select ON "DossierPlaceCandidate" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Dossier" WHERE id = "DossierPlaceCandidate"."dossierId")
);
CREATE POLICY dossierplace_insert ON "DossierPlaceCandidate" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (
    SELECT 1 FROM "Dossier" d
    WHERE d.id = "DossierPlaceCandidate"."dossierId"
      AND (
        d."ownerId" = current_setting('app.user_id', true)
        OR (
          d."editMode" = 'clearance'
          AND clearance_rank(d.classification::text)
              <= clearance_rank(current_setting('app.clearance', true))
        )
      )
  )
);
CREATE POLICY dossierplace_update ON "DossierPlaceCandidate" FOR UPDATE TO app_runtime
  USING (
    EXISTS (
      SELECT 1 FROM "Dossier" d
      WHERE d.id = "DossierPlaceCandidate"."dossierId"
        AND (
          d."ownerId" = current_setting('app.user_id', true)
          OR (
            d."editMode" = 'clearance'
            AND clearance_rank(d.classification::text)
                <= clearance_rank(current_setting('app.clearance', true))
          )
        )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "Dossier" d
      WHERE d.id = "DossierPlaceCandidate"."dossierId"
        AND (
          d."ownerId" = current_setting('app.user_id', true)
          OR (
            d."editMode" = 'clearance'
            AND clearance_rank(d.classification::text)
                <= clearance_rank(current_setting('app.clearance', true))
          )
        )
    )
  );
CREATE POLICY dossierplace_delete ON "DossierPlaceCandidate" FOR DELETE TO app_runtime USING (
  EXISTS (
    SELECT 1 FROM "Dossier" d
    WHERE d.id = "DossierPlaceCandidate"."dossierId"
      AND (
        d."ownerId" = current_setting('app.user_id', true)
        OR (
          d."editMode" = 'clearance'
          AND clearance_rank(d.classification::text)
              <= clearance_rank(current_setting('app.clearance', true))
        )
      )
  )
);
