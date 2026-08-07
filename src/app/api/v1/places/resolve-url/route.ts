import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { resolveGoogleMapsUrl } from "@/lib/places/resolve-google-maps-url";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  const url = new URL(request.url);
  const raw = (url.searchParams.get("url") ?? "").trim();
  if (!raw) {
    return NextResponse.json({ error: "url required" }, { status: 400 });
  }

  const resolved = await resolveGoogleMapsUrl(raw);

  if (!resolved.ok) {
    if (resolved.error === "invalid_url") {
      return NextResponse.json({ error: "invalid url" }, { status: 400 });
    }
    if (resolved.error === "unsupported_host") {
      return NextResponse.json(
        { error: "unsupported url (Google Maps の URL のみ対応しています)", expanded: resolved.expanded },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "could not extract coordinates from URL", expanded: resolved.expanded },
      { status: 422 }
    );
  }

  return NextResponse.json({
    lat: resolved.lat,
    lng: resolved.lng,
    name: resolved.name,
    googleMapsUrl: resolved.googleMapsUrl,
  });
}
