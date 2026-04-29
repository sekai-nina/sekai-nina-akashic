-- Drop PGroonga indexes (Supabase does not support PGroonga)
DROP INDEX IF EXISTS "Asset_title_pgroonga_idx";
DROP INDEX IF EXISTS "Asset_description_pgroonga_idx";
DROP INDEX IF EXISTS "Asset_messageBodyPreview_pgroonga_idx";
DROP INDEX IF EXISTS "AssetText_content_pgroonga_idx";
DROP INDEX IF EXISTS "AssetText_normalizedContent_pgroonga_idx";
DROP INDEX IF EXISTS "Entity_canonicalName_pgroonga_idx";

-- Drop PGroonga extension
DROP EXTENSION IF EXISTS pgroonga;
