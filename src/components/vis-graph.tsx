"use client";

import { useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";

interface GraphNode {
  id: string;
  label: string;
  kind: string;
  thumbnailUrl?: string | null;
  isCurrent?: boolean;
  relationCount?: number;
}

interface GraphEdge {
  from: string;
  to: string;
  relationType: string;
}

interface VisGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  height?: string;
  solver?: "forceAtlas2Based" | "barnesHut";
}

const KIND_COLORS: Record<string, string> = {
  image: "#3b82f6",
  video: "#f59e0b",
  audio: "#8b5cf6",
  text: "#10b981",
  document: "#f97316",
  other: "#6b7280",
};

const KIND_LABELS: Record<string, string> = {
  image: "画像",
  video: "動画",
  audio: "音声",
  text: "テキスト",
  document: "ドキュメント",
  other: "その他",
};

const RELATION_COLORS: Record<string, string> = {
  parent_child: "rgba(59, 130, 246, 0.5)",
  derived_from: "rgba(245, 158, 11, 0.5)",
  reference: "rgba(16, 185, 129, 0.5)",
  same_content: "rgba(139, 92, 246, 0.5)",
};

declare global {
  interface Window {
    vis: any;
  }
}

function loadVisNetwork(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window !== "undefined" && window.vis) {
      resolve();
      return;
    }

    const link = document.createElement("link");
    link.href = "https://unpkg.com/vis-network@9.1.9/dist/dist/vis-network.min.css";
    link.rel = "stylesheet";
    document.head.appendChild(link);

    const script = document.createElement("script");
    script.src = "https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js";
    script.onload = () => resolve();
    document.head.appendChild(script);
  });
}

