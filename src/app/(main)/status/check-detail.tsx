import Link from "next/link";
import { formatDate, JOB_RUN_STATUS_LABELS } from "@/lib/utils";
import type { JobRunStatus } from "@prisma/client";

/**
 * StatusCheckState.detail の描画。形はチェックごとに違うので、キーを見て描き分ける
 * (`src/lib/status/checks.ts` が返す形と対応)。知らないキーは出さない。
 */

type AssetRef = { id: string; title: string; date: string | null };
type ArticleRef = { shortId: string; title: string; editedAt?: string | null; path?: string };

function asArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

export function CheckDetail({ detail }: { detail: unknown }) {
  if (!detail || typeof detail !== "object") return null;
  const d = detail as Record<string, unknown>;
  const rows: React.ReactNode[] = [];

  // 収集の鮮度
  if ("lastAt" in d) {
    rows.push(
      <Row key="lastAt" label="最終登録">
        {d.lastAt ? formatDate(String(d.lastAt), true) : "なし"}
        {typeof d.maxAgeHours === "number" && (
          <span className="text-slate-400 ml-2">(閾値 {d.maxAgeHours} 時間)</span>
        )}
      </Row>,
    );
  }

  // ハートビート
  if ("lastRunAt" in d) {
    rows.push(
      <Row key="lastRunAt" label="最終報告">
        {formatDate(String(d.lastRunAt), true)}
        {d.lastStatus != null && (
          <span className="ml-2">{JOB_RUN_STATUS_LABELS[d.lastStatus as JobRunStatus] ?? String(d.lastStatus)}</span>
        )}
      </Row>,
    );
    if (d.lastOkAt) rows.push(<Row key="lastOkAt" label="最終成功">{formatDate(String(d.lastOkAt), true)}</Row>);
    if (typeof d.intervalSec === "number") rows.push(<Row key="interval" label="申告間隔">{d.intervalSec} 秒</Row>);
    if (d.lastMessage) {
      rows.push(
        <Row key="msg" label="メッセージ">
          <span className="font-mono text-xs break-all">{String(d.lastMessage)}</span>
        </Row>,
      );
    }
  }

  // アセット一覧 (今日の発見の未抽出)
  const assets = asArray<AssetRef>(d.assets);
  if (assets.length) {
    rows.push(
      <Row key="assets" label="対象">
        <ul className="space-y-0.5">
          {assets.map((a) => (
            <li key={a.id}>
              <Link href={`/assets/${a.id}`} className="hover:underline">
                {a.title || a.id}
              </Link>
              {a.date && <span className="text-slate-400 ml-2">{formatDate(a.date)}</span>}
            </li>
          ))}
        </ul>
      </Row>,
    );
  }

  // 記事一覧 (未 push / 未反映 / GitHub 側が進んだもの)
  const articles = [...asArray<ArticleRef>(d.articles), ...asArray<ArticleRef>(d.changed)];
  if (articles.length) {
    rows.push(
      <Row key="articles" label={"changed" in d ? "GitHub 側が進んだ記事" : "記事"}>
        <ul className="space-y-0.5">
          {articles.map((a) => (
            <li key={a.shortId}>
              <Link href={`/articles/${a.shortId}`} className="hover:underline">
                {a.title || a.shortId}
              </Link>
              {a.editedAt && <span className="text-slate-400 ml-2">編集 {formatDate(a.editedAt)}</span>}
            </li>
          ))}
        </ul>
      </Row>,
    );
  }

  // 評価そのもの: 測れなかったチェックと理由
  const failed = asArray<{ key: string; name: string; reason: string }>(d.failed);
  if (failed.length) {
    rows.push(
      <Row key="failed" label="測れなかった">
        <ul className="space-y-0.5">
          {failed.map((f) => (
            <li key={f.key}>
              {f.name} <span className="text-slate-400 font-mono text-xs">{f.key}</span>
              <div className="text-xs text-slate-500 font-mono break-all">{f.reason}</div>
            </li>
          ))}
        </ul>
      </Row>,
    );
  }

  const added = asArray<string>(d.added);
  if (added.length) {
    rows.push(
      <Row key="added" label="未取り込みの新規">
        <ul className="space-y-0.5 font-mono text-xs">
          {added.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      </Row>,
    );
  }

  if (typeof d.commitSha === "string") {
    rows.push(
      <Row key="commit" label="GitHub の先頭">
        <span className="font-mono text-xs">{d.commitSha.slice(0, 7)}</span>
      </Row>,
    );
  }

  if (rows.length === 0) return null;
  return <dl className="text-sm text-slate-700 space-y-1.5">{rows}</dl>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-slate-400 text-xs pt-0.5">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
