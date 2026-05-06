import { getAssetGraph } from "@/lib/domain/relations";
import { AssetGraph } from "./asset-graph";

export default async function GraphPage({
  searchParams,
}: {
  searchParams: Promise<{ assetId?: string; depth?: string }>;
}) {
  const { assetId, depth: depthStr } = await searchParams;
  const depth = Math.min(parseInt(depthStr ?? "2", 10) || 2, 4);

  if (!assetId) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-8rem)]">
        <p className="text-slate-400 text-sm">
          アセット詳細ページから「グラフで表示」を選択してください
        </p>
      </div>
    );
  }

  const graph = await getAssetGraph(assetId, depth);

  return (
    <div className="h-[calc(100vh-8rem)]">
      <AssetGraph
        initialNodes={graph.nodes}
        initialEdges={graph.edges}
        centerId={assetId}
      />
    </div>
  );
}
