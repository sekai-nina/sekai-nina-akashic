-- Enable pg_trgm extension for fuzzy search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Trigram indexes for search
CREATE INDEX idx_asset_title_trgm ON "Asset" USING gin ("title" gin_trgm_ops);
CREATE INDEX idx_asset_description_trgm ON "Asset" USING gin ("description" gin_trgm_ops);
CREATE INDEX idx_asset_text_content_trgm ON "AssetText" USING gin ("content" gin_trgm_ops);
CREATE INDEX idx_asset_text_normalized_trgm ON "AssetText" USING gin ("normalizedContent" gin_trgm_ops);
CREATE INDEX idx_entity_name_trgm ON "Entity" USING gin ("canonicalName" gin_trgm_ops);
CREATE INDEX idx_entity_normalized_trgm ON "Entity" USING gin ("normalizedName" gin_trgm_ops);
