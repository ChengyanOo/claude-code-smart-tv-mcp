#!/usr/bin/env python3
"""Refresh the YouTube cookie header from a logged-in browser profile.

Uses yt-dlp's cookie extractors (Firefox sqlite, Chrome/Brave/Chromium keyring
decryption, ...). Writes a single `Cookie:` header line to
$TV_AGENT_DIR/cookie.txt (default ~/.config/tv-agent/cookie.txt), mode 0600.

Env:
  YT_BROWSER   comma separated browsers to try in order (default: "firefox,chrome").
               Accepts yt-dlp syntax, e.g. "chrome:Profile 2" or "firefox:default-release"
               (profile names may contain spaces, hence comma separation).
  TV_AGENT_DIR override the data dir.
  YT_DLP       path to a yt-dlp zipapp/binary to import from (default: ~/.local/bin/yt-dlp).
  YT_COOKIE_MAX_AGE_H  skip the refresh when cookie.txt is younger than this (default 12; 0 = always).

Usage:
  yt-cookie.py          refresh cookie.txt (no-op while it is fresh, see YT_COOKIE_MAX_AGE_H)
  yt-cookie.py --force  refresh even if fresh (the server calls this when YouTube rejects the cookie)
  yt-cookie.py --list   show browser profiles found on this machine with the account
                        name Chrome/Firefox stores for them, so you can pick YT_BROWSER

Never prints cookie values; only counts and the browser that worked.
Exit 0 on success, 1 when no browser yielded a signed-in YouTube session.
"""
import os
import re
import sys
import tempfile
import time
from pathlib import Path

# yt-dlp may be installed as a module or as the single-file zipapp; both import.
_zip = Path(os.environ.get("YT_DLP", Path.home() / ".local/bin/yt-dlp"))
if _zip.is_file():
    sys.path.insert(0, str(_zip))
try:
    from yt_dlp.cookies import extract_cookies_from_browser
except ImportError:
    print("yt-cookie: yt-dlp not found. Install: curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o ~/.local/bin/yt-dlp && chmod +x ~/.local/bin/yt-dlp", file=sys.stderr)
    sys.exit(1)

DATA_DIR = Path(os.environ.get("TV_AGENT_DIR", Path.home() / ".config/tv-agent"))
OUT = DATA_DIR / "cookie.txt"
BROWSERS = [b.strip() for b in re.split(r"[,;]", os.environ.get("YT_BROWSER", "firefox,chrome")) if b.strip()]
# Cookies youtubei.js needs for an authenticated Innertube session.
REQUIRED = {"SAPISID", "SID", "HSID", "SSID", "APISID"}
DOMAINS = (".youtube.com", "youtube.com")
MAX_AGE_S = float(os.environ.get("YT_COOKIE_MAX_AGE_H", "12")) * 3600


class _Quiet:
    """Silence yt-dlp's cookie logger unless debugging (YT_COOKIE_DEBUG=1)."""
    debug_on = os.environ.get("YT_COOKIE_DEBUG") == "1"

    def debug(self, m):
        if self.debug_on: print(m, file=sys.stderr)
    info = debug

    def warning(self, m, *a, **k):
        print(f"yt-cookie: {m}", file=sys.stderr)
    error = warning


def parse_spec(spec: str):
    """'chrome:Profile 1' -> ('chrome', 'Profile 1'); 'firefox' -> ('firefox', None)."""
    name, _, profile = spec.partition(":")
    return name.lower(), (profile or None)


def youtube_cookies(spec: str):
    name, profile = parse_spec(spec)
    jar = extract_cookies_from_browser(name, profile=profile, logger=_Quiet())
    seen = {}
    for c in jar:
        if c.domain in DOMAINS and c.value is not None:
            seen[c.name] = c.value  # later (more specific) wins; fine for our purpose
    return seen


CHROMIUM_DIRS = {
    "chrome": ".config/google-chrome", "chromium": ".config/chromium", "brave": ".config/BraveSoftware/Brave-Browser",
    "edge": ".config/microsoft-edge", "vivaldi": ".config/vivaldi", "opera": ".config/opera",
}


def list_profiles() -> int:
    """Print `browser:profile` specs with the display name / email the browser stores (no cookies read)."""
    import configparser
    import json
    home = Path.home()
    found = False
    for browser, rel in CHROMIUM_DIRS.items():
        state = home / rel / "Local State"
        if not state.is_file():
            continue
        try:
            info = json.loads(state.read_text()).get("profile", {}).get("info_cache", {})
        except (OSError, ValueError):
            continue
        for d, meta in sorted(info.items()):
            found = True
            who = meta.get("user_name") or meta.get("gaia_name") or "(not signed into browser)"
            print(f'YT_BROWSER="{browser}:{d}"   {meta.get("name", "")}  {who}')
    ini = home / ".mozilla/firefox/profiles.ini"
    if ini.is_file():
        cp = configparser.ConfigParser(); cp.read(ini)
        for sec in cp.sections():
            if cp.has_option(sec, "Path"):
                found = True
                print(f'YT_BROWSER="firefox:{cp.get(sec, "Name")}"   (default={cp.get(sec, "Default", fallback="0")})')
    if not found:
        print("no browser profiles found", file=sys.stderr)
    print("\nBrowser sign-in != YouTube sign-in: run without --list to test which profile has a YouTube session.", file=sys.stderr)
    return 0


def main() -> int:
    if "--list" in sys.argv[1:]:
        return list_profiles()
    if "--force" not in sys.argv[1:] and MAX_AGE_S > 0 and OUT.is_file():
        age = time.time() - OUT.stat().st_mtime
        if age < MAX_AGE_S and "SAPISID=" in OUT.read_text():
            print(f"yt-cookie: {OUT} is {age / 3600:.1f}h old, keeping it (--force to refresh)", file=sys.stderr)
            return 0
    for spec in BROWSERS:
        try:
            cookies = youtube_cookies(spec)
        except Exception as e:  # locked db, missing profile, keyring unavailable, ...
            print(f"yt-cookie: {spec}: {type(e).__name__}: {e}", file=sys.stderr)
            continue
        missing = REQUIRED - cookies.keys()
        if missing:
            print(f"yt-cookie: {spec}: found {len(cookies)} youtube cookies but not signed in (missing {', '.join(sorted(missing))})", file=sys.stderr)
            continue
        header = "; ".join(f"{k}={v}" for k, v in cookies.items())
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        os.chmod(DATA_DIR, 0o700)
        # Atomic replace so the server never reads a half-written file.
        fd, tmp = tempfile.mkstemp(dir=DATA_DIR, prefix=".cookie-", suffix=".tmp")
        with os.fdopen(fd, "w") as f:
            f.write(header + "\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, OUT)
        print(f"yt-cookie: {spec}: wrote {len(cookies)} youtube cookies to {OUT}", file=sys.stderr)
        return 0
    print(f"yt-cookie: no signed-in YouTube session in: {' '.join(BROWSERS)}. Log into youtube.com in that browser, or set YT_BROWSER.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
