import L from "leaflet";

// leaflet.markercluster は読み込まれた時点のグローバル L を拡張する。import の評価順で leaflet → これ → markercluster になるように置く
(globalThis as unknown as { L: typeof L }).L = L;
