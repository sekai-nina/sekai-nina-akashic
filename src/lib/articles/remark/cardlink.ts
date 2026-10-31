// sekai-nina-site の src/utils/remark-cardlink.ts からの移植。
// 公開サイトと同じ見た目を出すため、挙動を変えずにそのまま持ってきている。
// 元を直したらこちらも直すこと (共有パッケージ化は #44 で検討)。
// mdast にしか依存しないので Astro / Next.js のどちらでも動く。

import { visit } from 'unist-util-visit';
import type { Root, Code } from 'mdast';

/**
 * Remark plugin to convert Obsidian Auto Card Link syntax to bookmark cards.
 *
 * ```cardlink
 * url: https://example.com
 * title: "Page Title"
 * description: "説明 (聖地のカードでは住所)"
 * host: example.com
 * favicon: https://example.com/favicon.ico
 * image: https://example.com/og.png
 * ```
 *
 * 聖地の Google マップのカードは `image:` にお店の写真、`description:` に住所が入る。
 * 写真が取れなかったカードは `lat:` / `lng:` から、その地点にピンを立てた地図のサムネイルを画像の代わりに出す
 * (OpenStreetMap のタイルを並べるだけ。API キーは要らない)
 */
export function remarkCardLink() {
  return (tree: Root) => {
    visit(tree, 'code', (node: Code, index, parent) => {
      if (!parent || index === undefined) return;
      if (node.lang !== 'cardlink') return;

      const lines = node.value.split('\n');
      const data: Record<string, string> = {};

      for (const line of lines) {
        const match = line.match(/^(\w+):\s*"?(.+?)"?\s*$/);
        if (match) {
          data[match[1]] = match[2];
        }
      }

      if (!data.url) return;

      const title = data.title || data.url;
      const host = data.host || new URL(data.url).hostname;
      const favicon = data.favicon ? `<img src="${escapeAttr(data.favicon)}" alt="" class="cardlink-favicon" loading="lazy" />` : '';
      const map = data.image ? null : mapThumbHtml(data.lat, data.lng);
      const image = data.image
        ? `<div class="cardlink-image"><img src="${escapeAttr(data.image)}" alt="" loading="lazy" /></div>`
        : map ?? '';

      const html = `<a href="${escapeAttr(data.url)}" class="cardlink" target="_blank" rel="noopener noreferrer">
  ${image}
  <div class="cardlink-content">
    <div class="cardlink-title">${escapeHtml(title)}</div>
    ${data.description ? `<div class="cardlink-description">${escapeHtml(data.description)}</div>` : ''}
    <div class="cardlink-meta">${favicon}<span class="cardlink-host">${escapeHtml(host)}</span></div>
  </div>
</a>`;

      parent.children.splice(index, 1, { type: 'html', value: html });
    });
  };
}

/** 地図サムネイルの縮尺と枠の大きさ (CSS の .cardlink-map の幅・高さと揃える) */
const MAP_ZOOM = 16;
const MAP_W = 160;
const MAP_H = 100;
const TILE = 256;

/**
 * 地点を枠の中央に置くよう OSM のタイル (256px) を並べる。枠が 256px 以下なら縦横 2 枚まで。
 * タイルの位置は style の left / top だけ (akashic のサニタイズはこの形の style しか通さない)。
 * 座標が数でない・範囲外なら null (画像なしのカードになる)
 */
function mapThumbHtml(latText: string | undefined, lngText: string | undefined): string | null {
  const lat = Number(latText);
  const lng = Number(lngText);
  if (!latText || !lngText || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 85 || Math.abs(lng) > 180) return null;

  const world = TILE * 2 ** MAP_ZOOM;
  const rad = (lat * Math.PI) / 180;
  const px = ((lng + 180) / 360) * world;
  const py = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * world;
  const x0 = Math.round(px - MAP_W / 2);
  const y0 = Math.round(py - MAP_H / 2);
  const max = 2 ** MAP_ZOOM - 1;

  const tiles: string[] = [];
  for (let ty = Math.floor(y0 / TILE); ty <= Math.floor((y0 + MAP_H - 1) / TILE); ty++) {
    if (ty < 0 || ty > max) continue;
    for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + MAP_W - 1) / TILE); tx++) {
      const wx = ((tx % (max + 1)) + max + 1) % (max + 1);
      tiles.push(
        `<img src="https://tile.openstreetmap.org/${MAP_ZOOM}/${wx}/${ty}.png" alt="" class="cardlink-tile" loading="lazy" style="left:${tx * TILE - x0}px;top:${ty * TILE - y0}px" />`
      );
    }
  }
  return `<div class="cardlink-image cardlink-map">${tiles.join('')}<span class="cardlink-pin"></span><span class="cardlink-map-credit">© OpenStreetMap</span></div>`;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