export function VisGraph({ nodes, edges, height = "600px", solver = "forceAtlas2Based" }: VisGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<any>(null);
  const router = useRouter();

  const initGraph = useCallback(async () => {
    await loadVisNetwork();
    const container = containerRef.current;
    if (!container || !window.vis) return;

    const visNodes = new window.vis.DataSet(
      nodes.map((node) => {
        const color = KIND_COLORS[node.kind] ?? "#6b7280";
        const size = node.isCurrent ? 30 : Math.min(12 + (node.relationCount ?? 0) * 2, 28);
        return {
          id: node.id,
          label: node.label || "(無題)",
          color: {
            background: node.isCurrent ? "#1e293b" : color,
            border: node.isCurrent ? "#fff" : color,
            highlight: {
              background: node.isCurrent ? "#1e293b" : color,
              border: "#1e293b",
            },
          },
          shape: "dot",
          size,
          font: {
            size: node.isCurrent ? 14 : 11,
            color: "#334155",
            bold: node.isCurrent,
          },
          borderWidth: node.isCurrent ? 3 : 2,
          url: `/assets/${node.id}`,
        };
      }),
    );

    const visEdges = new window.vis.DataSet(
      edges.map((edge, i) => ({
        id: i,
        from: edge.from,
        to: edge.to,
        color: {
          color: RELATION_COLORS[edge.relationType] ?? "rgba(100,100,100,0.4)",
          highlight: "#1e293b",
        },
        width: 1.5,
        dashes: edge.relationType === "reference",
        smooth: { type: "continuous" },
      })),
    );

    const physicsConfig =
      solver === "barnesHut"
        ? {
            barnesHut: {
              gravitationalConstant: -15000,
              centralGravity: 0.5,
              springLength: 120,
              springConstant: 0.04,
              damping: 0.4,
              avoidOverlap: 0.2,
            },
            solver: "barnesHut" as const,
            stabilization: { enabled: true, iterations: 800, updateInterval: 25 },
          }
        : {
            forceAtlas2Based: {
              gravitationalConstant: -50,
              centralGravity: 0.01,
              springLength: 100,
              springConstant: 0.08,
              damping: 0.4,
              avoidOverlap: 0.5,
            },
            solver: "forceAtlas2Based" as const,
            stabilization: { enabled: true, iterations: 200, updateInterval: 25 },
          };

    const options = {
      height,
      physics: { enabled: true, ...physicsConfig },
      interaction: {
        hover: true,
        tooltipDelay: 100,
        hideEdgesOnDrag: false,
        zoomView: true,
      },
      nodes: {
        borderWidth: 2,
        borderWidthSelected: 5,
        chosen: {
          node: function (values: any, _id: any, selected: boolean, hovering: boolean) {
            if (selected) {
              values.borderColor = "#1e293b";
              values.borderWidth = 5;
              values.shadow = true;
              values.shadowColor = "rgba(30,41,59,0.28)";
              values.shadowSize = 18;
            } else if (hovering) {
              values.borderColor = "#1e293b";
              values.borderWidth = 4;
            }
          },
        },
      },
      edges: { smooth: { type: "continuous" } },
    };

    const network = new window.vis.Network(container, { nodes: visNodes, edges: visEdges }, options);
    networkRef.current = network;

    // Physics management (same pattern as sekai-nina-site)
    let isDragging = false;
    let settleToken = 0;
    let settleFallbackTimeout: ReturnType<typeof setTimeout>;

    function stopPhysicsIfAllowed(token: number) {
      if (token !== settleToken || isDragging) return;
      network.setOptions({ physics: { enabled: false } });
    }

    function settleThenStopPhysics() {
      const token = ++settleToken;
      clearTimeout(settleFallbackTimeout);
      network.setOptions({ physics: { enabled: true, stabilization: false } });
      if (typeof network.startSimulation === "function") network.startSimulation();

      const maxWaitMs = 6000;
      const minRunMs = 450;
      const stableForMs = 400;
      const epsilon = 0.35;
      let stableSince: number | null = null;
      let lastPositions = network.getPositions();
      const startedAt = performance.now();

      settleFallbackTimeout = setTimeout(() => stopPhysicsIfAllowed(token), maxWaitMs);

      function frame() {
        if (token !== settleToken || isDragging) return;
        const now = performance.now();
        const positions = network.getPositions();
        let maxDelta = 0;
        for (const id in positions) {
          const p = positions[id];
          const lp = lastPositions[id];
          if (!lp) continue;
          const d = Math.sqrt((p.x - lp.x) ** 2 + (p.y - lp.y) ** 2);
          if (d > maxDelta) maxDelta = d;
          if (maxDelta >= epsilon) break;
        }
        if (now - startedAt < minRunMs) {
          stableSince = null;
        } else if (maxDelta < epsilon) {
          if (stableSince === null) stableSince = now;
          if (now - stableSince >= stableForMs) {
            clearTimeout(settleFallbackTimeout);
            stopPhysicsIfAllowed(token);
            return;
          }
        } else {
          stableSince = null;
        }
        lastPositions = positions;
        if (now - startedAt >= maxWaitMs) {
          clearTimeout(settleFallbackTimeout);
          stopPhysicsIfAllowed(token);
          return;
        }
        requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }

    network.once("stabilizationIterationsDone", () => {
      setTimeout(() => {
        if (!isDragging) network.setOptions({ physics: { enabled: false } });
      }, 100);
    });

    network.on("dragStart", (params: any) => {
      if (params.nodes.length > 0) {
        isDragging = true;
        settleToken++;
        clearTimeout(settleFallbackTimeout);
        network.setOptions({ physics: { enabled: true, stabilization: false } });
      }
    });

    network.on("dragEnd", () => {
      isDragging = false;
      settleThenStopPhysics();
    });

    network.on("click", (params: any) => {
      if (params.nodes.length > 0) {
        const nodeId = params.nodes[0];
        const node = visNodes.get(nodeId);
        if (node?.url) router.push(node.url);
      }
    });

    network.on("hoverNode", () => {
      if (container) container.style.cursor = "pointer";
    });
    network.on("blurNode", () => {
      if (container) container.style.cursor = "default";
    });

    return () => {
      network.destroy();
    };
  }, [nodes, edges, height, solver, router]);

  useEffect(() => {
    const cleanup = initGraph();
    return () => {
      cleanup?.then((fn) => fn?.());
    };
  }, [initGraph]);

  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center" style={{ height }}>
        <p className="text-slate-400 text-sm">リレーションが見つかりません</p>
      </div>
    );
  }

  return (
    <div>
      <div
        ref={containerRef}
        className="bg-white border border-slate-200 rounded-lg overflow-hidden"
        style={{ height }}
      />
      {/* Legend */}
      <div className="flex flex-wrap gap-3 mt-2 px-1">
        {Object.entries(KIND_COLORS).map(([kind, color]) => (
          <div key={kind} className="flex items-center gap-1.5 text-xs text-slate-500">
            <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: color }} />
            {KIND_LABELS[kind] ?? kind}
          </div>
        ))}
      </div>
    </div>
  );
}
