import sharp from "sharp";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OCR_MODEL, OcrError, ocrImageWithClaude } from "./claude";

/** Messages API の返答を作る。SDK は globalThis.fetch を使うので、そこを差し替える */
function apiResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "retry-after-ms": "0", ...headers },
  });
}

function message(text: string, stop_reason = "end_turn") {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: OCR_MODEL,
    content: [{ type: "text", text }],
    stop_reason,
    usage: { input_tokens: 4800, output_tokens: 900, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

let image: Buffer;
let fetchMock: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  // 長辺 3000px の画像。送る前に 2576px へ縮められるか見る
  image = await sharp({ create: { width: 2000, height: 3000, channels: 3, background: "#fff" } }).png().toBuffer();
});

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function sentBody(): Promise<Record<string, unknown>> {
  const [, init] = fetchMock.mock.calls[0];
  return JSON.parse(init.body as string);
}

describe("ocrImageWithClaude", () => {
  it("書き起こした文字と利用量を返し、画像は長辺 2576px の JPEG にして送る", async () => {
    fetchMock.mockResolvedValue(apiResponse(message("坂井新奈\n撮影＝山田")));
    const res = await ocrImageWithClaude(image);
    expect(res.text).toBe("坂井新奈\n撮影＝山田");
    expect(res.usage).toEqual({ inputTokens: 4800, cachedInputTokens: 0, outputTokens: 900 });

    const body = await sentBody();
    expect(body.model).toBe(OCR_MODEL);
    expect(body.fallbacks).toBe("default");
    const content = (body.messages as { content: { type: string; source?: { media_type: string; data: string } }[] }[])[0].content;
    const img = content.find((c) => c.type === "image")!;
    expect(img.source!.media_type).toBe("image/jpeg");
    const meta = await sharp(Buffer.from(img.source!.data, "base64")).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(2576);
  });

  it("文字が無い画像 (NO_TEXT) は空文字にする", async () => {
    fetchMock.mockResolvedValue(apiResponse(message("NO_TEXT")));
    expect((await ocrImageWithClaude(image)).text).toBe("");
  });

  it("断られたらやり直さない失敗にする", async () => {
    fetchMock.mockResolvedValue(apiResponse(message("", "refusal")));
    const err = await ocrImageWithClaude(image).catch((e) => e);
    expect(err).toBeInstanceOf(OcrError);
    expect(err.permanent).toBe(true);
  });

  it("レート制限は一時的な失敗で、その回を打ち切る", async () => {
    fetchMock.mockImplementation(async () =>
      apiResponse({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, 429),
    );
    const err = await ocrImageWithClaude(image).catch((e) => e);
    expect(err).toBeInstanceOf(OcrError);
    expect(err.permanent).toBe(false);
    expect(err.stopBatch).toBe(true);
  });

  it("画像として読めないものは送らずにやり直さない失敗にする", async () => {
    const err = await ocrImageWithClaude(Buffer.from("not an image")).catch((e) => e);
    expect(err).toBeInstanceOf(OcrError);
    expect(err.permanent).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("キーが無ければ送らない", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    const err = await ocrImageWithClaude(image).catch((e) => e);
    expect(err).toBeInstanceOf(OcrError);
    expect(err.stopBatch).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
