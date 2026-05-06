"use client";

import { useState, useTransition } from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  Bar,
  ComposedChart,
} from "recharts";
import { analyzeWords, analyzeVolume } from "./actions";

const WORD_COLORS = [
  "#3b82f6",
  "#ef4444",
  "#10b981",
  "#f59e0b",
  "#8b5cf6",
  "#ec4899",
  "#06b6d4",
  "#84cc16",
];

const SOURCE_TYPE_OPTIONS = [
  { value: "", label: "すべて" },
  { value: "web", label: "ブログ" },
  { value: "import", label: "トーク" },
];

const TEXT_TYPE_OPTIONS = [
  { value: "body", label: "本文" },
  { value: "message_body", label: "メッセージ" },
  { value: "title", label: "タイトル" },
  { value: "description", label: "説明" },
  { value: "note", label: "メモ" },
  { value: "ocr", label: "OCR" },
  { value: "transcript", label: "文字起こし" },
];

interface EntityOption {
  id: string;
  type: string;
  canonicalName: string;
}

interface WordAnalysisResult {
  frequency: {
    points: Record<string, string | number>[];
    labels: string[];
  };
  rate: {
    points: Record<string, string | number>[];
    labels: string[];
  };
}

interface VolumePoint {
  bucket: string;
  postCount: number;
  charCount: number;
  avgLength: number;
}

interface Props {
  entities: EntityOption[];
  defaultPersonId?: string;
}

