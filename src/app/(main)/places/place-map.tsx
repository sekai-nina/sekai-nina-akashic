"use client";

/**
 * 聖地マップ (/places) の本体。sekai-nina-site の /map (src/scripts/pilgrimage-map.ts) を移植したもの。
 *
 * - 地図が主役。左のパネル (スマホではボトムシート) にリストと絞り込みを置く
 * - リストは既定で「新しい順」(登録日。新着を見落とさないため)。「近い順」に切り替えると、
 *   サイトと同じく今地図に見えている範囲を中心 (または現在地・検索地点) から近い順に並べる
 * - 登録から NEW_PLACE_DAYS 日以内の聖地は、ピン・まとまり・リストに NEW を付ける
 * - 検索は手元の場所名・住所・エリア・記事名に即時一致 → 無ければ Nominatim で地名を探して地図を移動
 * - ルートモード (?article=<shortId>): その記事の地点だけを訪問順の番号付きで表示する
 *
 * Leaflet は命令的に操作し、パネルは React で描く。地図のイベントからは最新の状態を ref 経由で読む。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import L from "leaflet";
import "./leaflet-global";
import "leaflet.markercluster";
import "leaflet/dist/leaflet.css";
import "./place-map.css";
import { leafletWheelZoom } from "@/lib/places/smooth-zoom";
import {
  MAP_KIND_COLORS,
  MAP_KIND_ICONS,
  NEW_PLACE_DAYS,
  type MapArticle,
  type MapKind,
  type MapPlace,
  type PlaceMapData,
} from "@/lib/places/map";
import { PLACE_CLASSIFICATION_LABELS, PLACE_KIND_LABELS } from "@/lib/utils";

const KIND_LABELS: Record<MapKind, string> = { ...PLACE_KIND_LABELS, unset: "未設定" };
const KIND_ORDER: MapKind[] = ["food", "leisure", "scenery", "venue", "shop", "unset"];

type Sheet = "peek" | "half" | "full";
type Sort = "new" | "near";
type LatLng = { lat: number; lng: number };
type ClusterMarker = L.Marker & { place: MapPlace; routeNo: number | null };
type ClusterGroup = L.MarkerClusterGroup & { _inZoomAnimation?: number }; // 内部値。ズームアニメ中は 1 以上

const PEEK = 104; // place-map.css の --pmap-peek と合わせる
const isPhone = () => window.matchMedia("(max-width: 767px)").matches;
const esc = (s: unknown) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const svg = (k: MapKind) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true">${MAP_KIND_ICONS[k]}</svg>`;
const km = (a: LatLng, b: LatLng) => {
  const R = 6371, r = Math.PI / 180;
  const dp = (b.lat - a.lat) * r, dl = (b.lng - a.lng) * r;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const fmtDist = (d: number) => (d < 1 ? `${Math.round(d * 1000)}m` : d < 10 ? `${d.toFixed(1)}km` : `${Math.round(d)}km`);
const fmtVisit = (date: string, disp: string) => disp || (date ? date.slice(0, 7).replace("-", ".") : "");
const jstParts = (iso: string) => {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
};
/** 登録日。今年なら M/D、去年以前は YYYY/M/D (JST) */
const fmtAdded = (iso: string) => {
  const a = jstParts(iso), now = jstParts(new Date().toISOString());
  return a.y === now.y ? `${a.m}/${a.d}` : `${a.y}/${a.m}/${a.d}`;
};
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");

function KindIcon({ kind }: { kind: MapKind }) {
  return <svg className="ic" viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: MAP_KIND_ICONS[kind] }} />;
}
const SearchIcon = () => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
);
const PinIcon = () => (
  <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" /><circle cx="12" cy="10" r="3" /></svg>
);

interface NominatimRow { lat: string; lon: string; name?: string; display_name: string }
type Results =
  | null
  | { kind: "local"; text: string; places: MapPlace[] }
  | { kind: "status"; text: string }
  | { kind: "geo"; rows: NominatimRow[] };

