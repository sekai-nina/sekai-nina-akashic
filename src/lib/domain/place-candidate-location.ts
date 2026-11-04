interface CandidateLocationInput {
  placeId: string | null;
  name: string;
  latitude: number | null;
  longitude: number | null;
  address: string | null;
  googleMapsUrl: string | null;
  /** 指している聖地。RLS で見えなければ null */
  place: {
    latitude: number;
    longitude: number;
    address: string | null;
    googleMapsUrl: string | null;
    entity: { canonicalName: string };
  } | null;
}

/**
 * 場所候補の名前と場所。候補の行に無い値は聖地から補う (アセットから入れた候補は聖地を指すだけ)。
 * 座標は緯度と経度を組で扱う (別々に補うと別の地点になる)。
 *
 * **聖地が見えない候補は何も返さない。** 手入力から昇格した候補は行に名前・座標が残っているので、
 * あとで聖地を上位機密にすると、そのままでは下のクリアランスの人に見えてしまう
 */
export function resolveCandidateLocation(c: CandidateLocationInput) {
  if (c.placeId && !c.place) {
    return { name: "", latitude: null, longitude: null, address: null, googleMapsUrl: null };
  }
  const own = c.latitude != null && c.longitude != null;
  return {
    name: c.place?.entity.canonicalName || c.name,
    latitude: own ? c.latitude : (c.place?.latitude ?? null),
    longitude: own ? c.longitude : (c.place?.longitude ?? null),
    address: c.address ?? c.place?.address ?? null,
    googleMapsUrl: c.googleMapsUrl ?? c.place?.googleMapsUrl ?? null,
  };
}
