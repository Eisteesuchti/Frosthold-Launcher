"""
FrostMP Launcher - Testlauncher fuer den Frosthold Skyrim Multiplayer Server.
Erkennt die Skyrim SE Installation ueber Steam, prueft ob SKSE, Skyrim Platform
und der FrostMP-Client installiert sind, laedt fehlende Komponenten herunter,
schreibt die Verbindungsdaten und startet SKSE.
"""

import json
import os
import re
import sys
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
import urllib.request
import urllib.error
import zipfile
import shutil
import tempfile
import threading

# ============================================================================
# Configuration - adjust these URLs/versions as needed
# ============================================================================

SKSE_VERSION = "2_02_06"
SKSE_URL = f"https://skse.silverlock.org/beta/skse64_{SKSE_VERSION}.7z"
SKSE_FOLDER_IN_ARCHIVE = f"skse64_{SKSE_VERSION}"

# URL to a .zip of the built client distribution (build/dist/client contents).
# This should be hosted by you (e.g. GitHub Release artifact).
# Optional: HTTPS-URL zur Client-ZIP, oder Umgebungsvariable FROSTHOLD_CLIENT_DIST_URL,
# oder eine Zeile in der Datei "frosthold-client-dist.url" neben diesem Skript.
DEFAULT_CLIENT_DIST_URL = os.environ.get("FROSTHOLD_CLIENT_DIST_URL", "").strip()

DEFAULT_PORT = 7777
DEFAULT_SERVER_IP = "188.245.77.170"

# Marker files for each component (paths relative to Skyrim root)
SKSE_MARKERS = ["skse64_loader.exe"]
SP_MARKERS = [
    "Data/SKSE/Plugins/SkyrimPlatform.dll",
    "Data/SKSE/Plugins/MpClientPlugin.dll",
    "Data/Platform/Distribution/RuntimeDependencies/SkyrimPlatformImpl.dll",
]
CLIENT_MARKERS = [
    "Data/Platform/Plugins/frostmp-client.js",
]
# Legacy-Bundle-Name, der frueher (vor dem FrostMP-Branding) verwendet wurde.
# Der Launcher entfernt ihn beim Update, damit keine zwei Plugins nebeneinander liegen.
LEGACY_CLIENT_PLUGIN = "Data/Platform/Plugins/skymp5-client.js"
LEGACY_CLIENT_SETTINGS = "Data/Platform/Plugins/skymp5-client-settings.txt"

# Address Library for CommonLibSSE-NG / SKSE plugins (filename varies with game patch).
# We accept any versionlib-*.bin under Data/SKSE/Plugins (checked separately).
ADDRESS_LIB_GLOB = "versionlib-*.bin"


def has_address_library(skyrim_dir: Path) -> bool:
    plug = skyrim_dir / "Data" / "SKSE" / "Plugins"
    if not plug.is_dir():
        return False
    for p in plug.glob("versionlib-*.bin"):
        if p.is_file():
            return True
    return False

# ============================================================================
# Steam / Skyrim detection
# ============================================================================

def find_steam_path() -> Optional[Path]:
    try:
        import winreg
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            for sub in (r"SOFTWARE\Valve\Steam", r"SOFTWARE\WOW6432Node\Valve\Steam"):
                try:
                    key = winreg.OpenKey(hive, sub)
                    val, _ = winreg.QueryValueEx(key, "InstallPath")
                    winreg.CloseKey(key)
                    p = Path(val)
                    if p.exists():
                        return p
                except FileNotFoundError:
                    continue
    except ImportError:
        pass
    for candidate in [
        Path(os.environ.get("ProgramFiles(x86)", ""), "Steam"),
        Path(os.environ.get("ProgramFiles", ""), "Steam"),
        Path("C:/Steam"),
        Path("D:/Steam"),
    ]:
        if candidate.exists():
            return candidate
    return None


def parse_library_folders(steam_path: Path) -> List[Path]:
    vdf = steam_path / "steamapps" / "libraryfolders.vdf"
    libraries = [steam_path]
    if not vdf.exists():
        return libraries
    try:
        text = vdf.read_text(encoding="utf-8", errors="replace")
        for m in re.finditer(r'"path"\s+"([^"]+)"', text):
            p = Path(m.group(1).replace("\\\\", "\\"))
            if p.exists() and p not in libraries:
                libraries.append(p)
    except Exception:
        pass
    return libraries


