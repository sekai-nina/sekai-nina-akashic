import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[\s\u3000]+/g, " ")
    .trim();
}

export function truncate(text: string, length: number): string {
  if (text.length <= length) return text;
  return text.slice(0, length) + "…";
}

export function formatDate(date: Date | string | null): string {
  if (!date) return "";
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export const ASSET_KIND_LABELS: Record<string, string> = {
  image: "画像",
  video: "動画",
  audio: "音声",
  text: "テキスト",
  document: "ドキュメント",
  other: "その他",
};

export const ASSET_STATUS_LABELS: Record<string, string> = {
  inbox: "Inbox",
  triaging: "整理中",
  organized: "整理済み",
  archived: "アーカイブ",
};

export const TRUST_LEVEL_LABELS: Record<string, string> = {
  unverified: "未検証",
  low: "低",
  medium: "中",
  high: "高",
  official: "公式",
};

export const ENTITY_TYPE_LABELS: Record<string, string> = {
  person: "人物",
  place: "場所",
  source: "出典",
  event: "イベント",
  tag: "タグ",
};
