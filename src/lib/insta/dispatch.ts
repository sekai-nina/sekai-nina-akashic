import { buildWorkerInput } from "@/lib/insta/jobs";

/**
 * story ジョブを iPad に届ける口 (#178)。
 *
 * Pushcut 固有の処理はここに閉じ込める。ジョブの状態遷移 (`src/lib/domain/insta-jobs.ts`) は
 * `dispatchInstagramJob` の結果しか見ないので、別の届け方 (別のプッシュサービス・iPad 側の
 * ポーリング) に替えるときはこのファイルの実装を差し替えるだけでよい。
 *
 * Pushcut Automation Server: `POST https://api.pushcut.io/v1/execute` に `API-Key` ヘッダを
 * 付けて `{ shortcut, input, timeout: "nowait", serverId }` を送ると、iPad 上で動いている
 * Pushcut (Automation Server として起動しておく) が指定の Shortcut を `input` 付きで実行する。
 * `timeout: "nowait"` は Shortcut の完了を待たず 202 で返す指定 (Shortcut は数分走るので待たない)。
 */

export interface DispatchableJob {
  id: string;
  url: string;
  handle: string;
}

export type DispatchResult = { ok: true; dispatcher: string } | { ok: false; error: string };

interface InstaJobDispatcher {
  /** 一覧・ログに出す名前 */
  readonly name: string;
  /** 環境変数が揃っているか。揃っていなければジョブは pending に留まる */
  configured(): boolean;
  dispatch(job: DispatchableJob): Promise<void>;
}

const PUSHCUT_EXECUTE_URL = "https://api.pushcut.io/v1/execute";
const PUSHCUT_TIMEOUT_MS = 15_000;

/** 環境変数が揃っていなければ null。configured() と dispatch() の両方がこれを見る */
function readPushcutConfig(): { apiKey: string; shortcut: string; serverId?: string } | null {
  const apiKey = process.env.PUSHCUT_API_KEY?.trim();
  const shortcut = process.env.PUSHCUT_SHORTCUT_NAME?.trim();
  if (!apiKey || !shortcut) return null;
  const serverId = process.env.PUSHCUT_SERVER_ID?.trim();
  return { apiKey, shortcut, ...(serverId ? { serverId } : {}) };
}

const pushcut: InstaJobDispatcher = {
  name: "pushcut",
  configured() {
    return readPushcutConfig() !== null;
  },
  async dispatch(job) {
    const config = readPushcutConfig();
    if (!config) throw new Error(DISPATCHER_NOT_CONFIGURED_MESSAGE);
    const { apiKey, shortcut, serverId } = config;
    const res = await fetch(PUSHCUT_EXECUTE_URL, {
      method: "POST",
      headers: { "API-Key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        shortcut,
        input: buildWorkerInput(job),
        timeout: "nowait",
        ...(serverId ? { serverId } : {}),
      }),
      signal: AbortSignal.timeout(PUSHCUT_TIMEOUT_MS),
    });
    if (!res.ok) {
      // 401 = キー違い、404 = Shortcut / サーバ名違い、502/504 = iPad が繋がっていない
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`Pushcut ${res.status}: ${body || res.statusText}`);
    }
  },
};

/** いま使う届け方。差し替えるときはここを変える */
const dispatcher: InstaJobDispatcher = pushcut;

/** 未設定のときに画面と API が出す文言。届け方を替えたらここも変える */
export const DISPATCHER_NOT_CONFIGURED_MESSAGE = "Pushcut が未設定です (PUSHCUT_API_KEY / PUSHCUT_SHORTCUT_NAME)";

export function isDispatcherConfigured(): boolean {
  return dispatcher.configured();
}

/**
 * ジョブを iPad に送る。**例外は投げない** (呼び出し側は結果を見て pending に戻すか決める)。
 * 未設定なら送らずにその旨を返す。
 */
export async function dispatchInstagramJob(job: DispatchableJob): Promise<DispatchResult> {
  if (!dispatcher.configured()) {
    return { ok: false, error: DISPATCHER_NOT_CONFIGURED_MESSAGE };
  }
  try {
    await dispatcher.dispatch(job);
    return { ok: true, dispatcher: dispatcher.name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
