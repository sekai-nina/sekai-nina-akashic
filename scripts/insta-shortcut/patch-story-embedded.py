"""「Instagram Download (urls)」の story 取得を、API から埋め込み JSON に切り替える (2026-10-24)。

    python3 scripts/insta-shortcut/unsign.py "Instagram Download (urls).shortcut" in.wflow
    python3 scripts/insta-shortcut/patch-story-embedded.py in.wflow patched.wflow
    mkdir -p work && cp patched.wflow "work/Instagram Download (urls).shortcut"  # 拡張子 .shortcut でないと sign が通らない
    shortcuts sign --mode anyone --input "work/Instagram Download (urls).shortcut" --output signed.shortcut

経緯と中身は docs/ipad-instagram-worker.md の「story は埋め込み JSON から取る」。
Instagram Download v6.5 + #199 の改変版の本文に合わせた置換なので、元が変わると assert で止まる。
worker キーは plist 内の media-urls POST から読むので、このファイルは秘密を持たない。
"""

import plistlib, sys

SRC, OUT = sys.argv[1], sys.argv[2]
OBJ = "￼"
p = plistlib.load(open(SRC, "rb"))
A = p["WFWorkflowActions"]

def u16(s):
    return len(s.encode("utf-16-le")) // 2

def edit_token_string(value, fn):
    """attachmentsByRange 付きの文字列を編集する。￼ の順番は変えない前提で位置を振り直す"""
    s = value["string"]
    atts = value.get("attachmentsByRange", {})
    def key_off(k):
        return int(k.strip("{}").split(",")[0])
    ordered = [atts[k] for k in sorted(atts, key=key_off)]
    # 元の ￼ の位置が attachments と 1:1 か確かめる
    offs, o = [], 0
    for ch in s:
        if ch == OBJ:
            offs.append(o)
        o += u16(ch)
    assert offs == sorted(key_off(k) for k in atts), (offs, sorted(key_off(k) for k in atts))
    ns = fn(s)
    assert ns.count(OBJ) == s.count(OBJ), "￼ の数が変わった"
    new_atts, o = {}, 0
    i = 0
    for ch in ns:
        if ch == OBJ:
            new_atts["{%d, 1}" % o] = ordered[i]
            i += 1
        o += u16(ch)
    value["string"] = ns
    value["attachmentsByRange"] = new_atts

def replace_once(s, old, new):
    assert s.count(old) == 1, ("not unique", old[:80], s.count(old))
    return s.replace(old, new)

# 内側の POST に埋め込まれている worker キーを流用する (新しい秘密は増やさない)
auth = None
for a in A:
    pr = a["WFWorkflowActionParameters"]
    if pr.get("WFURL") == "https://akashic.sekai-nina.com/api/v1/insta/media-urls":
        for it in pr["WFHTTPHeaders"]["Value"]["WFDictionaryFieldValueItems"]:
            if it["WFKey"]["Value"]["string"] == "Authorization":
                auth = it["WFValue"]["Value"]["string"]
        break
assert auth and auth.startswith("Bearer ak_")

# --- 1. 自動経路の Scriptable (story ページを WebView で開く RunScriptInline) ---
MAIN = next(
    i for i, a in enumerate(A)
    if a["WFWorkflowActionIdentifier"] == "dk.simonbs.Scriptable.RunScriptInlineIntent"
    and "Timer.schedule(500" in str(a["WFWorkflowActionParameters"].get("script"))
)

