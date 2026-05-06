"use client";

import { useState, useEffect, useCallback } from "react";
import { Maximize2, X } from "lucide-react";
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
  const [expanded, setExpanded] = useState(false);

  const close = useCallback(() => setExpanded(false), []);

  useEffect(() => {
    if (!expanded) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKeyDown);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = "";
    };
  }, [expanded, close]);

  return (
    <>
      {/* Inline graph */}
      <div className="relative">
        <VisGraph
          nodes={nodes}
          edges={edges}
          height="300px"
          solver="forceAtlas2Based"
        />
        <button
          onClick={() => setExpanded(true)}
          className="absolute top-3 right-3 p-1.5 bg-white/80 backdrop-blur border border-slate-200 rounded-md text-slate-500 hover:text-slate-800 hover:bg-white transition-colors"
          title="拡大表示"
        >
          <Maximize2 size={14} />
        </button>
      </div>

      {/* Modal */}
      {expanded && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) close(); }}
        >
          <div className="bg-white rounded-2xl shadow-2xl w-[90vw] max-w-[1400px] h-[85vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200">
              <h3 className="text-sm font-semibold text-slate-700">リレーショングラフ</h3>
              <button
                onClick={close}
                className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-md transition-colors"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <VisGraph
                nodes={nodes}
                edges={edges}
                height="100%"
                solver="forceAtlas2Based"
              />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