export function PlaceMap({ data }: { data: PlaceMapData }) {
  const { places, areas } = data;
  const byId = useMemo(() => new Map(places.map((p) => [p.id, p])), [places]);
  const articles = useMemo(() => new Map(data.articles.map((a) => [a.shortId, a])), [data.articles]);
  const newCount = useMemo(() => places.filter((p) => p.isNew).length, [places]);

  // ---------- 状態 ----------
  const [kinds, setKinds] = useState<Set<MapKind>>(new Set());
  const [onlyNew, setOnlyNew] = useState(false);
  const [sort, setSort] = useState<Sort>("new");
  const [route, setRouteState] = useState<MapArticle | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [user, setUser] = useState<LatLng | null>(null);
  const [qpin, setQpin] = useState<(LatLng & { name: string }) | null>(null);
  const [locState, setLocState] = useState<"off" | "busy" | "on">("off");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Results>(null);
  const [sheet, setSheetState] = useState<Sheet>("peek");
  const [facetsOpen, setFacetsOpen] = useState(false);
  const [hint, setHint] = useState<{ text: string; hide: boolean } | null>(null);
  const [viewTick, setViewTick] = useState(0); // 地図が動いたら「近い順」を数え直す

  // ---------- 要素・地図 ----------
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const mapElRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const clusterRef = useRef<ClusterGroup | null>(null);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const routeLineRef = useRef<L.Polyline | null>(null);
  const markersRef = useRef(new Map<string, ClusterMarker>());
  const meLayerRef = useRef<L.LayerGroup | null>(null);
  const qpinMarkerRef = useRef<L.Marker | null>(null);
  const hintTimer = useRef(0);
  const scrollReq = useRef<{ id: string; toTop: boolean } | null>(null);

  const passes = (p: MapPlace) => {
    if (route) return route.places.includes(p.id);
    if (kinds.size && !kinds.has(p.kind)) return false;
    if (onlyNew && !p.isNew) return false;
    return true;
  };

  // 地図のイベントハンドラから最新の状態・関数を読むための入れ物
  const live = useRef({ selected, route, select: (_id: string | null, _o?: { fly?: boolean; fromMap?: boolean }) => {} });

  // ---------- 地図の補助 ----------
  // スマホではシートが地図の下側を覆うので、その分を padding / オフセットに入れる
  const sheetCover = () => {
    const root = rootRef.current, panel = panelRef.current;
    if (!isPhone() || !root || !panel) return 0;
    return Math.max(0, root.clientHeight - parseFloat(panel.style.getPropertyValue("--pmap-sheet-y") || String(root.clientHeight)));
  };
  const fitVisible = (bounds: L.LatLngBounds, opts: L.FitBoundsOptions = {}) =>
    mapRef.current?.flyToBounds(bounds, { paddingTopLeft: [40, isPhone() ? 70 : 40], paddingBottomRight: [40, 40 + sheetCover()], ...opts });
  const flyVisible = (latlng: L.LatLngExpression, zoom: number) => {
    const map = mapRef.current;
    if (!map) return;
    const pt = map.project(L.latLng(latlng), zoom);
    map.flyTo(map.unproject(pt.add([0, sheetCover() / 2]), zoom), zoom, { duration: 0.6 });
  };
  const showHint = (text: string, ms: number) => {
    setHint({ text, hide: false });
    window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint((h) => (h ? { ...h, hide: true } : h)), ms);
  };

  // ---------- ボトムシート (スマホ) ----------
  const sheetY = (state: Sheet) => {
    const H = rootRef.current?.clientHeight ?? 0;
    return state === "full" ? 64 : state === "half" ? Math.round(H * 0.48) : H - PEEK;
  };
  const setSheet = (state: Sheet) => {
    if (!isPhone()) return;
    panelRef.current?.style.setProperty("--pmap-sheet-y", sheetY(state) + "px");
    setSheetState(state);
    if (state === "peek") setFacetsOpen(false);
  };
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;

  // ---------- 選択 ----------
  function select(id: string | null, { fly = false, fromMap = false }: { fly?: boolean; fromMap?: boolean } = {}) {
    setSelected(id);
    const p = id ? byId.get(id) : undefined;
    if (!p) return;
    if (isPhone()) setSheet("half");
    if (fly) {
      const map = mapRef.current, cluster = clusterRef.current;
      flyVisible([p.lat, p.lng], Math.max(map?.getZoom() ?? 0, 15));
      // flyTo の moveend 時点では markercluster のズームアニメがまだ終わっていない。その最中に zoomToShowLayer が
      // setView を重ねるとアニメ終了処理が全ピンを消すので、終わってから呼ぶ (サイトで踏んだ不具合)
      if (!route && map && cluster) {
        map.once("moveend", () => {
          const go = () => cluster.zoomToShowLayer(markersRef.current.get(p.id)!, decoratePins);
          if (cluster._inZoomAnimation) cluster.once("animationend", go);
          else go();
        });
      }
    }
    scrollReq.current = { id: p.id, toTop: fromMap || isPhone() };
  }
  live.current = { selected, route, select };

  // ---------- ピンの見た目 ----------
  function decoratePins() {
    const { selected: sel } = live.current;
    for (const [id, m] of markersRef.current) {
      const el = m.getElement()?.querySelector<HTMLElement>(".pmap-pin");
      if (!el) continue;
      el.classList.toggle("is-selected", sel === id);
      el.classList.toggle("in-route", !!m.routeNo);
      const num = el.querySelector(".num");
      if (num) num.textContent = m.routeNo ? String(m.routeNo) : "";
      m.setZIndexOffset(sel === id ? 1000 : m.place.isNew ? 500 : 0);
    }
  }

  // ---------- 地図の初期化 (1 回だけ) ----------
  useEffect(() => {
    const mapEl = mapElRef.current;
    if (!mapEl) return;
    // zoomSnap: 0 はホイール/ピンチを途中の倍率で止めるため
    const map = L.map(mapEl, { zoomControl: !isPhone(), attributionControl: true, maxZoom: 19, minZoom: 4, zoomSnap: 0 });
    mapRef.current = map;
    leafletWheelZoom(map);
    const osm = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    });
    // 国土地理院の淡色地図 (キー不要・日本語ラベル)。日本の外 (ハワイ) は OSM に切り替える
    const gsi = L.tileLayer("https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png", {
      attribution: '<a href="https://maps.gsi.go.jp/development/ichiran.html">地理院タイル</a>',
      minZoom: 5,
      maxZoom: 18,
      maxNativeZoom: 18,
    });
    const inJapan = (ll: L.LatLng) => ll.lat > 20 && ll.lat < 46 && ll.lng > 122 && ll.lng < 154;
    let base: L.TileLayer | null = null;
    const ensureBase = () => {
      const want = inJapan(map.getCenter()) ? gsi : osm;
      if (base === want) return;
      if (base) map.removeLayer(base);
      base = want.addTo(map);
      base.bringToBack();
      mapEl.classList.toggle("gsi", want === gsi);
    };

    const cluster = L.markerClusterGroup({
      // 低ズームでは関東 (約 50km 幅) だけがまとまる半径
      maxClusterRadius: (z: number) => (z <= 8 ? Math.min(110, 12 * 2 ** (z - 5) + 12) : 44),
      showCoverageOnHover: false,
      spiderfyOnMaxZoom: true,
      zoomToBoundsOnClick: false,
      iconCreateFunction(c) {
        const kids = c.getAllChildMarkers() as ClusterMarker[];
        const n = kids.length;
        const nNew = kids.filter((m) => m.place.isNew).length;
        const badge = nNew ? `<span class="cl-new">NEW ${nNew}</span>` : "";
        const cls = `pmap-cl${nNew ? " has-new" : ""}`;
        // 低ズームではエリア名を添える。複数エリアが混ざるまとまりは一番多いエリア＋「ほか」
        if (map.getZoom() <= 8) {
          const count = new Map<string, number>();
          for (const m of kids) count.set(m.place.area, (count.get(m.place.area) ?? 0) + 1);
          const [top] = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
          const label = count.size === 1 ? top : `${top}ほか`;
          return L.divIcon({ html: `<div class="${cls}"><span class="area">${esc(label)}</span><b>${n}</b>${badge}</div>`, className: "", iconSize: [0, 0] });
        }
        return L.divIcon({ html: `<div class="${cls} only-count"><b>${n}</b>${badge}</div>`, className: "", iconSize: [0, 0] });
      },
    }) as ClusterGroup;
    clusterRef.current = cluster;
    cluster.on("clusterclick", (e) => {
      const layer = (e as unknown as { layer: L.MarkerCluster }).layer;
      const b = layer.getBounds();
      if (map.getZoom() >= map.getMaxZoom() || b.getNorthEast().equals(b.getSouthWest())) { layer.spiderfy(); return; }
      fitVisible(b, { maxZoom: 16 });
    });

    for (const p of places) {
      const html =
        `<div class="pmap-pin${p.isNew ? " is-new" : ""}" style="color:${MAP_KIND_COLORS[p.kind]}">` +
        `<span class="num"></span>${p.isNew ? '<span class="new">NEW</span>' : ""}` +
        `<div class="disc">${svg(p.kind)}</div><span class="label">${esc(p.name)}</span></div>`;
      const m = L.marker([p.lat, p.lng], {
        icon: L.divIcon({ html, className: "", iconSize: [30, 30], iconAnchor: [15, 15] }),
        title: p.name,
      }) as ClusterMarker;
      m.place = p;
      m.routeNo = null;
      m.on("click", () => {
        live.current.select(p.id, { fromMap: true });
        if (isPhone()) flyVisible([p.lat, p.lng], map.getZoom());
      });
      markersRef.current.set(p.id, m);
    }
    routeLayerRef.current = L.layerGroup();

    const updateLabels = () => mapEl.classList.toggle("labels", map.getZoom() >= 13);
    map.on("moveend", ensureBase);
    map.on("zoomend moveend", () => { updateLabels(); decoratePins(); });
    map.on("moveend", () => setViewTick((t) => t + 1));
    map.on("click", () => {
      if (live.current.selected) live.current.select(null);
      setResults(null);
    });
    cluster.on("animationend spiderfied", decoratePins);

    // 最初に見せるのは関東 (聖地の大半)。全国に引くと一つひとつが点になって何があるか分からない。
    // 関東に 1 件も無ければ日本全体 → 全件と広げる
    if (isPhone()) setSheet("peek"); // 先にシートの高さを決め、その分を下の余白に入れて枠に収める
    const KANTO = L.latLngBounds([34.8, 138.6], [36.6, 140.9]);
    const kanto = places.filter((p) => KANTO.contains([p.lat, p.lng]));
    const jp = places.filter((p) => p.area !== "ハワイ");
    const initial = kanto.length ? kanto : jp.length ? jp : places;
    if (initial.length) fitVisible(L.latLngBounds(initial.map((p) => [p.lat, p.lng] as [number, number])), { maxZoom: 11, animate: false });
    else map.setView([36.5, 138.0], 6);
    ensureBase();
    map.addLayer(cluster);
    map.addLayer(routeLayerRef.current);
    updateLabels();

    const P = new URLSearchParams(window.location.search);
    const initArticle = P.get("article");
    const initPlace = P.get("place");
    if (initArticle && articles.has(initArticle)) {
      setRoute(initArticle);
    } else if (initPlace && byId.has(initPlace)) {
      const p = byId.get(initPlace)!;
      map.setView([p.lat, p.lng], 15, { animate: false });
      live.current.select(initPlace);
    } else {
      showHint(isPhone() ? "地図を動かして「近い順」にすると、範囲内の聖地が並びます" : "「近い順」にすると、地図に見えている範囲の聖地が左に並びます", 5000);
      map.once("movestart", () => setHint((h) => (h ? { ...h, hide: true } : h)));
    }
    const t = window.setTimeout(() => { decoratePins(); setViewTick((v) => v + 1); }, 50);

    const onResize = () => { if (isPhone()) setSheet(sheetRef.current); };
    window.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("resize", onResize);
      map.remove();
      mapRef.current = null;
      markersRef.current.clear();
    };
    // 地図は 1 度だけ作る (places は再取得しない限り変わらない)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 絞り込み・ルートを地図に反映 ----------
  useEffect(() => {
    const map = mapRef.current, cluster = clusterRef.current, routeLayer = routeLayerRef.current;
    if (!map || !cluster || !routeLayer) return;
    cluster.clearLayers();
    routeLayer.clearLayers();
    if (routeLineRef.current) { map.removeLayer(routeLineRef.current); routeLineRef.current = null; }
    for (const m of markersRef.current.values()) m.routeNo = null;
    const visible = places.filter(passes).map((p) => markersRef.current.get(p.id)!);
    if (route) {
      const pts = route.places.map((id) => byId.get(id)).filter((p): p is MapPlace => !!p);
      routeLineRef.current = L.polyline(pts.map((p) => [p.lat, p.lng] as [number, number]), {
        color: "#15803d", weight: 3, dashArray: "6 6", opacity: 0.8,
      }).addTo(map);
      pts.forEach((p, i) => { markersRef.current.get(p.id)!.routeNo = i + 1; });
      // ルートモードでは地点が少なく番号を見せたいので、まとめずに直接置く
      visible.forEach((m) => routeLayer.addLayer(m));
    } else {
      cluster.addLayers(visible);
    }
    requestAnimationFrame(decoratePins);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kinds, onlyNew, route]);

  useEffect(() => { decoratePins(); }, [selected]); // eslint-disable-line react-hooks/exhaustive-deps

  // 選択した項目をリストの見える位置へ
  useEffect(() => {
    const req = scrollReq.current, list = listRef.current;
    if (!req || !list) return;
    scrollReq.current = null;
    const li = list.querySelector<HTMLElement>(`.pmap-item[data-id="${CSS.escape(req.id)}"]`);
    if (!li) return;
    const top = li.offsetTop - list.offsetTop;
    const bottom = top + li.offsetHeight;
    if (req.toTop) list.scrollTop = top;
    else if (top < list.scrollTop || bottom > list.scrollTop + list.clientHeight) list.scrollTo({ top: Math.max(0, top - 8), behavior: "smooth" });
  });

  // ---------- ルートモード ----------
  function setRoute(shortId: string | null) {
    const r = shortId ? articles.get(shortId) ?? null : null;
    setRouteState(r);
    setSelected(null);
    if (r) {
      const pts = r.places.map((id) => byId.get(id)).filter((p): p is MapPlace => !!p);
      if (isPhone()) setSheet("half");
      fitVisible(L.latLngBounds(pts.map((p) => [p.lat, p.lng] as [number, number])), { maxZoom: 15, duration: 0.8 });
    }
    const url = new URL(window.location.href);
    if (r) url.searchParams.set("article", r.shortId);
    else url.searchParams.delete("article");
    window.history.replaceState(null, "", url);
  }
  const routeGmaps = () => {
    if (!route) return;
    const pts = route.places.map((id) => byId.get(id)).filter((p): p is MapPlace => !!p);
    if (pts.length < 2) return;
    const ll = (p: MapPlace) => `${p.lat},${p.lng}`;
    // Google Maps の経路 URL は経由地が最大 9 つ程度
    const url =
      `https://www.google.com/maps/dir/?api=1&origin=${ll(pts[0])}&destination=${ll(pts[pts.length - 1])}` +
      (pts.length > 2 ? `&waypoints=${pts.slice(1, -1).slice(0, 9).map(ll).join("|")}` : "") +
      "&travelmode=transit";
    window.open(url, "_blank", "noopener");
  };

  // ---------- エリア ----------
  function jumpToArea(area: string) {
    const pts = places.filter((p) => p.area === area && passes(p));
    if (!pts.length) return;
    if (selected) select(null);
    setSort("near"); // エリアへ飛んだらその範囲の聖地を並べる
    if (isPhone()) setSheet("half");
    fitVisible(L.latLngBounds(pts.map((p) => [p.lat, p.lng] as [number, number])), { maxZoom: 14, duration: 0.8 });
  }

  // ---------- 現在地 ----------
  function locate() {
    const map = mapRef.current;
    if (!map) return;
    if (user) { flyVisible(user, Math.max(map.getZoom(), 14)); return; }
    if (!navigator.geolocation) { showHint("この端末では位置情報が使えません", 2500); return; }
    setLocState("busy");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setUser(me);
        setSort("near");
        setLocState("on");
        if (meLayerRef.current) map.removeLayer(meLayerRef.current);
        meLayerRef.current = L.layerGroup([
          L.circle(me, { radius: pos.coords.accuracy, color: "#2f7ef0", weight: 1, fillOpacity: 0.08 }),
          L.marker(me, {
            icon: L.divIcon({ html: '<div class="pmap-me"></div>', className: "", iconSize: [18, 18], iconAnchor: [9, 9] }),
            interactive: false,
            zIndexOffset: 2000,
          }),
        ]).addTo(map);
        if (isPhone()) setSheet("half");
        flyVisible(me, Math.max(map.getZoom(), 13));
      },
      (err) => {
        setLocState("off");
        showHint(err.code === 1 ? "位置情報の利用が許可されていません" : "現在地を取得できませんでした", 2500);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  }

  // ---------- 検索 ----------
  const localMatches = (text: string) => {
    const t = norm(text);
    if (!t) return [];
    return places
      .filter((p) => norm(p.name).includes(t) || norm(p.address).includes(t) || norm(p.area).includes(t) || p.visits.some((v) => norm(v.title).includes(t)))
      .slice(0, 6);
  };
  const onQuery = (text: string) => {
    setQuery(text);
    setResults(text.trim() ? { kind: "local", text, places: localMatches(text) } : null);
  };
  function clearQpin() {
    if (qpinMarkerRef.current) { mapRef.current?.removeLayer(qpinMarkerRef.current); qpinMarkerRef.current = null; }
    setQpin(null);
  }
  function pick(id: string) {
    const p = byId.get(id);
    if (!p) return;
    setQuery(p.name);
    setResults(null);
    (document.activeElement as HTMLElement | null)?.blur();
    clearQpin();
    select(id, { fly: true });
  }
  function goToGeo(lat: number, lng: number, name: string) {
    const map = mapRef.current;
    if (!map) return;
    setQuery(name);
    setResults(null);
    (document.activeElement as HTMLElement | null)?.blur();
    clearQpin();
    if (selected) select(null);
    qpinMarkerRef.current = L.marker([lat, lng], {
      icon: L.divIcon({ html: `<div class="pmap-qpin"><span class="label">${esc(name)}</span></div>`, className: "", iconSize: [12, 12], iconAnchor: [6, 6] }),
      interactive: false,
      zIndexOffset: 1500,
    }).addTo(map);
    setQpin({ lat, lng, name });
    setSort("near");
    if (isPhone()) setSheet("half");
    flyVisible([lat, lng], 14);
  }
  async function geocode(text: string) {
    setResults({ kind: "status", text: "地名を探しています…" });
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=ja&q=${encodeURIComponent(text)}`);
      const rows = (await r.json()) as NominatimRow[];
      setResults(rows.length ? { kind: "geo", rows } : { kind: "status", text: `「${text}」が見つかりませんでした` });
    } catch {
      setResults({ kind: "status", text: "地名検索に接続できませんでした" });
    }
  }

  // ---------- ボトムシートのドラッグ (スマホ) ----------
  // peek / half ではパネル上のどこを縦に引いてもシートが動く (リストは full のときだけスクロールする)。
  // full ではリストが先頭にある状態で下へ引いたときだけシートが降りる。タップでの開閉はハンドルだけ
  useEffect(() => {
    const panel = panelRef.current, list = listRef.current, handle = handleRef.current;
    if (!panel || !list || !handle) return;
    const MOVE = 6; // これ未満はタップ扱い
    type Mode = "none" | "sheet" | "scroll";
    let mode: Mode = "none", active = false, moved = false, onHandle = false, inList = false;
    let y0 = 0, start = 0, cur = 0, lastY = 0, lastT = 0, vy = 0, swallowClickUntil = 0;
    const current = () => sheetRef.current;

    const begin = (target: EventTarget | null, y: number) => {
      if (!isPhone()) return false;
      const el = target as Node;
      active = true; moved = false; vy = 0;
      y0 = lastY = y; lastT = performance.now();
      start = cur = sheetY(current());
      onHandle = handle.contains(el); inList = list.contains(el);
      mode = current() === "full" && inList && list.scrollTop > 0 ? "scroll" : "none";
      return true;
    };
    // 戻り値: ブラウザ既定動作 (スクロール) を止めるべきか
    const move = (y: number): boolean => {
      if (!active || mode === "scroll") return false;
      const dy = y - y0;
      if (mode === "none") {
        if (dy === 0) return false;
        if (current() === "full" && inList && dy < 0) { mode = "scroll"; return false; }
        mode = "sheet";
      }
      const now = performance.now();
      if (now > lastT) vy = 0.6 * vy + 0.4 * ((y - lastY) / (now - lastT));
      lastY = y; lastT = now;
      if (!moved && Math.abs(dy) >= MOVE) { moved = true; panel.classList.add("dragging"); }
      if (moved) {
        cur = Math.max(sheetY("full"), Math.min(sheetY("peek"), start + dy));
        panel.style.setProperty("--pmap-sheet-y", cur + "px");
      }
      return true;
    };
    // 戻り値: ドラッグとして消費したか (true なら後続の click を抑止する)
    const end = (cancelled = false): boolean => {
      if (!active) return false;
      active = false;
      panel.classList.remove("dragging");
      const state = current();
      if (!moved) {
        if (onHandle && !cancelled) setSheet(state === "peek" ? "half" : state === "half" ? "full" : "half");
        return false;
      }
      const states: Sheet[] = ["full", "half", "peek"];
      let best = states.reduce((a, s) => (Math.abs(sheetY(s) - cur) < Math.abs(sheetY(a) - cur) ? s : a), "half" as Sheet);
      const flick = performance.now() - lastT < 80 ? vy : 0; // 止めてから離したらフリック扱いにしない
      if (flick > 0.5) best = state === "full" ? "half" : "peek";
      if (flick < -0.5) best = state === "peek" ? "half" : "full";
      setSheet(best);
      swallowClickUntil = performance.now() + 400;
      return true;
    };
    const ac = new AbortController();
    const o = { signal: ac.signal };
    // ドラッグ直後の click は誤爆なので握りつぶす
    panel.addEventListener("click", (e) => { if (performance.now() < swallowClickUntil) { e.stopPropagation(); e.preventDefault(); } }, { capture: true, ...o });
    const touchY = (e: TouchEvent) => e.changedTouches[0]?.clientY ?? 0;
    panel.addEventListener("touchstart", (e) => { if (e.touches.length === 1) begin(e.target, touchY(e)); else if (active) end(true); }, { passive: true, ...o });
    panel.addEventListener("touchmove", (e) => { if (move(touchY(e)) && e.cancelable) e.preventDefault(); }, { passive: false, ...o });
    panel.addEventListener("touchend", (e) => { if (end() && e.cancelable) e.preventDefault(); }, { passive: false, ...o });
    panel.addEventListener("touchcancel", () => end(true), o);
    // マウスで狭い幅を試すとき用
    panel.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse" || e.button !== 0 || !begin(e.target, e.clientY)) return;
      panel.setPointerCapture(e.pointerId);
    }, o);
    panel.addEventListener("pointermove", (e) => { if (e.pointerType === "mouse") move(e.clientY); }, o);
    panel.addEventListener("pointerup", (e) => { if (e.pointerType === "mouse") end(); }, o);
    panel.addEventListener("pointercancel", (e) => { if (e.pointerType === "mouse") end(true); }, o);
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- リスト ----------
  const listView = useMemo(() => {
    const map = mapRef.current;
    const all = places.filter(passes);
    if (route) {
      const items = route.places.map((id) => byId.get(id)).filter((p): p is MapPlace => !!p).map((p) => ({ p, d: 0 }));
      return { title: "ルートの地点", items, sortLabel: "記事の順", empty: null };
    }
    const origin: LatLng = user ?? qpin ?? (map ? map.getCenter() : { lat: 35.68, lng: 139.76 });
    if (sort === "new") {
      // 新しい順は地図の範囲に関係なく全件 (今まで通り、新着を見落とさないため)
      return { title: onlyNew ? "新着の聖地" : "すべての聖地", items: all.map((p) => ({ p, d: km(origin, p) })), sortLabel: null, empty: null };
    }
    const b = map?.getBounds();
    const items = all
      .filter((p) => !b || b.contains([p.lat, p.lng]))
      .map((p) => ({ p, d: km(origin, p) }))
      .sort((a, c) => a.d - c.d);
    const empty = items.length ? null : all.map((p) => ({ p, d: km(origin, p) })).sort((a, c) => a.d - c.d).slice(0, 4);
    return { title: "この範囲の聖地", items, sortLabel: user ? "現在地から" : qpin ? "検索地点から" : "地図の中心から", empty };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places, kinds, onlyNew, route, sort, user, qpin, viewTick, byId]);

  const showDist = !route && sort === "near" && (user || qpin);
  const activeSum = [...kinds].map((k) => KIND_LABELS[k]).concat(onlyNew ? ["新着"] : []);

  return (
    <div className="pmap" ref={rootRef}>
      <div className="pmap-searchbar">
        <div className="pmap-search-row">
          <label className="pmap-search-field">
            <SearchIcon />
            <input
              type="search"
              placeholder="聖地名・住所・記事名・地名で探す"
              aria-label="聖地名・住所・記事名・地名で探す"
              autoComplete="off"
              enterKeyHint="search"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              onFocus={() => { if (query) onQuery(query); }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  // 日本語入力の変換確定 Enter で検索を走らせない (keyCode 229 は isComposing を報せないブラウザ向け)
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  e.preventDefault();
                  const l = localMatches(query);
                  if (l.length) pick(l[0].id);
                  else if (query.trim()) void geocode(query);
                }
                if (e.key === "Escape") { setResults(null); e.currentTarget.blur(); }
              }}
            />
            {query && (
              <button
                className="pmap-clear"
                type="button"
                aria-label="消去"
                onClick={() => { setQuery(""); setResults(null); clearQpin(); }}
              >
                <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            )}
          </label>
          <button className="pmap-locate" type="button" data-state={locState} aria-label="現在地を表示" title="現在地" onClick={locate}>
            <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><line x1="2" x2="5" y1="12" y2="12" /><line x1="19" x2="22" y1="12" y2="12" /><line x1="12" x2="12" y1="2" y2="5" /><line x1="12" x2="12" y1="19" y2="22" /><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="3" /></svg>
          </button>
        </div>
        {results && (
          <div className="pmap-results">
            {results.kind === "local" && (
              <>
                {results.places.map((p) => (
                  <button key={p.id} type="button" onClick={() => pick(p.id)}>
                    <span className="pmap-kind-ic" style={{ color: MAP_KIND_COLORS[p.kind] }}><KindIcon kind={p.kind} /></span>
                    <span className="r-name">{p.isNew && <span className="pmap-new">NEW</span>}{p.name}</span>
                    <span className="r-sub">{p.area}</span>
                  </button>
                ))}
                <button type="button" onClick={() => void geocode(results.text)}>
                  <span className="r-geo"><SearchIcon /></span>
                  <span className="r-geo">「{results.text}」の周辺を地図で探す</span>
                </button>
              </>
            )}
            {results.kind === "status" && <div className="r-hint">{results.text}</div>}
            {results.kind === "geo" && (
              <>
                {results.rows.map((x, i) => {
                  const name = x.name || x.display_name.split(",")[0];
                  const sub = x.display_name.split(",").slice(1, 3).join("");
                  return (
                    <button key={i} type="button" onClick={() => goToGeo(Number(x.lat), Number(x.lon), name)}>
                      <span className="r-geo"><PinIcon /></span>
                      <span className="r-name">{name}</span>
                      <span className="r-sub">{sub}</span>
                    </button>
                  );
                })}
                <div className="r-hint">地名検索: OpenStreetMap Nominatim</div>
              </>
            )}
          </div>
        )}
      </div>

      <aside className="pmap-panel" ref={panelRef} data-sheet={sheet}>
        <div className="pmap-sheet-handle" ref={handleRef}><span /></div>
        {!route && (
          <div className={`pmap-facets${facetsOpen ? " open" : ""}`}>
            <button
              className="pmap-facets-toggle"
              type="button"
              onClick={() => {
                setFacetsOpen((v) => !v);
                if (!facetsOpen && isPhone() && sheet === "peek") setSheet("half"); // peek のままだと絞り込み欄が画面外
              }}
            >
              <span>絞り込み</span><span className="sum">{activeSum.length ? activeSum.join(" · ") : "なし"}</span>
              <svg className="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>
            <div className="pmap-facet-rows">
              <div className="pmap-facet-row">
                <span className="pmap-facet-label">新着</span>
                <div className="pmap-chips">
                  <button
                    className="pmap-chip is-new"
                    type="button"
                    aria-pressed={onlyNew}
                    disabled={!newCount}
                    onClick={() => setOnlyNew((v) => !v)}
                  >
                    NEW（{NEW_PLACE_DAYS}日以内）<small>{newCount}</small>
                  </button>
                </div>
              </div>
              <div className="pmap-facet-row">
                <span className="pmap-facet-label">エリア</span>
                <div className="pmap-chips">
                  {areas.map((a) => {
                    const n = places.filter((p) => p.area === a && passes(p)).length;
                    return (
                      <button key={a} className="pmap-chip" type="button" disabled={!n} onClick={() => jumpToArea(a)}>
                        {a} <small>{n}</small>
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="pmap-facet-row">
                <span className="pmap-facet-label">種類</span>
                <div className="pmap-chips">
                  {KIND_ORDER.map((k) => {
                    const n = places.filter((p) => p.kind === k && (!onlyNew || p.isNew)).length;
                    if (k === "unset" && !n) return null;
                    return (
                      <button
                        key={k}
                        className="pmap-chip"
                        type="button"
                        aria-pressed={kinds.has(k)}
                        onClick={() =>
                          setKinds((prev) => {
                            const next = new Set(prev);
                            if (next.has(k)) next.delete(k);
                            else next.add(k);
                            return next;
                          })
                        }
                      >
                        <span style={{ color: kinds.has(k) ? undefined : MAP_KIND_COLORS[k], display: "inline-flex" }}><KindIcon kind={k} /></span>
                        {KIND_LABELS[k]} <small>{n}</small>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {route && (
          <div className="pmap-route-head">
            <div className="pmap-rt-eyebrow">記事のルート</div>
            <div className="pmap-rt-title">
              {route.title}
              <small>{fmtVisit(route.date, route.dateDisplay)} · {route.places.length}か所を訪れた順に表示</small>
            </div>
            <div className="pmap-rt-actions">
              <button type="button" onClick={routeGmaps}>経路をGoogle Mapsで開く</button>
              <Link href={`/articles/${route.shortId}`}>記事を見る</Link>
              <button type="button" onClick={() => setRoute(null)}>ルートを解除</button>
            </div>
          </div>
        )}

        <div className="pmap-list-head">
          <strong>{listView.title}</strong>
          <span className="pmap-count">{listView.items.length}か所</span>
          {route ? (
            <span className="pmap-sort">{listView.sortLabel}</span>
          ) : (
            <span className="pmap-sort-toggle" role="group" aria-label="並び順">
              <button type="button" aria-pressed={sort === "new"} onClick={() => setSort("new")}>新しい順</button>
              <button type="button" aria-pressed={sort === "near"} onClick={() => setSort("near")} title={listView.sortLabel ? `${listView.sortLabel}近い順` : undefined}>近い順</button>
            </span>
          )}
        </div>

        <ol className="pmap-list" ref={listRef}>
          {listView.empty && (
            <li className="pmap-empty">
              <h4>この範囲に聖地はありません</h4>
              {listView.empty.length ? (
                <>
                  いちばん近いのは:
                  <ul className="near">
                    {listView.empty.map(({ p, d }) => (
                      <li key={p.id}>
                        <button type="button" onClick={() => select(p.id, { fly: true })}>
                          <span style={{ color: MAP_KIND_COLORS[p.kind], display: "inline-flex", margin: 0 }}><KindIcon kind={p.kind} /></span>
                          <b>{p.name}</b>
                          <span>{fmtDist(d)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                "絞り込みを解除してみてください。"
              )}
            </li>
          )}
          {listView.items.map(({ p, d }, i) => {
            const sel = selected === p.id;
            const times = p.visits.length > 1 ? <span className="times">{p.visits.length}回 · </span> : null;
            const sub = p.description || (p.visits[0] ? `${fmtVisit(p.visits[0].date, p.visits[0].dateDisplay)} ${p.visits[0].title}` : p.address);
            const gmaps = user ? `https://www.google.com/maps/dir/?api=1&origin=${user.lat},${user.lng}&destination=${p.lat},${p.lng}` : p.gmaps;
            return (
              <li key={p.id} className={`pmap-item${sel ? " is-selected" : ""}${p.isNew ? " is-new" : ""}`} data-id={p.id}>
                <button className="pmap-item-main" type="button" aria-expanded={sel} onClick={() => select(sel ? null : p.id, { fly: !sel })}>
                  <span className="pmap-kind-ic" style={{ color: MAP_KIND_COLORS[p.kind] }}><KindIcon kind={p.kind} /></span>
                  <span className="pmap-item-text">
                    <span className="pmap-item-name">
                      {route && <span className="n">{i + 1}</span>}
                      {p.isNew && <span className="pmap-new">NEW</span>}
                      {p.name}
                    </span>
                    <span className="pmap-item-sub">{times}{sub}</span>
                  </span>
                  <span className="pmap-item-dist" title="登録日">
                    {showDist ? fmtDist(d) : !route ? `${fmtAdded(p.createdAt)} 追加` : ""}
                  </span>
                </button>
                {sel && (
                  <div className="pmap-item-detail">
                    {p.description && <p className="desc">{p.description}</p>}
                    {p.address && <p className="addr">{p.address}</p>}
                    <div className="pmap-tags">
                      <span>{fmtAdded(p.createdAt)} 追加</span>
                      <span>{PLACE_CLASSIFICATION_LABELS[p.classification]}</span>
                      {p.kind === "unset" ? <span className="warn">種類が未設定</span> : <span>{KIND_LABELS[p.kind]}</span>}
                      {p.areaUnset ? <span className="warn">エリアが未設定</span> : <span>{p.area}</span>}
                      <span>アセット {p.assetCount}</span>
                    </div>
                    {p.visits.length ? (
                      <ul className="pmap-visits">
                        {p.visits.map((v) => (
                          <li key={v.shortId}>
                            <span className="vd">{fmtVisit(v.date, v.dateDisplay)}</span>
                            <Link href={`/articles/${v.shortId}`}>{v.title || v.shortId}</Link>
                            {v.total > 1 && !route && (
                              <button type="button" className="route-link" onClick={() => setRoute(v.shortId)}>
                                この記事の{v.total}か所を順に見る
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="pmap-novisit">紐づいた記事はまだありません</p>
                    )}
                    <div className="pmap-actions">
                      <a className="pmap-btn primary" href={gmaps} target="_blank" rel="noopener noreferrer">
                        <PinIcon />
                        {user ? "ここへの経路" : "Google Mapsで開く"}
                      </a>
                      <Link className="pmap-btn" href={`/places/${p.id}`}>詳細・編集</Link>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      </aside>

      <div className="pmap-mapwrap">
        <div className="pmap-map" ref={mapElRef} />
        {hint && <div className={`pmap-hint${hint.hide ? " hide" : ""}`}>{hint.text}</div>}
      </div>
    </div>
  );
}
