/**
 * ホイール / トラックパッドのズームを Obsidian のグラフビュー（publish.obsidian.md）と同じ感触にする。
 *
 * Leaflet の標準は 40ms ためて zoomSnap 単位に切り上げるので、Mac のトラックパッドが出す細かい連続イベントと
 * 相性が悪く、少し撫でただけで一気に飛ぶ。sekai-nina-site の src/scripts/smooth-zoom.ts から移植。
 * Obsidian のやり方に揃える:
 * - 目標倍率を deltaY に比例して動かす（120px で 1.5 倍）
 * - 毎フレーム現在倍率を目標へ 15% ずつ寄せ、差が 1% を切ったら止める
 * - 拡大はカーソル位置を、縮小はビューポート中心を固定する
 */
import type * as Leaflet from "leaflet";

const STEP_RATIO = 1.5; // STEP_PX あたりの倍率
const STEP_PX = 120;
const EASE = 0.15; // 1 フレームで目標へ寄せる割合
const SETTLE = 0.01; // 目標との比がこれ未満なら収束

interface Point {
  x: number;
  y: number;
}

export interface ZoomView {
  /** 現在の倍率 */
  scale(): number;
  /** 倍率の [下限, 上限] */
  limits(): [number, number];
  /** ビューポート上の点 c（el 左上基準の CSS px）を動かさずに倍率を next にする */
  apply(next: number, c: Point): void;
  /** 目標に収束したとき */
  settle?(): void;
}

/** el のホイールを capture で先取りして view を Obsidian 流にズームする。el はライブラリのリスナーより外側の要素 */
export function bindWheelZoom(el: HTMLElement, view: ZoomView): void {
  let target: number | null = null; // null = 停止中
  let center: Point = { x: 0, y: 0 };

  const tick = () => {
    if (target === null) return;
    if (!el.isConnected) { target = null; return; } // アニメ中に destroy された
    const cur = view.scale();
    if (Math.max(cur / target, target / cur) - 1 < SETTLE) {
      if (target !== cur) view.apply(target, center);
      target = null;
      view.settle?.();
      return;
    }
    view.apply(cur + (target - cur) * EASE, center);
    requestAnimationFrame(tick);
  };

  el.addEventListener("wheel", (e) => {
    e.preventDefault();
    e.stopPropagation(); // ライブラリ自身のホイール処理（固定量ズーム）に渡さない
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 40;
    else if (e.deltaMode === 2) dy *= 800;
    const [min, max] = view.limits();
    const from = target ?? view.scale();
    const next = Math.min(max, Math.max(min, from * Math.pow(STEP_RATIO, -dy / STEP_PX)));
    if (next === from) return;
    const r = el.getBoundingClientRect();
    center = next > view.scale() ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: r.width / 2, y: r.height / 2 };
    if (target === null) requestAnimationFrame(tick);
    target = next;
  }, { capture: true, passive: false });
}

// ---------- Leaflet ----------

// ピンチ（TouchZoom）と同じ経路を使うので private を少し触る（leaflet@1.9.4 に固定）
type LeafletInternals = Leaflet.Map & {
  _stop(): void;
  _moveStart(zoomChanged: boolean, noMoveStart: boolean): Leaflet.Map;
  _move(center: Leaflet.LatLng, zoom: number, data?: Record<string, unknown>, supressEvent?: boolean): Leaflet.Map;
  _moveEnd(zoomChanged: boolean): Leaflet.Map;
};

/**
 * 標準の scrollWheelZoom（40ms デバウンス → zoomSnap 単位で 250ms アニメ、その間の入力は捨てる）を置き換える。
 * 途中の倍率で止まるので、map は zoomSnap: 0 で作ること
 */
export function leafletWheelZoom(map: Leaflet.Map): void {
  const m = map as LeafletInternals;
  map.scrollWheelZoom.disable();
  let active = false;
  // 固定点。_move は pixelOrigin を整数に丸めるので、毎フレーム現在の表示から求め直すと丸めが積もってカーソル下がずれる
  let anchor: Leaflet.LatLng | null = null;
  let anchorAt: Point | null = null;
  bindWheelZoom(map.getContainer(), {
    scale: () => 2 ** map.getZoom(),
    limits: () => [2 ** map.getMinZoom(), 2 ** map.getMaxZoom()],
    apply(next, c) {
      const zoom = Math.log2(next);
      // ピンチと同じく movestart → 毎フレーム _move(pinch)。タイルは CSS 変形だけで済み、取り直しや整理は終わるまで走らない
      if (!active) {
        active = true;
        m._stop();
        m._moveStart(true, false);
        anchorAt = null;
      }
      if (!anchor || !anchorAt || anchorAt.x !== c.x || anchorAt.y !== c.y) {
        anchor = map.containerPointToLatLng([c.x, c.y]);
        anchorAt = c;
      }
      // anchor が c の位置に来る中心
      const half = map.getSize().divideBy(2);
      const center = map.unproject(map.project(anchor, zoom).subtract([c.x - half.x, c.y - half.y]), zoom);
      m._move(center, zoom, { pinch: true, round: false });
    },
    settle() {
      if (!active) return;
      active = false;
      // ズームアニメ終了時（_onZoomTransitionEnd）と同じ順で通常の zoom / moveend を出し、タイル整理やクラスタ更新をさせる
      map.fire("zoom");
      map.fire("move");
      m._moveEnd(true);
    },
  });
}
