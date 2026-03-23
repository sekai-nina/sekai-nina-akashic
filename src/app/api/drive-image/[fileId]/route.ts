import { auth } from "@/lib/auth";
import { google } from "googleapis";
import { NextResponse } from "next/server";

function getAuth() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (clientId && clientSecret && refreshToken) {
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return oauth2Client;
  }

  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (json) {
    try {
      const credentials = JSON.parse(json);
      return new google.auth.GoogleAuth({
        credentials,
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      });
    } catch {
      return null;
    }
  }
  return null;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ fileId: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { fileId } = await params;
  if (!fileId || fileId.includes("..")) {
    return NextResponse.json({ error: "Invalid fileId" }, { status: 400 });
  }

  const driveAuth = getAuth();
  if (!driveAuth) {
    return NextResponse.json({ error: "Drive not configured" }, { status: 500 });
  }

  try {
    const drive = google.drive({
      version: "v3",
      auth: driveAuth as Parameters<typeof google.drive>[0]["auth"],
    });

    const res = await drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "arraybuffer" }
    );

    // Get file metadata for content type
    const meta = await drive.files.get({
      fileId,
      fields: "mimeType",
      supportsAllDrives: true,
    });

    const buffer = Buffer.from(res.data as ArrayBuffer);
    const contentType = meta.data.mimeType || "application/octet-stream";

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (err: unknown) {
    console.error("Drive image proxy error:", err);
    const detail =
      err instanceof Error ? err.message : String(err);
    // GAxios errors have response.status and response.data
    const gaxiosStatus =
      (err as { response?: { status?: number } })?.response?.status;
    return NextResponse.json(
      {
        error: "Failed to fetch file",
        detail,
        ...(gaxiosStatus ? { driveStatus: gaxiosStatus } : {}),
      },
      { status: 500 }
    );
  }
}