def fix38(s):
    # UA を Chrome に偽装すると API が HTML を返す (2026-10-21 実測)。WebView 本来の UA に任せる
    s = replace_once(s, ",\n\t\t'user-agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36'}", "}")
    # story のデータはページの埋め込み JSON から取る (API は 500 / 400 spam。2026-10-21 実測)
    s = replace_once(s,
        "\t\tlogin: /\"appScopedIdentity\":\"\\\\d+/.test(document.documentElement.innerHTML)\n\t})`);",
        "\t\tlogin: /\"appScopedIdentity\":\"\\\\d+/.test(document.documentElement.innerHTML),\n"
        "\t\treel: (() => {\n"
        "\t\t\tfor (const s of document.querySelectorAll('script[type=\"application/json\"]')) {\n"
        "\t\t\t\tconst t = s.textContent;\n"
        "\t\t\t\tif (!t.includes('xdt_api__v1__feed__reels_media')) continue;\n"
        "\t\t\t\tlet found = null;\n"
        "\t\t\t\tconst walk = (o, d) => {\n"
        "\t\t\t\t\tif (found || !o || typeof o !== 'object' || d > 40) return;\n"
        "\t\t\t\t\tif (o.xdt_api__v1__feed__reels_media) { found = o.xdt_api__v1__feed__reels_media.reels_media?.[0] || null; return; }\n"
        "\t\t\t\t\tfor (const k in o) walk(o[k], d + 1);\n"
        "\t\t\t\t};\n"
        "\t\t\t\ttry { walk(JSON.parse(t), 0); } catch {}\n"
        "\t\t\t\tif (found) return found;\n"
        "\t\t\t}\n"
        "\t\t\treturn null;\n"
        "\t\t})()\n"
        "\t})`);")
    # 例外で黙って止まらないようにする: 失敗をサーバに残し、ショートカットを抜けさせる
    s = replace_once(s, "Timer.schedule(500, false, async () => {\n\tlet p = await webView",
        "Timer.schedule(500, false, async () => {\n\ttry {\n\tlet p = await webView")
    s = replace_once(s, "\t\tPasteboard.copy(JSON.stringify({...o1, ...o2}));\n" + OBJ + "\n\t}\n});\nwebView.present(true);",
        "\t\tPasteboard.copy(JSON.stringify({...o1, ...o2}));\n" + OBJ + "\n\t}\n"
        "\t} catch (e) {\n"
        "\t\t// Akashic: ここで止まると WebView が開いたままになり、後続のジョブも受け取れなくなる\n"
        "\t\ttry {\n"
        "\t\t\tlet rq = new Request('https://akashic.sekai-nina.com/api/v1/insta/media-urls');\n"
        "\t\t\trq.method = 'POST';\n"
        "\t\t\trq.headers = {'Authorization': '" + auth + "', 'Content-Type': 'application/json'};\n"
        "\t\t\trq.body = JSON.stringify({text: 'scriptable error: ' + String(e && e.stack || e).slice(0, 1000), mark: 'scriptable-error'});\n"
        "\t\t\trq.timeoutInterval = 15;\n"
        "\t\t\tawait rq.loadString();\n"
        "\t\t} catch {}\n"
        "\t\t// profile 扱いにするとショートカット側はそのまま exit する\n"
        "\t\tPasteboard.copy('{\"profile\":1}');\n"
        "\t\tScript.complete();\n"
        "\t}\n"
        "});\nwebView.present(true);")
    return s

edit_token_string(A[MAIN]["WFWorkflowActionParameters"]["script"]["Value"], fix38)

# --- 2. igCheck (gettext の本文): stories は埋め込みデータを優先 ---
ig = [a for a in A if a["WFWorkflowActionParameters"].get("UUID") == "66E961D1-296A-496B-A65A-FD0FE0F7DF31"][0]
def fixig(s):
    return replace_once(s,
        "\t\t\tuid = dict.uid;\n\t\t\tr = new Request('https://www.instagram.com/api/v1/feed/reels_media/?media_id=' + mediaid + '&reel_ids=' + uid);\n\t\t\tr.headers = headers;\n\t\t\ttry {\n\t\t\t\tp = await r.loadJSON();\n\t\t\t\tj = p.reels_media?.[0] || p.reels?.[uid] || p.reel;\n\t\t\t\tj.user.username;\n\t\t\t} catch {\n\t\t\t\tr = new Request('https://www.instagram.com/api/v1/feed/user/' + uid + '/story/');\n\t\t\t\tr.headers = headers;\n\t\t\t\tp = await r.loadJSON();\n\t\t\t\tj = p.reel || p.reels_media?.[0] || p.reels?.[uid];\n\t\t\t}\n",
        "\t\t\tuid = dict.uid;\n"
        "\t\t\tif (dict.reel && String(dict.reel.id) === String(uid) && dict.reel.items?.length) {\n"
        "\t\t\t\t// Akashic: ページに埋め込まれた story のデータを使う (API は 2026-10 から弾かれる)\n"
        "\t\t\t\tj = dict.reel;\n"
        "\t\t\t\tp = {};\n"
        "\t\t\t\tj.items.forEach(a => {\n"
        "\t\t\t\t\tif (a.media_type == null) a.media_type = a.video_versions?.length ? 2 : 1;\n"
        "\t\t\t\t\t(a.image_versions2?.candidates || []).forEach(c => { c.width = c.width || 0; c.height = c.height || 0; });\n"
        "\t\t\t\t\t(a.video_versions || []).forEach(c => { c.width = c.width || 0; c.height = c.height || 0; });\n"
        "\t\t\t\t});\n"
        "\t\t\t} else {\n"
        "\t\t\tr = new Request('https://www.instagram.com/api/v1/feed/reels_media/?media_id=' + mediaid + '&reel_ids=' + uid);\n\t\t\tr.headers = headers;\n\t\t\ttry {\n\t\t\t\tp = await r.loadJSON();\n\t\t\t\tj = p.reels_media?.[0] || p.reels?.[uid] || p.reel;\n\t\t\t\tj.user.username;\n\t\t\t} catch {\n\t\t\t\tr = new Request('https://www.instagram.com/api/v1/feed/user/' + uid + '/story/');\n\t\t\t\tr.headers = headers;\n\t\t\t\tp = await r.loadJSON();\n\t\t\t\tj = p.reel || p.reels_media?.[0] || p.reels?.[uid];\n\t\t\t}\n"
        "\t\t\t}\n")
t = ig["WFWorkflowActionParameters"]["WFTextActionText"]
if isinstance(t, dict):
    edit_token_string(t["Value"], fixig)
else:
    ig["WFWorkflowActionParameters"]["WFTextActionText"] = fixig(t)

plistlib.dump(p, open(OUT, "wb"), fmt=plistlib.FMT_BINARY)
print("ok")
