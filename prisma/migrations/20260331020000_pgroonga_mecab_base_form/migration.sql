-- Recreate PGroonga indexes with TokenMecab + use_base_form
-- This normalizes conjugated forms to their dictionary form
-- (e.g. 食べている/食べた/食べます → 食べる)

DROP INDEX IF EXISTS "Asset_title_pgroonga_idx";
DROP INDEX IF EXISTS "Asset_description_pgroonga_idx";
DROP INDEX IF EXISTS "Asset_messageBodyPreview_pgroonga_idx";
DROP INDEX IF EXISTS "AssetText_content_pgroonga_idx";
DROP INDEX IF EXISTS "AssetText_normalizedContent_pgroonga_idx";
DROP INDEX IF EXISTS "Entity_canonicalName_pgroonga_idx";

CREATE INDEX "Asset_title_pgroonga_idx"
  ON "Asset" USING pgroonga ("title")
  WITH (tokenizer = 'TokenMecab("use_base_form", true)');
CREATE INDEX "Asset_description_pgroonga_idx"
  ON "Asset" USING pgroonga ("description")
  WITH (tokenizer = 'TokenMecab("use_base_form", true)');
CREATE INDEX "Asset_messageBodyPreview_pgroonga_idx"
  ON "Asset" USING pgroonga ("messageBodyPreview")
  WITH (tokenizer = 'TokenMecab("use_base_form", true)')
  WHERE "messageBodyPreview" IS NOT NULL;

CREATE INDEX "AssetText_content_pgroonga_idx"
  ON "AssetText" USING pgroonga ("content")
  WITH (tokenizer = 'TokenMecab("use_base_form", true)');
CREATE INDEX "AssetText_normalizedContent_pgroonga_idx"
  ON "AssetText" USING pgroonga ("normalizedContent")
  WITH (tokenizer = 'TokenMecab("use_base_form", true)');

CREATE INDEX "Entity_canonicalName_pgroonga_idx"
  ON "Entity" USING pgroonga ("canonicalName")
  WITH (tokenizer = 'TokenMecab("use_base_form", true)');
