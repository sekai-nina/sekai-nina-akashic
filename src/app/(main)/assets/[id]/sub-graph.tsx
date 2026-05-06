"use client";

import { VisGraph } from "@/components/vis-graph";

interface Props {
  nodes: Array<{
    id: string;
    label: string;
    kind: string;
    thumbnailUrl?: string | null;
    isCurrent?: boolean;
  }>;
  edges: Array<{
    from: string;
    to: string;
    relationType: string;
  }>;
}

export function SubGraph({ nodes, edges }: Props) {
  return (
    <VisGraph
      nodes={nodes}
      edges={edges}
      height="300px"
      solver="forceAtlas2Based"
    />
  );
}
