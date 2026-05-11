import { RelationType } from "@prisma/client";
import { withClearance } from "@/lib/db";
import { logAudit } from "./audit";

const ASSET_SUMMARY_SELECT = {
  id: true,
  title: true,
  kind: true,
  thumbnailUrl: true,
  status: true,
  canonicalDate: true,
} as const;

export async function createAssetRelation(
  data: {
    sourceId: string;
    targetId: string;
    relationType: RelationType;
    metadata?: Record<string, unknown>;
    sortOrder?: number;
  },
  userId: string | null,
  clearance: string,
) {
  if (data.sourceId === data.targetId) {
    throw new Error("Cannot create a relation to the same asset");
  }

  const relation = await withClearance(clearance, async (tx) => {
    // Verify both assets exist (RLS filters by clearance)
    const [source, target] = await Promise.all([
      tx.asset.findUnique({ where: { id: data.sourceId }, select: { id: true } }),
      tx.asset.findUnique({ where: { id: data.targetId }, select: { id: true } }),
    ]);
    if (!source) throw new Error("Source asset not found");
    if (!target) throw new Error("Target asset not found");

    // Prevent direct parent_child cycle (A→B and B→A)
    if (data.relationType === "parent_child") {
      const reverse = await tx.assetRelation.findUnique({
        where: {
          sourceId_targetId_relationType: {
            sourceId: data.targetId,
            targetId: data.sourceId,
            relationType: "parent_child",
          },
        },
      });
      if (reverse) {
        throw new Error("Circular parent_child relation detected");
      }
    }

    return tx.assetRelation.create({
      data: {
        sourceId: data.sourceId,
        targetId: data.targetId,
        relationType: data.relationType,
        metadata: (data.metadata ?? {}) as object,
        sortOrder: data.sortOrder ?? 0,
      },
    });
  });

  await logAudit({
    actorId: userId,
    action: "asset_relation.create",
    targetType: "AssetRelation",
    targetId: relation.id,
    metadata: {
      sourceId: data.sourceId,
      targetId: data.targetId,
      relationType: data.relationType,
    },
  });

  return relation;
}

export async function deleteAssetRelation(
  id: string,
  userId: string | null,
  clearance: string,
) {
  const relation = await withClearance(clearance, async (tx) => {
    return tx.assetRelation.delete({ where: { id } });
  });

  await logAudit({
    actorId: userId,
    action: "asset_relation.delete",
    targetType: "AssetRelation",
    targetId: id,
    metadata: {
      sourceId: relation.sourceId,
      targetId: relation.targetId,
      relationType: relation.relationType,
    },
  });

  return relation;
}

export async function getAssetRelations(assetId: string, clearance: string) {
  return withClearance(clearance, async (tx) => {
    const [asSource, asTarget] = await Promise.all([
      tx.assetRelation.findMany({
        where: { sourceId: assetId },
        include: { target: { select: ASSET_SUMMARY_SELECT } },
        orderBy: [{ relationType: "asc" }, { sortOrder: "asc" }],
      }),
      tx.assetRelation.findMany({
        where: { targetId: assetId },
        include: { source: { select: ASSET_SUMMARY_SELECT } },
        orderBy: [{ relationType: "asc" }, { sortOrder: "asc" }],
      }),
    ]);

    return { asSource, asTarget };
  });
}

export interface GraphNode {
  id: string;
  title: string;
  kind: string;
  thumbnailUrl: string | null;
  status: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relationType: string;
}

export async function getAssetGraph(
  startId: string,
  depth = 2,
  clearance: string,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[] }> {
  return withClearance(clearance, async (tx) => {
    const visited = new Set<string>();
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const seenEdges = new Set<string>();
    let frontier = [startId];

    for (let d = 0; d <= depth && frontier.length > 0; d++) {
      const newFrontier: string[] = [];

      const assets = await tx.asset.findMany({
        where: { id: { in: frontier } },
        select: ASSET_SUMMARY_SELECT,
      });

      for (const a of assets) {
        if (!visited.has(a.id)) {
          visited.add(a.id);
          nodes.push({
            id: a.id,
            title: a.title,
            kind: a.kind,
            thumbnailUrl: a.thumbnailUrl,
            status: a.status,
          });
        }
      }

      if (d === depth) break;

      const frontierSet = new Set(frontier);

      const [outgoing, incoming] = await Promise.all([
        tx.assetRelation.findMany({
          where: { sourceId: { in: frontier } },
        }),
        tx.assetRelation.findMany({
          where: { targetId: { in: frontier } },
        }),
      ]);

      for (const rel of [...outgoing, ...incoming]) {
        const edgeKey = `${rel.sourceId}-${rel.targetId}-${rel.relationType}`;
        if (!seenEdges.has(edgeKey)) {
          seenEdges.add(edgeKey);
          edges.push({
            id: edgeKey,
            source: rel.sourceId,
            target: rel.targetId,
            relationType: rel.relationType,
          });
        }

        const neighbor = frontierSet.has(rel.sourceId)
          ? rel.targetId
          : rel.sourceId;
        if (!visited.has(neighbor)) {
          newFrontier.push(neighbor);
        }
      }

      frontier = [...new Set(newFrontier)];
    }

    // Filter edges to only include those where both endpoints are visible
    const visibleIds = new Set(nodes.map((n) => n.id));
    const filteredEdges = edges.filter(
      (e) => visibleIds.has(e.source) && visibleIds.has(e.target)
    );

    return { nodes, edges: filteredEdges };
  });
}
