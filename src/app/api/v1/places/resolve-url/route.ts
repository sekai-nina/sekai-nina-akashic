import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

const SHORT_HOSTS = new Set(["maps.app.goo.gl", "goo.gl", "g.co"]);

function extractLatLng(url: string): { lat: number; lng: number } | null {
  // Pattern: !3d{lat}!4d{lng} (Google Maps share URLs)
  const m1 = url.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m1) return { lat: parseFloat(m1[1]), lng: parseFloat(m1[2]) };
  // Pattern: @{lat},{lng}, (place URLs)
  const m2 = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m2) return { lat: parseFloat(m2[1]), lng: parseFloat(m2[2]) };
  // Pattern: ?q={lat},{lng}
  const m3 = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m3) return { lat: parseFloat(m3[1]), lng: parseFloat(m3[2]) };
  // Pattern: ?ll={lat},{lng}
  const m4 = url.match(/[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m4) return { lat: parseFloat(m4[1]), lng: parseFloat(m4[2]) };
  return null;
}

function extractName(url: string): string | null {
  // /place/{name}/@... — name is URL-encoded
  const m = url.match(/\/place\/([^/@]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]).replace(/\+/g, " ");
    } catch {
      return null;
    }
  }
  return null;
}

async function expandShortUrl(input: string): Promise<string> {
  let current = input;
  for (let i = 0; i < 5; i++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return current;
    }
    if (!SHORT_HOSTS.has(parsed.hostname)) return current;
    // Don't follow automatically — we want to capture the Location header
    const res = await fetch(current, { method: "GET", redirect: "manual" });
    const next = res.headers.get("location");
    if (!next) return current;
    current = next.startsWith("http") ? next : new URL(next, current).toString();
  }
  return current;
}

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

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return NextResponse.json({ error: "invalid url" }, { status: 400 });
  }

  // Try direct extraction first (works for full-form maps URLs)
  let coords = extractLatLng(raw);
  let expanded = raw;
  let name = extractName(raw);

  // If short URL or no coords found, follow redirects to get the canonical URL
  if (SHORT_HOSTS.has(parsed.hostname) || !coords) {
    try {
      expanded = await expandShortUrl(raw);
      if (!coords) coords = extractLatLng(expanded);
      if (!name) name = extractName(expanded);
    } catch {
      // ignore — return whatever we have
    }
  }

  if (!coords) {
    return NextResponse.json(
      { error: "could not extract coordinates from URL", expanded },
      { status: 422 }
    );
  }

  return NextResponse.json({
    lat: coords.lat,
    lng: coords.lng,
    name: name ?? "",
    googleMapsUrl: expanded,
  });
}
