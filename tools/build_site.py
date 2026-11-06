#!/usr/bin/env python3
"""Assemble the GitHub Pages site: launcher + latest Fluidd and Mainsail builds patched to run over serial-klipper.

    python tools/build_site.py --out _site --base /serial-klipper
    python tools/build_site.py --fluidd fluidd.zip --mainsail mainsail.zip   # offline
"""
import argparse
import io
import re
import shutil
import sys
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
URLS = {
    "fluidd": "https://github.com/fluidd-core/fluidd/releases/latest/download/fluidd.zip",
    "mainsail": "https://github.com/mainsail-crew/mainsail/releases/latest/download/mainsail.zip",
}
# Mainsail is built for a root-relative deployment; point its absolute resource paths into its subfolder.
ABS = re.compile(r"""(["'`(=])/(assets|img|fonts|css|favicon\.ico|manifest\.webmanifest|config\.json|release_info\.json)""")


def fetch(app, src):
    if src:
        return Path(src).read_bytes()
    print(f"downloading {app} ...", file=sys.stderr)
    with urllib.request.urlopen(URLS[app], timeout=120) as r:
        return r.read()


def install(app, data, out, base):
    dest = out / app
    zipfile.ZipFile(io.BytesIO(data)).extractall(dest)
    for stale in ("sw.js", "workbox-71725de1.js"):
        (dest / stale).unlink(missing_ok=True)
    for f in dest.glob("workbox-*.js"):
        f.unlink()
    html = dest / "index.html"
    text = html.read_text(encoding="utf8")
    text = re.sub(r"(<head[^>]*>)", r"\1" + f'<script src="{base}/shim.js"></script>', text, count=1)
    if app == "mainsail":
        text = re.sub(r"(<head[^>]*>)", r"\1<script>history.replaceState(null,'','/')</script>", text, count=1)
        text = ABS.sub(rf"\1{base}/mainsail/\2", text)
        for f in dest.rglob("*"):
            if f.suffix in (".js", ".css") and f.is_file():
                body = f.read_text(encoding="utf8")
                new = ABS.sub(rf"\1{base}/mainsail/\2", body)
                if new != body:
                    f.write_text(new, encoding="utf8")
    html.write_text(text, encoding="utf8")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="_site")
    ap.add_argument("--base", default="/serial-klipper", help="URL path the site is served under ('' for a root deployment)")
    ap.add_argument("--fluidd", help="local fluidd.zip instead of downloading")
    ap.add_argument("--mainsail", help="local mainsail.zip instead of downloading")
    a = ap.parse_args()
    base = a.base.rstrip("/")
    out = Path(a.out)
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(ROOT / "web", out)
    (out / ".nojekyll").write_text("")
    for app, src in (("fluidd", a.fluidd), ("mainsail", a.mainsail)):
        install(app, fetch(app, src), out, base)
    print(f"site written to {out}")


if __name__ == "__main__":
    main()
