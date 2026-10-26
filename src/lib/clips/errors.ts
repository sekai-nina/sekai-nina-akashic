/**
 * クリップ (#41) の permission と例外。**DB を触らないモジュールに置く**
 * (`src/lib/insta/jobs.ts` と同じ理由: テストが `@/lib/db` を巻き込むと DATABASE_URL の無い CI で落ちる)。
 * DB を触る側は `src/lib/domain/clips.ts`。
 */

/**
 * クリップを外部 (Discord bot。#286) から作れるキー。write とは別に持たせ、
 * `clip` だけのキーでは他の書き込み API を叩けないようにする
 */
export const CLIP_PERMISSION = "clip";

/** 入力起因の失敗。画面にそのまま出してよい文言 */
export class ClipInputError extends Error {}

/** アセットが無いか見えない。API は 404 で返す (画面では `ClipInputError` として扱う) */
export class ClipAssetNotFoundError extends ClipInputError {}

/** プールが見えない・編集できない。API は 403 で返す */
export class ClipForbiddenError extends ClipInputError {}