export function AnalysisClient({ entities, defaultPersonId }: Props) {
  const [isPending, startTransition] = useTransition();

  // Filter state
  const [sourceType, setSourceType] = useState("");
  const [textTypes, setTextTypes] = useState<string[]>([
    "body",
    "message_body",
  ]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [personId, setPersonId] = useState(defaultPersonId ?? "");
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [granularity, setGranularity] = useState<"month" | "week">("month");

  // Word input
  const [wordInput, setWordInput] = useState("");

  // Results
  const [wordData, setWordData] = useState<WordAnalysisResult | null>(null);
  const [volumeData, setVolumeData] = useState<VolumePoint[] | null>(null);

  // Chart tab state
  const [wordChartTab, setWordChartTab] = useState<"count" | "rate">("count");
  const [volumeChartTab, setVolumeChartTab] = useState<
    "volume" | "avgLength"
  >("volume");

  const allEntityIds = [
    ...(personId ? [personId] : []),
    ...tagIds,
  ];
  const filters = {
    sourceType: sourceType || undefined,
    textTypes: textTypes.length > 0 ? textTypes : undefined,
    entityIds: allEntityIds.length > 0 ? allEntityIds : undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    granularity,
  };

  function parseWordGroups(input: string) {
    return input
      .split(/[,、]+/)
      .map((group) => group.trim())
      .filter(Boolean)
      .map((group) => {
        const variants = group
          .split("/")
          .map((v) => v.trim())
          .filter(Boolean);
        return { label: variants[0], variants };
      });
  }

  function handleAnalyze() {
    const groups = parseWordGroups(wordInput);

    startTransition(async () => {
      const [wordResult, volumeResult] = await Promise.all([
        groups.length > 0 ? analyzeWords(groups, filters) : null,
        analyzeVolume(filters),
      ]);

      if (wordResult) setWordData(wordResult);
      else setWordData(null);
      setVolumeData(volumeResult);
    });
  }

  function formatBucket(bucket: string) {
    if (granularity === "week") {
      return bucket.slice(2, 10).replace(/-/g, "/");
    }
    return bucket.slice(0, 7).replace("-", "/");
  }

  const personEntities = entities.filter((e) => e.type === "person");
  const tagEntities = entities.filter((e) => e.type === "tag");

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {/* Person filter */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">
              人物
            </label>
            <select
              value={personId}
              onChange={(e) => setPersonId(e.target.value)}
              className="w-full border border-slate-300 rounded px-3 py-1.5 text-sm"
            >
              <option value="">すべて</option>
              {personEntities.map((ent) => (
                <option key={ent.id} value={ent.id}>
                  {ent.canonicalName}
                </option>
              ))}
            </select>
          </div>

          {/* Source type */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">
              ソース
            </label>
            <select
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value)}
              className="w-full border border-slate-300 rounded px-3 py-1.5 text-sm"
            >
              {SOURCE_TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Date range */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">
              期間
            </label>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="flex-1 min-w-0 border border-slate-300 rounded px-2 py-1.5 text-sm"
              />
              <span className="text-slate-400 shrink-0">〜</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="flex-1 min-w-0 border border-slate-300 rounded px-2 py-1.5 text-sm"
              />
            </div>
          </div>

          {/* Granularity */}
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">
              粒度
            </label>
            <div className="flex gap-1">
              <button
                onClick={() => setGranularity("month")}
                className={`px-3 py-1.5 rounded text-sm border transition-colors ${
                  granularity === "month"
                    ? "bg-slate-700 text-white border-slate-700"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50"
                }`}
              >
                月次
              </button>
              <button
                onClick={() => setGranularity("week")}
                className={`px-3 py-1.5 rounded text-sm border transition-colors ${
                  granularity === "week"
                    ? "bg-slate-700 text-white border-slate-700"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50"
                }`}
              >
                週次
              </button>
            </div>
          </div>
        </div>

        {/* Text types */}
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">
            テキスト種別
          </label>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {TEXT_TYPE_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex items-center gap-1.5 text-sm"
              >
                <input
                  type="checkbox"
                  checked={textTypes.includes(opt.value)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setTextTypes([...textTypes, opt.value]);
                    } else {
                      setTextTypes(textTypes.filter((t) => t !== opt.value));
                    }
                  }}
                  className="rounded"
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        {/* Entity filter */}
        {tagEntities.length > 0 && (
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">
              タグで絞り込み
            </label>
            <div className="flex flex-wrap gap-x-4 gap-y-1 max-h-28 overflow-y-auto">
              {tagEntities.map((ent) => (
                <label
                  key={ent.id}
                  className="flex items-center gap-1.5 text-sm whitespace-nowrap"
                >
                  <input
                    type="checkbox"
                    checked={tagIds.includes(ent.id)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setTagIds([...tagIds, ent.id]);
                      } else {
                        setTagIds(tagIds.filter((id) => id !== ent.id));
                      }
                    }}
                    className="rounded"
                  />
                  {ent.canonicalName}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Word input + analyze button */}
        <div className="flex gap-2">
          <input
            type="text"
            value={wordInput}
            onChange={(e) => setWordInput(e.target.value)}
            placeholder="ワードをカンマ区切り、エイリアスは/区切り（例: 世界/せかい/セカイ/🌍, ライブ/らいぶ）"
            className="flex-1 border border-slate-300 rounded px-3 py-2 text-sm"
            onKeyDown={(e) => e.key === "Enter" && handleAnalyze()}
          />
          <button
            onClick={handleAnalyze}
            disabled={isPending}
            className="bg-blue-600 text-white px-5 py-2 rounded text-sm font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 shrink-0"
          >
            {isPending ? "分析中..." : "分析する"}
          </button>
        </div>
      </div>

      {/* Word frequency charts */}
      {wordData && wordData.frequency.labels.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-700">
              ワード分析
            </h2>
            <div className="flex gap-1">
              <button
                onClick={() => setWordChartTab("count")}
                className={`px-3 py-1 rounded text-xs border transition-colors ${
                  wordChartTab === "count"
                    ? "bg-slate-700 text-white border-slate-700"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50"
                }`}
              >
                使用回数
              </button>
              <button
                onClick={() => setWordChartTab("rate")}
                className={`px-3 py-1 rounded text-xs border transition-colors ${
                  wordChartTab === "rate"
                    ? "bg-slate-700 text-white border-slate-700"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50"
                }`}
              >
                出現率
              </button>
            </div>
          </div>

          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={
                  wordChartTab === "count"
                    ? wordData.frequency.points
                    : wordData.rate.points
                }
              >
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  dataKey="bucket"
                  tickFormatter={formatBucket}
                  tick={{ fontSize: 12 }}
                />
                <YAxis
                  tick={{ fontSize: 12 }}
                  tickFormatter={(v: number) =>
                    wordChartTab === "rate" ? `${v}%` : String(v)
                  }
                />
                <Tooltip
                  labelFormatter={(label) => formatBucket(String(label))}
                  formatter={(value, name) => [
                    wordChartTab === "count" ? `${value}回` : `${value}%`,
                    String(name),
                  ]}
                />
                <Legend />
                {wordData.frequency.labels.map((word, i) => (
                  <Line
                    key={word}
                    type="monotone"
                    dataKey={word}
                    stroke={WORD_COLORS[i % WORD_COLORS.length]}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {wordChartTab === "rate" && (
            <p className="text-xs text-slate-400 mt-2">
              各期間の投稿のうち、そのワードを含む投稿の割合（%）
            </p>
          )}
        </div>
      )}

      {/* Volume charts */}
      {volumeData && volumeData.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-700">
              テキスト量の推移
            </h2>
            <div className="flex gap-1">
              <button
                onClick={() => setVolumeChartTab("volume")}
                className={`px-3 py-1 rounded text-xs border transition-colors ${
                  volumeChartTab === "volume"
                    ? "bg-slate-700 text-white border-slate-700"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50"
                }`}
              >
                投稿数・文字数
              </button>
              <button
                onClick={() => setVolumeChartTab("avgLength")}
                className={`px-3 py-1 rounded text-xs border transition-colors ${
                  volumeChartTab === "avgLength"
                    ? "bg-slate-700 text-white border-slate-700"
                    : "border-slate-300 text-slate-600 hover:bg-slate-50"
                }`}
              >
                平均文字数
              </button>
            </div>
          </div>

          <div className="h-80">
            {volumeChartTab === "volume" ? (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={volumeData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    dataKey="bucket"
                    tickFormatter={formatBucket}
                    tick={{ fontSize: 12 }}
                  />
                  <YAxis
                    yAxisId="left"
                    tick={{ fontSize: 12 }}
                    label={{
                      value: "投稿数",
                      angle: -90,
                      position: "insideLeft",
                      style: { fontSize: 11, fill: "#64748b" },
                    }}
                  />
                  <YAxis
                    yAxisId="right"
                    orientation="right"
                    tick={{ fontSize: 12 }}
                    tickFormatter={(v: number) =>
                      v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)
                    }
                    label={{
                      value: "文字数",
                      angle: 90,
                      position: "insideRight",
                      style: { fontSize: 11, fill: "#64748b" },
                    }}
                  />
                  <Tooltip
                    labelFormatter={(label) => formatBucket(String(label))}
                    formatter={(value, name) => [
                      Number(value).toLocaleString() +
                        (name === "文字数" ? "字" : "件"),
                      String(name),
                    ]}
                  />
                  <Legend />
                  <Bar
                    yAxisId="left"
                    dataKey="postCount"
                    name="投稿数"
                    fill="#93c5fd"
                  />
                  <Line
                    yAxisId="right"
                    type="monotone"
                    dataKey="charCount"
                    name="文字数"
                    stroke="#f97316"
                    strokeWidth={2}
                    dot={false}
                  />
                </ComposedChart>
              </ResponsiveContainer>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={volumeData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    dataKey="bucket"
                    tickFormatter={formatBucket}
                    tick={{ fontSize: 12 }}
                  />
                  <YAxis
                    tick={{ fontSize: 12 }}
                    tickFormatter={(v: number) =>
                      v.toLocaleString()
                    }
                  />
                  <Tooltip
                    labelFormatter={(label) => formatBucket(String(label))}
                    formatter={(value) => [
                      `${Number(value).toLocaleString()}字`,
                      "平均文字数",
                    ]}
                  />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="avgLength"
                    name="平均文字数"
                    stroke="#8b5cf6"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!wordData && !volumeData && (
        <div className="text-center py-16 text-slate-400">
          <p>
            フィルターを設定して「分析する」をクリックしてください
          </p>
          <p className="text-xs mt-2">
            ワードを入力しなくても、テキスト量の推移は確認できます
          </p>
        </div>
      )}
    </div>
  );
}
