-- ============================================================
-- RLS (Row Level Security) for classification-based access control
-- ============================================================

-- Helper function: convert clearance level text to integer for comparison
CREATE OR REPLACE FUNCTION clearance_rank(level text) RETURNS int
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE level
    WHEN 'public' THEN 0
    WHEN 'internal' THEN 1
    WHEN 'confidential' THEN 2
    WHEN 'restricted' THEN 3
    ELSE -1  -- unknown/unset => see nothing (fail-closed)
  END;
$$;

-- ============================================================
-- Asset table RLS
-- ============================================================
ALTER TABLE "Asset" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Asset" FORCE ROW LEVEL SECURITY;

CREATE POLICY asset_select ON "Asset" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY asset_insert ON "Asset" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY asset_update ON "Asset" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY asset_delete ON "Asset" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);

-- ============================================================
-- Child table RLS (assetId-based, 6 tables)
-- Pattern: row is accessible only if parent Asset is accessible
-- ============================================================

-- AssetText
ALTER TABLE "AssetText" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetText" FORCE ROW LEVEL SECURITY;

CREATE POLICY assettext_select ON "AssetText" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetText"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY assettext_insert ON "AssetText" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetText"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY assettext_update ON "AssetText" FOR UPDATE TO app_runtime
  USING (EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetText"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))))
  WITH CHECK (EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetText"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY assettext_delete ON "AssetText" FOR DELETE TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetText"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));

-- AssetEntity
ALTER TABLE "AssetEntity" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetEntity" FORCE ROW LEVEL SECURITY;

CREATE POLICY assetentity_select ON "AssetEntity" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetEntity"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY assetentity_insert ON "AssetEntity" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetEntity"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY assetentity_update ON "AssetEntity" FOR UPDATE TO app_runtime
  USING (EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetEntity"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))))
  WITH CHECK (EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetEntity"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY assetentity_delete ON "AssetEntity" FOR DELETE TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetEntity"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));

-- SourceRecord
ALTER TABLE "SourceRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "SourceRecord" FORCE ROW LEVEL SECURITY;

CREATE POLICY sourcerecord_select ON "SourceRecord" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "SourceRecord"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY sourcerecord_insert ON "SourceRecord" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "SourceRecord"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY sourcerecord_update ON "SourceRecord" FOR UPDATE TO app_runtime
  USING (EXISTS (SELECT 1 FROM "Asset" WHERE id = "SourceRecord"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))))
  WITH CHECK (EXISTS (SELECT 1 FROM "Asset" WHERE id = "SourceRecord"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY sourcerecord_delete ON "SourceRecord" FOR DELETE TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "SourceRecord"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));

-- Annotation
ALTER TABLE "Annotation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Annotation" FORCE ROW LEVEL SECURITY;

CREATE POLICY annotation_select ON "Annotation" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "Annotation"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY annotation_insert ON "Annotation" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "Annotation"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY annotation_update ON "Annotation" FOR UPDATE TO app_runtime
  USING (EXISTS (SELECT 1 FROM "Asset" WHERE id = "Annotation"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))))
  WITH CHECK (EXISTS (SELECT 1 FROM "Asset" WHERE id = "Annotation"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY annotation_delete ON "Annotation" FOR DELETE TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "Annotation"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));

-- CollectionItem
ALTER TABLE "CollectionItem" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CollectionItem" FORCE ROW LEVEL SECURITY;

CREATE POLICY collectionitem_select ON "CollectionItem" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "CollectionItem"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY collectionitem_insert ON "CollectionItem" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "CollectionItem"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY collectionitem_update ON "CollectionItem" FOR UPDATE TO app_runtime
  USING (EXISTS (SELECT 1 FROM "Asset" WHERE id = "CollectionItem"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))))
  WITH CHECK (EXISTS (SELECT 1 FROM "Asset" WHERE id = "CollectionItem"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY collectionitem_delete ON "CollectionItem" FOR DELETE TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "CollectionItem"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));

-- Testimonial
ALTER TABLE "Testimonial" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Testimonial" FORCE ROW LEVEL SECURITY;

CREATE POLICY testimonial_select ON "Testimonial" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "Testimonial"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY testimonial_insert ON "Testimonial" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "Testimonial"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY testimonial_update ON "Testimonial" FOR UPDATE TO app_runtime
  USING (EXISTS (SELECT 1 FROM "Asset" WHERE id = "Testimonial"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))))
  WITH CHECK (EXISTS (SELECT 1 FROM "Asset" WHERE id = "Testimonial"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY testimonial_delete ON "Testimonial" FOR DELETE TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "Testimonial"."assetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));

-- ============================================================
-- AssetRelation (both endpoints must be accessible)
-- ============================================================
ALTER TABLE "AssetRelation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AssetRelation" FORCE ROW LEVEL SECURITY;

CREATE POLICY assetrelation_select ON "AssetRelation" FOR SELECT TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetRelation"."sourceId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  AND EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetRelation"."targetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY assetrelation_insert ON "AssetRelation" FOR INSERT TO app_runtime WITH CHECK (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetRelation"."sourceId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  AND EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetRelation"."targetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY assetrelation_update ON "AssetRelation" FOR UPDATE TO app_runtime
  USING (
    EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetRelation"."sourceId"
      AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
    AND EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetRelation"."targetId"
      AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))))
  WITH CHECK (
    EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetRelation"."sourceId"
      AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
    AND EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetRelation"."targetId"
      AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
CREATE POLICY assetrelation_delete ON "AssetRelation" FOR DELETE TO app_runtime USING (
  EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetRelation"."sourceId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  AND EXISTS (SELECT 1 FROM "Asset" WHERE id = "AssetRelation"."targetId"
    AND clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))));
