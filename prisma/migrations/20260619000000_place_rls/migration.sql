-- ============================================================
-- Place table RLS
-- Place carries its own `classification` column, so it follows the
-- direct-classification pattern (identical to "Asset"). It was created in
-- 20260518120000_dossiers, after 20260511000000_add_rls, and was missed —
-- leaving it readable via the public PostgREST API (anon/authenticated).
-- ============================================================
ALTER TABLE "Place" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Place" FORCE ROW LEVEL SECURITY;

CREATE POLICY place_select ON "Place" FOR SELECT TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY place_insert ON "Place" FOR INSERT TO app_runtime WITH CHECK (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
CREATE POLICY place_update ON "Place" FOR UPDATE TO app_runtime
  USING (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)))
  WITH CHECK (clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true)));
CREATE POLICY place_delete ON "Place" FOR DELETE TO app_runtime USING (
  clearance_rank(classification::text) <= clearance_rank(current_setting('app.clearance', true))
);
