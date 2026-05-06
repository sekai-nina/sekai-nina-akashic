"use client";

import { useCallback, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeTypes,
  Position,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "dagre";
import { useRouter } from "next/navigation";
import type { GraphNode, GraphEdge } from "@/lib/domain/relations";
import { RELATION_TYPE_LABELS } from "@/lib/utils";
import { AssetNode } from "./asset-node";

const RELATION_TYPE_COLORS: Record<string, string> = {
  parent_child: "#3b82f6",
  derived_from: "#f59e0b",
  reference: "#10b981",
  same_content: "#8b5cf6",
};

function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  centerId: string,
) {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 80 });

  for (const node of nodes) {
    g.setNode(node.id, { width: 180, height: 80 });
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  const flowNodes: Node[] = nodes.map((node) => {
    const pos = g.node(node.id) ?? { x: 0, y: 0 };
    return {
      id: node.id,
      type: "assetNode",
      position: { x: pos.x - 90, y: pos.y - 40 },
      data: {
        title: node.title,
        kind: node.kind,
        thumbnailUrl: node.thumbnailUrl,
        isCenter: node.id === centerId,
      },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    };
  });

  const flowEdges: Edge[] = edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: RELATION_TYPE_LABELS[edge.relationType] ?? edge.relationType,
    style: { stroke: RELATION_TYPE_COLORS[edge.relationType] ?? "#94a3b8" },
    labelStyle: { fontSize: 11, fill: "#64748b" },
    animated: edge.relationType === "parent_child",
  }));

  return { flowNodes, flowEdges };
}

const nodeTypes: NodeTypes = {
  assetNode: AssetNode,
};

export function AssetGraph({
  initialNodes,
  initialEdges,
  centerId,
}: {
  initialNodes: GraphNode[];
  initialEdges: GraphEdge[];
  centerId: string;
}) {
  const router = useRouter();

  const { flowNodes, flowEdges } = useMemo(
    () => layoutGraph(initialNodes, initialEdges, centerId),
    [initialNodes, initialEdges, centerId],
  );

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      router.push(`/assets/${node.id}`);
    },
    [router],
  );

  if (flowNodes.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-slate-400 text-sm">リレーションが見つかりません</p>
      </div>
    );
  }

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
      fitView
      fitViewOptions={{ padding: 0.3 }}
      minZoom={0.2}
      maxZoom={2}
    >
      <Background />
      <Controls />
    </ReactFlow>
  );
}