def find_skyrim_se(steam_path: Optional[Path]) -> Optional[Path]:
    if steam_path is None:
        return None
    for lib in parse_library_folders(steam_path):
        candidate = lib / "steamapps" / "common" / "Skyrim Special Edition"
        if (candidate / "SkyrimSE.exe").exists():
            return candidate
    return None


def find_skse_loader(skyrim_dir: Path) -> Optional[Path]:
    for name in ("skse64_loader.exe", "sksevr_loader.exe", "skse_loader.exe"):
        p = skyrim_dir / name
        if p.exists():
            return p
    return None


# ============================================================================
# Dependency checking
# ============================================================================

class ComponentStatus:
    def __init__(self, name: str, installed: bool, missing_files: List[str]):
        self.name = name
        self.installed = installed
        self.missing_files = missing_files


def check_component(skyrim_dir: Path, name: str, markers: List[str]) -> ComponentStatus:
    missing = []
    for rel in markers:
        if not (skyrim_dir / rel).exists():
            missing.append(rel)
    return ComponentStatus(name, len(missing) == 0, missing)


def check_all_components(skyrim_dir: Path) -> List[ComponentStatus]:
    addr_ok = has_address_library(skyrim_dir)
    addr = ComponentStatus(
        "Address Library (NG)",
        addr_ok,
        [] if addr_ok else [f"Data/SKSE/Plugins/{ADDRESS_LIB_GLOB} (fehlt)"],
    )
    return [
        check_component(skyrim_dir, "SKSE64", SKSE_MARKERS),
        check_component(skyrim_dir, "Skyrim Platform", SP_MARKERS),
        check_component(skyrim_dir, "FrostMP Client", CLIENT_MARKERS),
        addr,
    ]


# ============================================================================
# Download helpers
# ============================================================================

