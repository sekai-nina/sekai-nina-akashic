// 新しい migration だけを、ネットワークを持たない使い捨て PostgreSQL で検証する。
// .env や本番 URL は読み込まない。自分で作ったコンテナだけを終了する。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const container = `akashic-scenes-check-${process.pid}`;
const docker = (args, options = {}) => execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options });
const sql = (input) => docker(["exec", "-i", container, "psql", "-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-U", "postgres"], { input }).trim();
let created = false;
try {
  docker(["run", "--rm", "--detach", "--network", "none", "--name", container, "-e", "POSTGRES_PASSWORD=local-test-only", "postgres:17-alpine"]);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    try { docker(["exec", container, "pg_isready", "-U", "postgres"]); ready = true; break; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
  }
  assert(ready, "ローカルの PostgreSQL が起動しませんでした");
  sql(`CREATE ROLE app_runtime;
    CREATE TABLE "Asset" (id TEXT PRIMARY KEY, classification TEXT NOT NULL);
    CREATE FUNCTION clearance_rank(v TEXT) RETURNS INTEGER LANGUAGE SQL IMMUTABLE AS $$
      SELECT CASE v WHEN 'public' THEN 0 WHEN 'internal' THEN 1 WHEN 'confidential' THEN 2 WHEN 'restricted' THEN 3 ELSE -1 END $$;
    ALTER TABLE "Asset" ENABLE ROW LEVEL SECURITY;
    ALTER TABLE "Asset" FORCE ROW LEVEL SECURITY;
    CREATE POLICY asset_read ON "Asset" FOR SELECT TO app_runtime USING (
      clearance_rank(classification) <= clearance_rank(current_setting('app.clearance', true)));
    GRANT SELECT ON "Asset" TO app_runtime;`);
  sql(readFileSync(new URL("../prisma/migrations/20261116000000_video_scene_tasks/migration.sql", import.meta.url), "utf8"));
  sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON "VideoSceneTask", "VideoSceneFile" TO app_runtime;
    INSERT INTO "Asset" VALUES ('p','public'),('i','internal'),('s','confidential');
    INSERT INTO "VideoSceneTask" (id,"assetId","requestKey",kind,"requestedById","updatedAt") VALUES
      ('tp','p','p','analyze','tester',now()),('ti','i','i','analyze','tester',now()),('ts','s','s','analyze','tester',now());
    INSERT INTO "VideoSceneFile" (id,"taskId",slot,filename,"mimeType") VALUES
      ('fp','tp','s','p.jpg','image/jpeg'),('fi','ti','s','i.jpg','image/jpeg'),('fs','ts','s','s.jpg','image/jpeg');`);
  const counts = (clearance) => sql(`SET ROLE app_runtime; SET app.clearance = '${clearance}';
    SELECT (SELECT count(*) FROM "VideoSceneTask") || ',' || (SELECT count(*) FROM "VideoSceneFile");`);
  assert.equal(counts("public"), "1,1");
  assert.equal(counts("internal"), "2,2");
  assert.equal(counts("confidential"), "3,3");
  assert.equal(counts(""), "0,0");
  assert.equal(counts("unknown"), "0,0");
  assert.throws(() => sql(`SET ROLE app_runtime; SET app.clearance = 'internal';
    INSERT INTO "VideoSceneFile" (id,"taskId",slot,filename,"mimeType") VALUES ('denied','ts','x','x.jpg','image/jpeg');`));
  assert.throws(() => sql(`SET ROLE app_runtime; SET app.clearance = 'internal';
    INSERT INTO "VideoSceneTask" (id,"assetId","requestKey",kind,"requestedById","updatedAt") VALUES ('denied','s','denied','analyze','tester',now());`));
  sql(`UPDATE "Asset" SET classification='confidential' WHERE id='i';`);
  assert.equal(counts("internal"), "1,1");
  assert.throws(() => sql(`INSERT INTO "VideoSceneTask" (id,"assetId","requestKey",kind,"startSec","endSec","requestedById","updatedAt") VALUES ('bad','p','bad','export',0,91,'tester',now());`));
  assert.throws(() => sql(`INSERT INTO "VideoSceneTask" (id,"assetId","requestKey",kind,"requestedById","updatedAt") VALUES ('bad','p','bad','export','tester',now());`));
  assert.equal(sql(`SELECT count(*) FROM pg_policies WHERE tablename IN ('VideoSceneTask','VideoSceneFile');`), "8");
  console.log("PostgreSQL: 8 RLS policies, clearance isolation, denied writes, parent reclassification, and export bounds passed.");
} finally {
  if (created) docker(["stop", "--time", "2", container]);
}
