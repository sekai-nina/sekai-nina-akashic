-- Allow a single asset to be added to a dossier multiple times (one item per excerpt).
-- Previously a unique index limited each (dossierId, assetId) pair to one DossierItem,
-- so a second excerpt from the same asset overwrote the first.
DROP INDEX IF EXISTS "dossier_item_dossier_asset_unique";
