import { withClearance } from "@/lib/db";
import { auth } from "@/lib/auth";
import { FullGraph } from "./full-graph";

const NINA_ENTITY_ID = "cmmtp8vrg0004mo381neyztvn";

async function getFullGraphData(clearance: string) {
  return withClearance(clearance, async (tx) => {
    // Get asset IDs linked to Nina (filtered by RLS)
    const ninaAssets = await tx.assetEntity.findMany({
      where: { entityId: NINA_ENTITY_ID },
      select: { assetId: true },
    });
    const ninaAssetIds = new Set(ninaAssets.map((a) => a.assetId));

    if (ninaAssetIds.size === 0) return { nodes: [], edges: [] };

    // Get relations where at least one side is a Nina asset
    const relations = await tx.assetRelation.findMany({
      where: {
        OR: [
          { sourceId: { in: [...ninaAssetIds] } },
          { targetId: { in: [...ninaAssetIds] } },
        ],
      },
      select: {
        sourceId: true,
        targetId: true,
        relationType: true,
      },
    });

    if (relations.length === 0) return { nodes: [], edges: [] };

    // Collect all unique asset IDs (including non-Nina neighbors)
    const assetIds = new Set<string>();
    for (const r of relations) {
      assetIds.add(r.sourceId);
      assetIds.add(r.targetId);
    }

    const assets = await tx.asset.findMany({
      where: { id: { in: [...assetIds] } },
      select: {
        id: true,
        title: true,
        kind: true,
        thumbnailUrl: true,
        _count: { select: { relationsAsSource: true, relationsAsTarget: true } },
      },
    });

    // Only include edges where both ends are visible
    const visibleIds = new Set(assets.map((a) => a.id));

    const nodes = assets.map((a) => ({
      id: a.id,
      label: a.title || "(無題)",
      kind: a.kind,
      thumbnailUrl: a.thumbnailUrl,
      relationCount: a._count.relationsAsSource + a._count.relationsAsTarget,
    }));

    const edges = relations
      .filter((r) => visibleIds.has(r.sourceId) && visibleIds.has(r.targetId))
      .map((r) => ({
        from: r.sourceId,
        to: r.targetId,
        relationType: r.relationType,
      }));

    return { nodes, edges };
  });
}

export default async function GraphPage() {
  const session = await auth();
  const userClearance = session!.user.clearance;
  const { nodes, edges } = await getFullGraphData(userClearance);

  return (
    <div className="max-w-6xl mx-auto py-6 space-y-4">
      <div>
        <h1 className="text-xl font-bold text-slate-900">グラフビュー</h1>
        <p className="text-sm text-slate-500 mt-1">
          {nodes.length} アセット / {edges.length} リレーション
        </p>
      </div>
      <FullGraph nodes={nodes} edges={edges} />
    </div>
  );
}