def download_file(url: str, dest: Path, progress_cb=None) -> None:
    """Download a file with optional progress callback(bytes_done, total_bytes)."""
    req = urllib.request.Request(url, headers={
        "User-Agent": "FrostMP-Launcher/1.0",
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        total = int(resp.headers.get("Content-Length", 0))
        done = 0
        with open(dest, "wb") as f:
            while True:
                chunk = resp.read(65536)
                if not chunk:
                    break
                f.write(chunk)
                done += len(chunk)
                if progress_cb:
                    progress_cb(done, total)


def _is_http_url(s: str) -> bool:
    return s.startswith("http://") or s.startswith("https://")


def http_head_fingerprint(url: str) -> Optional[str]:
    """
    Liefert einen Vergleichs-String aus ETag und/oder Last-Modified (HEAD-Request),
    oder None wenn der Server keine brauchbaren Header liefert / die Anfrage fehlschlaegt.
    So kann der Launcher erkennen, ob die Client-ZIP auf dem Server neu ist, ohne sie komplett zu laden.
    """
    try:
        req = urllib.request.Request(
            url,
            method="HEAD",
            headers={"User-Agent": "FrostMP-Launcher/1.0"},
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            etag = (resp.headers.get("ETag") or "").strip()
            lm = (resp.headers.get("Last-Modified") or "").strip()
        if not etag and not lm:
            return None
        return f"{etag}|{lm}"
    except Exception:
        return None


# ============================================================================
# 7z extraction (multi-strategy)
# ----------------------------------------------------------------------------
# Wichtig: py7zr unterstuetzt den BCJ2-Filter nicht, der in allen aktuellen
# SKSE-Archiven von skse.silverlock.org steckt. Deshalb probieren wir zuerst
# einen externen 7-Zip/7zr-Extractor (bundeln wir mit dem Launcher als
# bin/7zr.exe mit) und fallen nur im Notfall auf py7zr zurueck — das klappt
# dann hoechstens fuer non-BCJ2-Archive.
# ============================================================================

def _run_7z_exe(exe: str, archive: Path, dest: Path) -> bool:
    """Ruft ein 7-Zip-kompatibles Executable mit Extraktions-Argumenten auf."""
    try:
        subprocess.run(
            [exe, "x", str(archive), f"-o{dest}", "-y"],
            check=True, capture_output=True,
        )
        return True
    except (FileNotFoundError, subprocess.CalledProcessError):
        return False


def _try_bundled_7zr(archive: Path, dest: Path) -> bool:
    """Mit dem Launcher mitgeliefertes bin/7zr.exe — loest das BCJ2-Problem
    ohne dass der Spieler irgendwas installieren muss."""
    env_path = os.environ.get("FROSTMP_BUNDLED_7ZR")
    candidates: List[str] = []
    if env_path:
        candidates.append(env_path)
    # Fallback: gleicher Pfad relativ zu diesem .py (wenn kein Env gesetzt).
    here = Path(__file__).resolve().parent
    candidates.extend([
        str(here / "bin" / "7zr.exe"),
        str(here.parent / "bin" / "7zr.exe"),
        str(here / "FrostholdRP-Launcher" / "bin" / "7zr.exe"),
    ])
    for p in candidates:
        if p and Path(p).is_file() and _run_7z_exe(p, archive, dest):
            return True
    return False


def _try_installed_7zip(archive: Path, dest: Path) -> bool:
    """Sucht nach einer lokalen 7-Zip-Installation an Standard-Pfaden, auch
    wenn 7z.exe nicht auf PATH liegt (7-Zip setzt sich per Default NICHT
    auf PATH)."""
    candidates: List[str] = []
    for env_var in ("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"):
        root = os.environ.get(env_var)
        if root:
            candidates.append(os.path.join(root, "7-Zip", "7z.exe"))
    # Haeufige fest-verdrahtete Pfade als Sicherheitsnetz:
    candidates.extend([
        r"C:\Program Files\7-Zip\7z.exe",
        r"C:\Program Files (x86)\7-Zip\7z.exe",
    ])
    # Dedupe, Reihenfolge erhalten.
    seen: set = set()
    for p in candidates:
        if p in seen:
            continue
        seen.add(p)
        if Path(p).is_file() and _run_7z_exe(p, archive, dest):
            return True
    return False


def _try_subprocess_7z(archive: Path, dest: Path) -> bool:
    """Letzte Chance via PATH — wenn der User 7-Zip bewusst dort eingetragen hat."""
    for exe in ("7z", "7za", "7z.exe", "7za.exe", "7zr", "7zr.exe"):
        if _run_7z_exe(exe, archive, dest):
            return True
    return False


def _try_py7zr(archive: Path, dest: Path) -> bool:
    """Notnagel fuer Archive ohne BCJ2-Filter. Schlaegt bei SKSE zuverlaessig fehl."""
    try:
        import py7zr
        with py7zr.SevenZipFile(str(archive), mode="r") as z:
            z.extractall(path=str(dest))
        return True
    except Exception:
        return False


def extract_7z(archive: Path, dest: Path) -> bool:
    """Try multiple methods to extract a .7z archive. Returns True on success.

    Reihenfolge absichtlich: zuerst externe 7z-Binaries (die BCJ2 koennen),
    py7zr ganz zum Schluss, weil es BCJ2 nicht unterstuetzt und bei SKSE
    ohnehin kracht.
    """
    return (
        _try_bundled_7zr(archive, dest)
        or _try_installed_7zip(archive, dest)
        or _try_subprocess_7z(archive, dest)
        or _try_py7zr(archive, dest)
    )


# ============================================================================
# Installation routines
# ============================================================================

def install_skse(skyrim_dir: Path, progress_cb=None, status_cb=None) -> bool:
    """Download and install SKSE64 into the Skyrim directory."""
    if status_cb:
        status_cb("SKSE64 wird heruntergeladen...")

    tmp = Path(tempfile.mkdtemp(prefix="frostmp_"))
    archive_path = tmp / f"skse64_{SKSE_VERSION}.7z"

    try:
        download_file(SKSE_URL, archive_path, progress_cb)
    except Exception as e:
        shutil.rmtree(tmp, ignore_errors=True)
        raise RuntimeError(f"SKSE-Download fehlgeschlagen: {e}")

    if status_cb:
        status_cb("SKSE64 wird entpackt...")

    if not extract_7z(archive_path, tmp):
        shutil.rmtree(tmp, ignore_errors=True)
        raise RuntimeError(
            "SKSE konnte nicht entpackt werden.\n\n"
            "Das mitgelieferte 7zr.exe scheint zu fehlen (bin/7zr.exe). Moegliche "
            "Ursachen: Launcher-Installation beschaedigt, oder eine Antivirus-Software "
            "hat bin/7zr.exe entfernt. Launcher neu installieren oder bin/7zr.exe als "
            "vertrauenswuerdig einstufen.\n\n"
            "Notfall-Workaround: 7-Zip (https://www.7-zip.org) installieren, danach "
            "erneut auf Aktualisieren klicken."
        )

    if status_cb:
        status_cb("SKSE64 wird installiert...")

    extracted = tmp / SKSE_FOLDER_IN_ARCHIVE
    if not extracted.exists():
        for child in tmp.iterdir():
            if child.is_dir() and "skse" in child.name.lower():
                extracted = child
                break

    if not extracted.exists():
        shutil.rmtree(tmp, ignore_errors=True)
        raise RuntimeError("SKSE-Archiv hat unerwartete Struktur.")

    for item in extracted.iterdir():
        dest = skyrim_dir / item.name
        if item.is_dir():
            if dest.exists():
                shutil.copytree(str(item), str(dest), dirs_exist_ok=True)
            else:
                shutil.copytree(str(item), str(dest))
        else:
            shutil.copy2(str(item), str(dest))

    shutil.rmtree(tmp, ignore_errors=True)
    return True


def install_client_dist_from_zip(
    skyrim_dir: Path, zip_path: Path,
    progress_cb=None, status_cb=None,
) -> bool:
    """Extract a client dist zip into the Skyrim directory."""
    if status_cb:
        status_cb("Client-Dateien werden entpackt...")

    with zipfile.ZipFile(str(zip_path), "r") as zf:
        members = zf.namelist()
        total = len(members)

        prefix = _detect_zip_prefix(members)

        for i, member in enumerate(members):
            if member.endswith("/"):
                continue

            rel = member
            if prefix and rel.startswith(prefix):
                rel = rel[len(prefix):]

            if not rel:
                continue

            dest = skyrim_dir / rel.replace("/", os.sep)
            dest.parent.mkdir(parents=True, exist_ok=True)

            with zf.open(member) as src, open(dest, "wb") as dst:
                shutil.copyfileobj(src, dst)

            if progress_cb:
                progress_cb(i + 1, total)

    cleanup_legacy_client_files(skyrim_dir)
    return True


def install_client_dist_from_folder(
    skyrim_dir: Path, source: Path,
    progress_cb=None, status_cb=None,
) -> bool:
    """Copy client dist from a local folder into the Skyrim directory."""
    if status_cb:
        status_cb("Client-Dateien werden kopiert...")

    all_files = list(source.rglob("*"))
    files = [f for f in all_files if f.is_file()]
    total = len(files)

    for i, src_file in enumerate(files):
        rel = src_file.relative_to(source)
        dest = skyrim_dir / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(src_file), str(dest))
        if progress_cb:
            progress_cb(i + 1, total)

    cleanup_legacy_client_files(skyrim_dir)
    return True


def install_client_dist_from_url(
    skyrim_dir: Path, url: str,
    progress_cb=None, status_cb=None,
) -> bool:
    """Download a client dist zip from URL and install it."""
    if status_cb:
        status_cb("Client-Distribution wird heruntergeladen...")

    tmp = Path(tempfile.mkdtemp(prefix="frostmp_"))
    zip_path = tmp / "client-dist.zip"
    try:
        download_file(url, zip_path, progress_cb)
        if status_cb:
            status_cb("Client-Dateien werden entpackt...")
        install_client_dist_from_zip(skyrim_dir, zip_path, progress_cb, status_cb)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return True


def _detect_zip_prefix(members: List[str]) -> str:
    """Detect a common prefix directory in zip members (e.g. 'client/' or 'dist/client/')."""
    prefixes_to_strip = ["client/", "dist/client/"]
    for pfx in prefixes_to_strip:
        if all(m.startswith(pfx) or m.rstrip("/") + "/" == pfx for m in members if m.strip()):
            return pfx

    if members:
        first = members[0]
        if "/" in first:
            candidate = first.split("/")[0] + "/"
            if all(m.startswith(candidate) for m in members if m.strip()):
                return candidate
    return ""


# ============================================================================
# Launcher config persistence
# ============================================================================

CONFIG_FILE = Path(__file__).parent / "frostmp-launcher.json"


def load_config() -> dict:
    if CONFIG_FILE.exists():
        try:
            return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_config(cfg: dict):
    """Merge into existing file so Electron-only keys (e.g. status_url) stay intact."""
    try:
        base = load_config()
        base.update(cfg)
        CONFIG_FILE.write_text(json.dumps(base, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def get_effective_client_dist(cfg: dict) -> str:
    """URL/Pfad für Client-Distribution: Config → Umgebung → frosthold-client-dist.url."""
    u = (cfg.get("client_dist_source") or "").strip()
    if u:
        return u
    if DEFAULT_CLIENT_DIST_URL:
        return DEFAULT_CLIENT_DIST_URL
    p = Path(__file__).parent / "frosthold-client-dist.url"
    if p.is_file():
        try:
            for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    return line
        except Exception:
            pass
    bundled_next = Path(__file__).parent / "launcher-bundled-defaults.json"
    if bundled_next.is_file():
        try:
            j = json.loads(bundled_next.read_text(encoding="utf-8"))
            u = (j.get("client_dist_source") or "").strip()
            if u:
                return u
        except Exception:
            pass
    bundled = Path(__file__).parent / "FrostholdRP-Launcher" / "launcher-bundled-defaults.json"
    if bundled.is_file():
        try:
            j = json.loads(bundled.read_text(encoding="utf-8"))
            u = (j.get("client_dist_source") or "").strip()
            if u:
                return u
        except Exception:
            pass
    return ""


def resolve_skyrim_dir(cfg: dict) -> Optional[Path]:
    """Gespeicherter Pfad, sonst Steam-Library."""
    skyrim_dir_s = cfg.get("skyrim_dir")
    if skyrim_dir_s:
        p = Path(skyrim_dir_s)
        if (p / "SkyrimSE.exe").exists():
            return p
    steam = find_steam_path()
    return find_skyrim_se(steam)


def get_settings_path(skyrim_dir: Path) -> Path:
    return skyrim_dir / "Data" / "Platform" / "Plugins" / "frostmp-client-settings.txt"


def cleanup_legacy_client_files(skyrim_dir: Path) -> List[str]:
    """Entfernt alte skymp5-client-* Dateien, falls noch vorhanden.

    Wird beim Update auf das FrostMP-Branding aufgerufen. Gibt eine Liste der
    geloeschten relativen Pfade zurueck (fuer Logging im Launcher).
    """
    removed: List[str] = []
    for rel in (LEGACY_CLIENT_PLUGIN, LEGACY_CLIENT_SETTINGS):
        p = skyrim_dir / rel
        try:
            if p.is_file():
                p.unlink()
                removed.append(rel)
        except OSError:
            pass
    return removed


def _frosthold_chat_keys_for_client_settings(cfg: dict) -> Dict[str, Any]:
    """
    FrostholdChatService (frostmp-client) liest unter sp.settings['frostmp-client']:
    frosthold-chat-enabled (bool), frosthold-chat-ws-url, frosthold-chat-user-id, frosthold-chat-secret.
    Quelle: frostmp-launcher.json mit Schluesseln frosthold_chat_* (snake_case).
    """
    out: Dict[str, Any] = {}
    raw_en = cfg.get("frosthold_chat_enabled")
    enabled = raw_en is True or str(raw_en).lower() in ("1", "true", "yes")
    out["frosthold-chat-enabled"] = enabled
    u = (cfg.get("frosthold_chat_ws_url") or "").strip()
    if u:
        out["frosthold-chat-ws-url"] = u
    uid = (cfg.get("frosthold_chat_user_id") or "").strip()
    if uid:
        out["frosthold-chat-user-id"] = uid
    sec = (cfg.get("frosthold_chat_secret") or "").strip()
    if sec:
        out["frosthold-chat-secret"] = sec
    return out


def write_client_settings(
    skyrim_dir: Path, server_ip: str, port: int, profile_id: int, cfg: Optional[dict] = None
) -> Path:
    cfg = cfg if isinstance(cfg, dict) else {}
    settings: Dict[str, Any] = {
        "server-ip": server_ip,
        "server-host": server_ip,
        "server-port": port,
        "server-info-ignore": True,
        "master": "",
        "server-master-key": None,
        "gameData": {"profileId": profile_id},
    }
    settings.update(_frosthold_chat_keys_for_client_settings(cfg))
    path = get_settings_path(skyrim_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, indent=2), encoding="utf-8")
    cleanup_legacy_client_files(skyrim_dir)
    return path


# ============================================================================
# Colors / theme constants
# ============================================================================

BG = "#1a1a2e"
BG_LIGHT = "#16213e"
FG = "#e0e0e0"
FG_DIM = "#a0a0c0"
FG_FIELD = "#c0c0d0"
GREEN = "#4ecca3"
RED = "#ff6b6b"
YELLOW = "#ffd93d"



def _install_client_files_sync(skyrim_dir: Path, client_dist_url: str) -> None:
    """Install Skyrim Platform / client without GUI (for Electron)."""
    url = client_dist_url.strip()
    if url and (url.startswith("http://") or url.startswith("https://")):
        install_client_dist_from_url(skyrim_dir, url, progress_cb=None, status_cb=None)
        return
    if url and Path(url).exists():
        p = Path(url)
        if p.is_file() and p.suffix.lower() == ".zip":
            install_client_dist_from_zip(skyrim_dir, p, progress_cb=None, status_cb=None)
            return
        if p.is_dir():
            install_client_dist_from_folder(skyrim_dir, p, progress_cb=None, status_cb=None)
            return
    raise RuntimeError(
        "Keine gueltige Client-Distribution. URL, ZIP oder Ordner in den Einstellungen angeben."
    )


def _install_missing_components(
    cfg: dict, skyrim_dir: Path, client_src: str
) -> Tuple[bool, Optional[str], Optional[str]]:
    """
    Returns (success, error_code, message). error_code e.g. client_dist_required, install_failed.
    """
    components = check_all_components(skyrim_dir)
    missing = [c for c in components if not c.installed]
    client_src = (client_src or "").strip()

    # Alles installiert: optional Client-Dist per HTTP neu ziehen, wenn Remote-Datei sich geaendert hat
    if not missing and client_src and _is_http_url(client_src):
        force_once = bool(cfg.get("client_force_update_once"))
        remote_fp = http_head_fingerprint(client_src)
        stored_fp = (cfg.get("client_dist_remote_fp") or "").strip()

        if force_once:
            try:
                _install_client_files_sync(skyrim_dir, client_src)
                new_fp = http_head_fingerprint(client_src) or remote_fp
                patch: Dict[str, Any] = {"client_force_update_once": False}
                if new_fp:
                    patch["client_dist_remote_fp"] = new_fp
                save_config(patch)
            except Exception as e:
                return False, "install_failed", str(e)
            return True, None, None

        if remote_fp and stored_fp and remote_fp != stored_fp:
            try:
                _install_client_files_sync(skyrim_dir, client_src)
                new_fp = http_head_fingerprint(client_src) or remote_fp
                if new_fp:
                    save_config({"client_dist_remote_fp": new_fp})
            except Exception as e:
                return False, "install_failed", str(e)
            return True, None, None

        # Erstes Mal mit dieser Logik: Fingerprint speichern ohne erneuten Download
        if remote_fp and not stored_fp:
            save_config({"client_dist_remote_fp": remote_fp})

        return True, None, None

    if not missing:
        return True, None, None

    needs_skse = any(c.name == "SKSE64" and not c.installed for c in missing)
    needs_client = any(
        c.name in ("Skyrim Platform", "FrostMP Client", "Address Library (NG)")
        and not c.installed
        for c in missing
    )
    if needs_client and not client_src:
        return False, "client_dist_required", (
            "Keine Client-Download-Quelle. Lege frosthold-client-dist.url (eine Zeile URL) "
            "neben FrostMP-Launcher.py an oder setze FROSTHOLD_CLIENT_DIST_URL."
        )

    try:
        if needs_skse:
            install_skse(skyrim_dir, progress_cb=None, status_cb=None)
        if needs_client:
            _install_client_files_sync(skyrim_dir, client_src)
            if _is_http_url(client_src):
                new_fp = http_head_fingerprint(client_src)
                if new_fp:
                    save_config({"client_dist_remote_fp": new_fp})
    except Exception as e:
        return False, "install_failed", str(e)

    components = check_all_components(skyrim_dir)
    still = [c.name for c in components if not c.installed]
    if still:
        return False, "install_incomplete", ", ".join(still)
    return True, None, None


def compute_launcher_pending(cfg: dict, skyrim_dir: Optional[Path]) -> Dict[str, Any]:
    """
    True, wenn Installation oder Client-Update nötig ist (nur Prüfung, kein Download).
    Gleiche Logik wie _install_missing_components, aber ohne Seiteneffekte.
    """
    out: Dict[str, Any] = {"pending_setup": False, "pending_reasons": []}
    if skyrim_dir is None:
        return out
    try:
        if not skyrim_dir.is_dir() or not (skyrim_dir / "SkyrimSE.exe").exists():
            return out
    except Exception:
        return out

    components = check_all_components(skyrim_dir)
    missing = [c for c in components if not c.installed]
    if missing:
        out["pending_setup"] = True
        out["pending_reasons"].append("missing_components")
        return out

    client_src = get_effective_client_dist(cfg).strip()
    if client_src and _is_http_url(client_src):
        if bool(cfg.get("client_force_update_once")):
            out["pending_setup"] = True
            out["pending_reasons"].append("client_force_refresh")
            return out
        remote_fp = http_head_fingerprint(client_src)
        stored_fp = (cfg.get("client_dist_remote_fp") or "").strip()
        if remote_fp and stored_fp and remote_fp != stored_fp:
            out["pending_setup"] = True
            out["pending_reasons"].append("client_dist_remote_changed")
    return out


def ensure_components_install_headless() -> dict:
    """
    Nur Installation / Reparatur, kein Spielstart. Für Launcher-Button „Aktualisieren“.
    """
    cfg = load_config()
    server_ip = (cfg.get("server_ip") or DEFAULT_SERVER_IP).strip()
    try:
        port = int(cfg.get("server_port", DEFAULT_PORT))
    except (TypeError, ValueError):
        port = DEFAULT_PORT
    try:
        profile_id = int(cfg.get("profile_id", 1))
        if profile_id < 1:
            raise ValueError
    except (TypeError, ValueError):
        profile_id = 1

    skyrim_dir = resolve_skyrim_dir(cfg)
    if skyrim_dir is None:
        return {
            "ok": False,
            "error": "skyrim_not_found",
            "message": "Skyrim SE wurde nicht gefunden. Installation über Steam prüfen oder Pfad in den Einstellungen.",
            "ready_to_play": False,
        }

    client_src = get_effective_client_dist(cfg)
    ok, err, msg = _install_missing_components(cfg, skyrim_dir, client_src)
    if not ok:
        out: Dict[str, Any] = {
            "ok": False,
            "error": err,
            "message": msg,
            "ready_to_play": False,
            "skyrim_dir": str(skyrim_dir),
        }
        if err == "client_dist_required":
            comps = check_all_components(skyrim_dir)
            out["missing"] = [c.name for c in comps if not c.installed]
        return out

    skse = find_skse_loader(skyrim_dir)
    if not skse:
        return {
            "ok": False,
            "error": "skse_missing",
            "message": "skse64_loader.exe fehlt.",
            "ready_to_play": False,
        }

    write_client_settings(skyrim_dir, server_ip, port, profile_id, cfg)
    save_config({
        "server_ip": server_ip,
        "server_port": port,
        "profile_id": profile_id,
        "skyrim_dir": str(skyrim_dir),
        "client_dist_source": client_src,
    })

    return {
        "ok": True,
        "ready_to_play": True,
        "message": "Alles installiert. Du kannst spielen.",
        "skyrim_dir": str(skyrim_dir),
    }


def ensure_components_and_launch_headless() -> dict:
    """
    For Electron: auto-detect Skyrim, install missing SKSE/client if dist URL set,
    write frostmp-client-settings.txt, start skse64_loader.exe (NOT SkyrimSE.exe).
    Returns a dict suitable for JSON.
    """
    cfg = load_config()
    server_ip = (cfg.get("server_ip") or DEFAULT_SERVER_IP).strip()
    try:
        port = int(cfg.get("server_port", DEFAULT_PORT))
    except (TypeError, ValueError):
        port = DEFAULT_PORT
    try:
        profile_id = int(cfg.get("profile_id", 1))
        if profile_id < 1:
            raise ValueError
    except (TypeError, ValueError):
        profile_id = 1

    skyrim_dir = resolve_skyrim_dir(cfg)
    if skyrim_dir is None:
        return {"ok": False, "error": "skyrim_not_found", "message": "Skyrim SE wurde nicht gefunden. Pfad in den Einstellungen setzen."}

    client_src = get_effective_client_dist(cfg)
    ok, err, msg = _install_missing_components(cfg, skyrim_dir, client_src)
    if not ok:
        out: Dict[str, Any] = {"ok": False, "error": err, "message": msg}
        if err == "client_dist_required":
            comps = check_all_components(skyrim_dir)
            out["missing"] = [c.name for c in comps if not c.installed]
        return out

    skse = find_skse_loader(skyrim_dir)
    if not skse:
        return {"ok": False, "error": "skse_missing", "message": "skse64_loader.exe fehlt."}

    write_client_settings(skyrim_dir, server_ip, port, profile_id, cfg)
    save_config({
        "server_ip": server_ip,
        "server_port": port,
        "profile_id": profile_id,
        "skyrim_dir": str(skyrim_dir),
        "client_dist_source": client_src,
    })

    try:
        subprocess.Popen(
            [str(skse)],
            cwd=str(skyrim_dir),
            creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
        )
    except Exception as e:
        return {"ok": False, "error": "launch_failed", "message": str(e)}

    return {"ok": True, "skyrim_dir": str(skyrim_dir), "launcher": "skse64_loader.exe"}


def cli_json_status() -> None:
    cfg = load_config()
    steam = find_steam_path()
    detected = find_skyrim_se(steam)
    saved = cfg.get("skyrim_dir")
    skyrim_dir: Optional[Path] = None
    if saved and (Path(saved) / "SkyrimSE.exe").exists():
        skyrim_dir = Path(saved)
    elif detected:
        skyrim_dir = detected

    out: Dict[str, Any] = {
        "skyrim_auto": str(detected) if detected else None,
        "skyrim_effective": str(skyrim_dir) if skyrim_dir else None,
        "components": None,
    }
    if skyrim_dir:
        comps = check_all_components(skyrim_dir)
        out["components"] = [
            {"name": c.name, "ok": c.installed, "missing": c.missing_files}
            for c in comps
        ]
        out["ready_to_play"] = all(c.installed for c in comps)
    else:
        out["ready_to_play"] = False

    pend = compute_launcher_pending(cfg, skyrim_dir)
    out["pending_setup"] = pend["pending_setup"]
    out["pending_reasons"] = pend["pending_reasons"]

    print(json.dumps(out, ensure_ascii=False))


def cli_json_play() -> None:
    result = ensure_components_and_launch_headless()
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result.get("ok") else 1)


def cli_json_setup() -> None:
    result = ensure_components_install_headless()
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result.get("ok") else 1)




def cli_json_main() -> None:
    import sys
    if len(sys.argv) >= 2 and sys.argv[1] == "--json-status":
        cli_json_status()
    elif len(sys.argv) >= 2 and sys.argv[1] == "--json-play":
        cli_json_play()
    elif len(sys.argv) >= 2 and sys.argv[1] == "--json-setup":
        cli_json_setup()
    else:
        raise SystemExit("cli_json_main ohne passendes Argument aufgerufen")
