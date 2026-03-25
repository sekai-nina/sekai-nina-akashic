import { google } from "googleapis";
import { Readable } from "stream";

interface DriveUploadResult {
  fileId: string;
  webViewLink: string;
  directUrl: string;
}

function getAuth() {
  // OAuth2 方式（個人ドライブ向け）
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (clientId && clientSecret && refreshToken) {
    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    return oauth2Client;
  }

  // サービスアカウント方式（共有ドライブ向け、フォールバック）
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (json) {
    try {
      const credentials = JSON.parse(json);
      return new google.auth.GoogleAuth({
        credentials,
        scopes: ["https://www.googleapis.com/auth/drive.file"],
      });
    } catch {
      console.error("Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON");
    }
  }

  return null;
}

export function isDriveEnabled(): boolean {
  const hasOAuth = !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REFRESH_TOKEN &&
    process.env.GOOGLE_DRIVE_FOLDER_ID
  );
  const hasServiceAccount = !!(
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON &&
    process.env.GOOGLE_DRIVE_FOLDER_ID
  );
  return hasOAuth || hasServiceAccount;
}

/**
 * テキストコンテンツを .txt ファイルとしてDriveにバックアップする。
 * レスポンスをブロックしないよう、呼び出し側で .catch() して使う想定。
 */
export async function backupTextToDrive(
  assetId: string,
  textType: string,
  content: string
): Promise<DriveUploadResult | null> {
  if (!isDriveEnabled()) return null;
  const filename = `${assetId}_${textType}_${Date.now()}.txt`;
  const buffer = Buffer.from(content, "utf-8");
  return uploadToDrive(buffer, filename, "text/plain");
}

/**
 * 指定フォルダ内にサブフォルダを作成（または既存を返す）する。
 */
export async function getOrCreateDriveFolder(
  parentFolderId: string,
  folderName: string
): Promise<string | null> {
  const auth = getAuth();
  if (!auth) return null;

  const drive = google.drive({ version: "v3", auth: auth as Parameters<typeof google.drive>[0]["auth"] });

  // 既存フォルダを検索
  const query = `name='${folderName}' and '${parentFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const list = await drive.files.list({
    q: query,
    fields: "files(id)",
    supportsAllDrives: true,
  });

  if (list.data.files && list.data.files.length > 0) {
    return list.data.files[0].id!;
  }

  // 作成
  const res = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentFolderId],
    },
    fields: "id",
    supportsAllDrives: true,
  });

  return res.data.id ?? null;
}

/**
 * 指定フォルダ内のファイル一覧を取得する。
 */
export async function listDriveFiles(
  folderId: string
): Promise<Array<{ id: string; name: string }>> {
  const auth = getAuth();
  if (!auth) return [];

  const drive = google.drive({ version: "v3", auth: auth as Parameters<typeof google.drive>[0]["auth"] });
  const files: Array<{ id: string; name: string }> = [];
  let pageToken: string | undefined;

  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken, files(id, name)",
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
    });
    for (const f of res.data.files ?? []) {
      if (f.id && f.name) files.push({ id: f.id, name: f.name });
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return files;
}

/**
 * Driveからファイルのバイナリをダウンロードする。
 */
export async function downloadFromDrive(fileId: string): Promise<Buffer | null> {
  const auth = getAuth();
  if (!auth) return null;

  const drive = google.drive({ version: "v3", auth: auth as Parameters<typeof google.drive>[0]["auth"] });
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data as ArrayBuffer);
}

/**
 * 指定フォルダにファイルをアップロードする（フォルダID指定版）。
 */
export async function uploadToFolder(
  folderId: string,
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<DriveUploadResult | null> {
  const auth = getAuth();
  if (!auth) return null;

  const drive = google.drive({ version: "v3", auth: auth as Parameters<typeof google.drive>[0]["auth"] });

  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);

  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [folderId],
    },
    media: { mimeType, body: stream },
    fields: "id, webViewLink",
    supportsAllDrives: true,
  });

  if (!res.data.id) return null;

  return {
    fileId: res.data.id,
    webViewLink: res.data.webViewLink || `https://drive.google.com/file/d/${res.data.id}/view`,
    directUrl: `https://drive.google.com/uc?export=view&id=${res.data.id}`,
  };
}

export async function uploadToDrive(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<DriveUploadResult | null> {
  const auth = getAuth();
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!auth || !folderId) return null;

  const drive = google.drive({ version: "v3", auth: auth as Parameters<typeof google.drive>[0]["auth"] });

  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);

  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: stream,
    },
    fields: "id, webViewLink",
    supportsAllDrives: true,
  });

  if (!res.data.id) return null;

  // Make it accessible via link
  try {
    await drive.permissions.create({
      fileId: res.data.id,
      requestBody: {
        role: "reader",
        type: "anyone",
      },
      supportsAllDrives: true,
    });
  } catch (err) {
    console.warn("Could not set public permission:", err);
  }

  const fileId = res.data.id;
  return {
    fileId,
    webViewLink: res.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`,
    directUrl: `https://drive.google.com/uc?export=view&id=${fileId}`,
  };
}
