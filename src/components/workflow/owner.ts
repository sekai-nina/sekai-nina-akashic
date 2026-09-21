/**
 * 記事ワークフローの器 (ミーグリ / ライブ) をクライアント部品に伝える形 (#150)。
 * 器ごとの Server Action は props で受け取り、API route の URL だけをここで組む。
 * **クライアントから読むので依存を持ち込まない。**
 */

export type WorkflowOwnerKind = "meetgreet" | "live";

export interface WorkflowOwner {
  kind: WorkflowOwnerKind;
  id: string;
}

/** 内部 API のパス (`/api/meetgreets/<id>` / `/api/lives/<id>`) */
export function ownerApiPath(owner: WorkflowOwner): string {
  return `/api/${owner.kind === "meetgreet" ? "meetgreets" : "lives"}/${owner.id}`;
}

/** 器の呼び名 (文言用)。「このミーグリ」「このライブ」のように使う */
export const WORKFLOW_OWNER_NOUN: Record<WorkflowOwnerKind, string> = {
  meetgreet: "ミーグリ",
  live: "ライブ",
};

/** 「この回」/「このライブ」(ミーグリは 1 回分を「回」と呼んでいる) */
export const WORKFLOW_OWNER_THIS: Record<WorkflowOwnerKind, string> = {
  meetgreet: "この回",
  live: "このライブ",
};
