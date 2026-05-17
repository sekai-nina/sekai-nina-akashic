-- Re-enable pg_trgm extension for ILIKE acceleration
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- GIN trigram indexes for Asset search fields
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_asset_title_trgm
  ON "Asset" USING gin ("title" gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_asset_description_trgm
  ON "Asset" USING gin ("description" gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_asset_message_preview_trgm
  ON "Asset" USING gin ("messageBodyPreview" gin_trgm_ops);

-- GIN trigram indexes for AssetText full-text search
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_asset_text_content_trgm
  ON "AssetText" USING gin ("content" gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_asset_text_normalized_trgm
  ON "AssetText" USING gin ("normalizedContent" gin_trgm_ops);

-- GIN trigram indexes for Entity name search
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_name_trgm
  ON "Entity" USING gin ("canonicalName" gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entity_normalized_trgm
  ON "Entity" USING gin ("normalizedName" gin_trgm_ops);
