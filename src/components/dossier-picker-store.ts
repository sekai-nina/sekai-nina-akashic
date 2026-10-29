"use client";

import { useSyncExternalStore } from "react";
import { listAssetDossiersAction } from "@/app/(main)/dossiers/actions";

/**
 * 企画ピッカー (`AddToDossier` / `QuickAddToLastDossier`) がページをまたいで共有する状態。
 * - 前回の追加先: 同じ企画に続けて入れるための近道。localStorage に残す
 * - その場で作った企画: 検索・ギャラリーの企画一覧はサーバー描画なので、作ってもリロードまで出てこない
 * - アセットが入っている企画: ピッカーを開くたびに引く。追加・削除で手元の値を直す
 */

export interface PickerDossier {
  id: string;
  title: string;
}

export interface ContainingDossier extends PickerDossier {
  itemCount: number;
}

interface PickerState {
  lastUsed: PickerDossier | null;
  created: PickerDossier[];
  /** 「入っている企画」を手元で直すたびに進める。表示側はこれを見て引き直す */
  containingVersion: number;
}

const LAST_USED_KEY = "akashic:last-dossier";
const SERVER_STATE: PickerState = { lastUsed: null, created: [], containingVersion: 0 };

let state: PickerState | null = null;
const listeners = new Set<() => void>();

function current(): PickerState {
  if (state) return state;
  let lastUsed: PickerDossier | null = null;
  try {
    const raw = window.localStorage.getItem(LAST_USED_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.id === "string" && typeof parsed?.title === "string") lastUsed = parsed;
    }
  } catch {
    // 壊れた値やプライベートモードは「前回なし」で扱う
  }
  state = { lastUsed, created: [], containingVersion: 0 };
  return state;
}

function setState(next: PickerState) {
  state = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePickerState(): PickerState {
  return useSyncExternalStore(subscribe, current, () => SERVER_STATE);
}

/** 追加先として使った企画を「前回」として覚える */
export function rememberDossier(dossier: PickerDossier) {
  try {
    window.localStorage.setItem(LAST_USED_KEY, JSON.stringify(dossier));
  } catch {
    // 保存できなくてもこのタブの中では効く
  }
  setState({ ...current(), lastUsed: dossier });
}

/** その場で作った企画を、ほかのアセットのピッカーにも出す */
export function rememberCreatedDossier(dossier: PickerDossier) {
  const s = current();
  setState({ ...s, created: [dossier, ...s.created.filter((d) => d.id !== dossier.id)] });
}

/** サーバーから来た一覧の頭に、その場で作った企画を足す */
export function withCreated(dossiers: PickerDossier[], created: PickerDossier[]): PickerDossier[] {
  const known = new Set(dossiers.map((d) => d.id));
  const extra = created.filter((d) => !known.has(d.id));
  return extra.length > 0 ? [...extra, ...dossiers] : dossiers;
}

// 同じアセットをピッカーと「前回の企画に追加」ボタンが同時に引くので、リクエストをまとめる。
// 企画のページで外したあとに戻ってくることもあるので、ピッカーを開いたときは引き直す (fresh)
const containingCache = new Map<string, Promise<ContainingDossier[]>>();

export function fetchContainingDossiers(assetId: string, opts?: { fresh?: boolean }): Promise<ContainingDossier[]> {
  let p = containingCache.get(assetId);
  if (!p || opts?.fresh) {
    p = listAssetDossiersAction(assetId).catch((e) => {
      containingCache.delete(assetId);
      throw e;
    });
    containingCache.set(assetId, p);
  }
  return p;
}

/** 追加・削除のあとに手元のキャッシュを直す (次に開いたときに古い値を出さない) */
export function markContaining(assetId: string, dossier: PickerDossier, contained: boolean) {
  const p = containingCache.get(assetId);
  if (!p) return;
  containingCache.set(
    assetId,
    p.then((rows) => {
      const rest = rows.filter((r) => r.id !== dossier.id);
      if (!contained) return rest;
      const prev = rows.find((r) => r.id === dossier.id);
      return [{ ...dossier, itemCount: prev ? prev.itemCount : 1 }, ...rest];
    })
  );
  setState({ ...current(), containingVersion: current().containingVersion + 1 });
}
