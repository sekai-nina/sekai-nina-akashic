"""署名済みの .shortcut (AEA1) から中身の plist を取り出す。

    python3 scripts/insta-shortcut/unsign.py "Instagram Download (urls).shortcut" out.wflow

`shortcuts sign --mode anyone` の出力は Apple Encrypted Archive。ヘッダの plist にある
`SigningCertificateChain[0]` の公開鍵で `aea decrypt -sign-pub` すると Apple Archive が出てきて、
その中の `Shortcut.wflow` が編集できる bplist。macOS の `aea` / `aa` / `openssl` を使う。
"""

import plistlib
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

src, out = Path(sys.argv[1]), Path(sys.argv[2])
data = src.read_bytes()
if data[:4] != b"AEA1":
    sys.exit("AEA1 ではありません (未署名の .shortcut ならそのまま plist として読める)")
size = struct.unpack("<I", data[8:12])[0]
header = plistlib.loads(data[12 : 12 + size])

with tempfile.TemporaryDirectory() as tmp:
    t = Path(tmp)
    (t / "cert.der").write_bytes(header["SigningCertificateChain"][0])
    pub = subprocess.run(
        ["openssl", "x509", "-inform", "der", "-in", str(t / "cert.der"), "-pubkey", "-noout"],
        check=True, capture_output=True,
    ).stdout
    (t / "pub.pem").write_bytes(pub)
    subprocess.run(["aea", "decrypt", "-i", str(src), "-o", str(t / "out.aar"), "-sign-pub", str(t / "pub.pem")], check=True)
    (t / "x").mkdir()
    subprocess.run(["aa", "extract", "-i", str(t / "out.aar"), "-d", str(t / "x")], check=True)
    shutil.copy(t / "x" / "Shortcut.wflow", out)
print(f"{out} に書き出しました")
