"use client";

import { useState, useMemo } from "react";
import { VisGraph } from "@/components/vis-graph";

interface Props {
  nodes: Array<{
    id: string;
    label: string;
    kind: string;
    thumbnailUrl?: string | null;
    relationCount?: number;
  }>;
  edges: Array<{
    from: string;
    to: string;
    relationType: string;
  }>;
}

const KIND_OPTIONS = [
  { value: "image", label: "画像" },
  { value: "video", label: "動画" },
  { value: "audio", label: "音声" },
  { value: "text", label: "テキスト" },
  { value: "document", label: "ドキュメント" },
  { value: "other", label: "その他" },
];

export function FullGraph({ nodes, edges }: Props) {
  const [search, setSearch] = useState("");
  const [kindFilter, setKindFilter] = useState<Set<string>>(new Set());

  const kinds = useMemo(() => {
    const s = new Set<string>();
    for (const n of nodes) s.add(n.kind);
    return s;
  }, [nodes]);

  const filtered = useMemo(() => {
    let filteredNodes = nodes;
    let filteredEdges = edges;

    if (kindFilter.size > 0) {
      const nodeIds = new Set(
        filteredNodes.filter((n) => kindFilter.has(n.kind)).map((n) => n.id),
      );
      filteredNodes = filteredNodes.filter((n) => nodeIds.has(n.id));
      filteredEdges = filteredEdges.filter(
        (e) => nodeIds.has(e.from) && nodeIds.has(e.to),
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      const matchIds = new Set(
        filteredNodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id),
      );
      // Include neighbors of matching nodes
      const expandedIds = new Set(matchIds);
      for (const e of filteredEdges) {
        if (matchIds.has(e.from)) expandedIds.add(e.to);
        if (matchIds.has(e.to)) expandedIds.add(e.from);
      }
      filteredNodes = filteredNodes.filter((n) => expandedIds.has(n.id));
      filteredEdges = filteredEdges.filter(
        (e) => expandedIds.has(e.from) && expandedIds.has(e.to),
      );
    }

    return { nodes: filteredNodes, edges: filteredEdges };
  }, [nodes, edges, kindFilter, search]);

  function toggleKind(kind: string) {
    setKindFilter((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  }

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="アセット名で検索..."
          className="border border-slate-300 rounded px-3 py-1.5 text-sm w-64 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <div className="flex flex-wrap gap-1.5">
          {KIND_OPTIONS.filter((k) => kinds.has(k.value)).map((k) => (
            <button
              key={k.value}
              onClick={() => toggleKind(k.value)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                kindFilter.size === 0 || kindFilter.has(k.value)
                  ? "bg-slate-800 text-white"
                  : "bg-slate-100 text-slate-400"
              }`}
            >
              {k.label}
            </button>
          ))}
          {kindFilter.size > 0 && (
            <button
              onClick={() => setKindFilter(new Set())}
              className="px-2.5 py-1 rounded text-xs font-medium bg-slate-100 text-slate-600 hover:bg-slate-200"
            >
              リセット
            </button>
          )}
        </div>
      </div>

      <VisGraph
        nodes={filtered.nodes}
        edges={filtered.edges}
        height="700px"
        solver="barnesHut"
      />
    </div>
  );
}
