import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

type GooglePlace = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  googleMapsUri?: string;
};

type GooglePlacesResponse = {
  places?: GooglePlace[];
};

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Places API key not configured" }, { status: 503 });
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) {
    return NextResponse.json({ results: [] });
  }

  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri",
    },
    body: JSON.stringify({ textQuery: q, languageCode: "ja", regionCode: "JP" }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[places/search] Google API error", res.status, text);
    return NextResponse.json(
      { error: "Places API error", status: res.status, detail: text.slice(0, 500) },
      { status: 502 }
    );
  }

  const data = (await res.json()) as GooglePlacesResponse;
  const results = (data.places ?? [])
    .filter((p) => p.location?.latitude != null && p.location?.longitude != null)
    .map((p) => ({
      placeId: p.id ?? "",
      name: p.displayName?.text ?? "",
      address: p.formattedAddress ?? "",
      lat: p.location!.latitude!,
      lng: p.location!.longitude!,
      googleMapsUrl: p.googleMapsUri ?? "",
    }));

  return NextResponse.json({ results });
}
