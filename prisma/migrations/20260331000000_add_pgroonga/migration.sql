-- Enable PGroonga extension for Japanese full-text search
CREATE EXTENSION IF NOT EXISTS pgroonga;

-- PGroonga indexes for Asset columns
CREATE INDEX IF NOT EXISTS "Asset_title_pgroonga_idx"
  ON "Asset" USING pgroonga ("title");
CREATE INDEX IF NOT EXISTS "Asset_description_pgroonga_idx"
  ON "Asset" USING pgroonga ("description");
CREATE INDEX IF NOT EXISTS "Asset_messageBodyPreview_pgroonga_idx"
  ON "Asset" USING pgroonga ("messageBodyPreview")
  WHERE "messageBodyPreview" IS NOT NULL;

-- PGroonga indexes for AssetText
CREATE INDEX IF NOT EXISTS "AssetText_content_pgroonga_idx"
  ON "AssetText" USING pgroonga ("content");
CREATE INDEX IF NOT EXISTS "AssetText_normalizedContent_pgroonga_idx"
  ON "AssetText" USING pgroonga ("normalizedContent");

-- PGroonga index for Entity name search
CREATE INDEX IF NOT EXISTS "Entity_canonicalName_pgroonga_idx"
  ON "Entity" USING pgroonga ("canonicalName");
