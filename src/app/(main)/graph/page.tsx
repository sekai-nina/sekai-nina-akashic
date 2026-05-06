import { prisma } from "@/lib/db";
import { FullGraph } from "./full-graph";

async function getFullGraphData() {
  // Get all relations
  const relations = await prisma.assetRelation.findMany({
    select: {
      sourceId: true,
      targetId: true,
      relationType: true,
    },
  });

  if (relations.length === 0) return { nodes: [], edges: [] };

  // Collect all unique asset IDs
  const assetIds = new Set<string>();
  for (const r of relations) {
    assetIds.add(r.sourceId);
    assetIds.add(r.targetId);
  }

  // Fetch asset summaries
  const assets = await prisma.asset.findMany({
    where: { id: { in: [...assetIds] } },
    select: {
      id: true,
      title: true,
      kind: true,
      thumbnailUrl: true,
      _count: { select: { relationsAsSource: true, relationsAsTarget: true } },
    },
  });

  const nodes = assets.map((a) => ({
    id: a.id,
    label: a.title || "(無題)",
    kind: a.kind,
    thumbnailUrl: a.thumbnailUrl,
    relationCount: a._count.relationsAsSource + a._count.relationsAsTarget,
  }));

  const edges = relations.map((r) => ({
    from: r.sourceId,
    to: r.targetId,
    relationType: r.relationType,
  }));

  return { nodes, edges };
}

export default async function GraphPage() {
  const { nodes, edges } = await getFullGraphData();

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
