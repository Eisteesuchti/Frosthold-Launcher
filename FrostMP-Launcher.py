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
import tkinter as tk
from tkinter import ttk, messagebox, filedialog
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
    "Data/Platform/Plugins/skymp5-client.js",
]

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


# ============================================================================
# 7z extraction (multi-strategy)
# ============================================================================

def _try_py7zr(archive: Path, dest: Path) -> bool:
    try:
        import py7zr
        with py7zr.SevenZipFile(str(archive), mode="r") as z:
            z.extractall(path=str(dest))
        return True
    except ImportError:
        return False


def _try_subprocess_7z(archive: Path, dest: Path) -> bool:
    for exe in ("7z", "7za", "7z.exe", "7za.exe"):
        try:
            subprocess.run(
                [exe, "x", str(archive), f"-o{dest}", "-y"],
                check=True, capture_output=True,
            )
            return True
        except (FileNotFoundError, subprocess.CalledProcessError):
            continue
    return False


def _try_install_py7zr_then_extract(archive: Path, dest: Path) -> bool:
    try:
        subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", "py7zr"],
            check=True, capture_output=True,
        )
        return _try_py7zr(archive, dest)
    except (subprocess.CalledProcessError, FileNotFoundError):
        return False


def extract_7z(archive: Path, dest: Path) -> bool:
    """Try multiple methods to extract a .7z archive. Returns True on success."""
    return (
        _try_py7zr(archive, dest)
        or _try_subprocess_7z(archive, dest)
        or _try_install_py7zr_then_extract(archive, dest)
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
            "Bitte installiere 7-Zip (7z.exe) oder fuehre aus:\n"
            f"  pip install py7zr\n\n"
            "Alternativ: Lade SKSE manuell von skse.silverlock.org herunter."
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
    return skyrim_dir / "Data" / "Platform" / "Plugins" / "skymp5-client-settings.txt"


def write_client_settings(skyrim_dir: Path, server_ip: str, port: int, profile_id: int) -> Path:
    settings = {
        "server-ip": server_ip,
        "server-host": server_ip,
        "server-port": port,
        "server-info-ignore": True,
        "master": "",
        "server-master-key": None,
        "gameData": {"profileId": profile_id},
    }
    path = get_settings_path(skyrim_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, indent=2), encoding="utf-8")
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


# ============================================================================
# Install Progress Dialog
# ============================================================================

class InstallDialog(tk.Toplevel):
    """Modal dialog showing installation progress."""

    def __init__(self, parent: tk.Tk, skyrim_dir: Path, missing: List[ComponentStatus],
                 client_dist_url: str):
        super().__init__(parent)
        self.title("FrostMP - Installation")
        self.configure(bg=BG)
        self.resizable(False, False)
        self.transient(parent)
        self.grab_set()
        self.protocol("WM_DELETE_WINDOW", lambda: None)

        self.parent_win = parent
        self.skyrim_dir = skyrim_dir
        self.missing = missing
        self.client_dist_url = client_dist_url
        self.success = False
        self.error_msg = ""

        frame = ttk.Frame(self, padding=30)
        frame.pack(fill="both", expand=True)

        ttk.Label(frame, text="Installation", style="Title.TLabel").pack(pady=(0, 15))

        self.status_var = tk.StringVar(value="Vorbereitung...")
        ttk.Label(frame, textvariable=self.status_var, style="Sub.TLabel",
                  wraplength=400).pack(pady=(0, 10))

        self.progress = ttk.Progressbar(frame, length=400, mode="determinate")
        self.progress.pack(pady=(0, 10))

        self.detail_var = tk.StringVar(value="")
        ttk.Label(frame, textvariable=self.detail_var, style="Sub.TLabel").pack(pady=(0, 5))

        self.center()
        self.after(100, self._start_install)

    def center(self):
        self.update_idletasks()
        w, h = self.winfo_width(), self.winfo_height()
        sw, sh = self.winfo_screenwidth(), self.winfo_screenheight()
        self.geometry(f"+{(sw - w) // 2}+{(sh - h) // 2}")

    def _update_progress(self, done: int, total: int):
        if total > 0:
            pct = min(100, int(done / total * 100))
            self.progress["value"] = pct
            if total > 1024 * 1024:
                self.detail_var.set(f"{done / 1024 / 1024:.1f} / {total / 1024 / 1024:.1f} MB")
            else:
                self.detail_var.set(f"{done} / {total}")
        self.update_idletasks()

    def _update_status(self, text: str):
        self.status_var.set(text)
        self.progress["value"] = 0
        self.detail_var.set("")
        self.update_idletasks()

    def _start_install(self):
        thread = threading.Thread(target=self._install_thread, daemon=True)
        thread.start()
        self._poll_thread(thread)

    def _poll_thread(self, thread: threading.Thread):
        if thread.is_alive():
            self.after(100, lambda: self._poll_thread(thread))
        else:
            self._on_done()

    def _install_thread(self):
        try:
            self._run_installations()
            self.success = True
        except Exception as e:
            self.error_msg = str(e)
            self.success = False

    def _progress_cb_threadsafe(self, done: int, total: int):
        self.after_idle(self._update_progress, done, total)

    def _status_cb_threadsafe(self, text: str):
        self.after_idle(self._update_status, text)

    def _run_installations(self):
        needs_skse = any(c.name == "SKSE64" and not c.installed for c in self.missing)
        needs_client = any(
            c.name in ("Skyrim Platform", "FrostMP Client", "Address Library (NG)")
            and not c.installed
            for c in self.missing
        )

        if needs_skse:
            install_skse(
                self.skyrim_dir,
                progress_cb=self._progress_cb_threadsafe,
                status_cb=self._status_cb_threadsafe,
            )

        if needs_client:
            self._install_client_files()

        self._status_cb_threadsafe("Installation abgeschlossen!")

    def _install_client_files(self):
        url = self.client_dist_url.strip()

        if url and (url.startswith("http://") or url.startswith("https://")):
            install_client_dist_from_url(
                self.skyrim_dir, url,
                progress_cb=self._progress_cb_threadsafe,
                status_cb=self._status_cb_threadsafe,
            )
            return

        if url and Path(url).exists():
            p = Path(url)
            if p.is_file() and p.suffix.lower() == ".zip":
                self._status_cb_threadsafe("Client-Dateien werden aus ZIP entpackt...")
                install_client_dist_from_zip(
                    self.skyrim_dir, p,
                    progress_cb=self._progress_cb_threadsafe,
                    status_cb=self._status_cb_threadsafe,
                )
                return
            elif p.is_dir():
                self._status_cb_threadsafe("Client-Dateien werden kopiert...")
                install_client_dist_from_folder(
                    self.skyrim_dir, p,
                    progress_cb=self._progress_cb_threadsafe,
                    status_cb=self._status_cb_threadsafe,
                )
                return

        raise RuntimeError(
            "Skyrim Platform / FrostMP Client fehlt und es wurde keine\n"
            "gueltige Quelle angegeben.\n\n"
            "Bitte gib im Feld 'Client-Distribution' eine URL oder einen\n"
            "lokalen Pfad zu deinem build/dist/client Ordner oder ZIP an."
        )

    def _on_done(self):
        self.grab_release()
        if self.success:
            self.destroy()
        else:
            self.destroy()
            messagebox.showerror("Installationsfehler", self.error_msg, parent=self.parent_win)


# ============================================================================
# Main Launcher GUI
# ============================================================================

class FrostMPLauncher(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("FrostMP Launcher")
        self.resizable(False, False)
        self.configure(bg=BG)

        cfg = load_config()
        steam = find_steam_path()
        detected_skyrim = find_skyrim_se(steam)
        saved_skyrim = cfg.get("skyrim_dir")

        if saved_skyrim and Path(saved_skyrim).exists() and (Path(saved_skyrim) / "SkyrimSE.exe").exists():
            self.skyrim_dir = Path(saved_skyrim)
        elif detected_skyrim:
            self.skyrim_dir = detected_skyrim
        else:
            self.skyrim_dir = None

        self._setup_styles()
        self._build_ui(cfg)
        self.center_window()

    def center_window(self):
        self.update_idletasks()
        w, h = self.winfo_width(), self.winfo_height()
        sw, sh = self.winfo_screenwidth(), self.winfo_screenheight()
        self.geometry(f"+{(sw - w) // 2}+{(sh - h) // 2}")

    def _setup_styles(self):
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure("Title.TLabel", foreground=FG, background=BG,
                         font=("Segoe UI", 18, "bold"))
        style.configure("Sub.TLabel", foreground=FG_DIM, background=BG,
                         font=("Segoe UI", 9))
        style.configure("Field.TLabel", foreground=FG_FIELD, background=BG,
                         font=("Segoe UI", 10))
        style.configure("Status.TLabel", foreground=FG_DIM, background=BG,
                         font=("Segoe UI", 9))
        style.configure("Good.TLabel", foreground=GREEN, background=BG,
                         font=("Segoe UI", 9))
        style.configure("Bad.TLabel", foreground=RED, background=BG,
                         font=("Segoe UI", 9, "bold"))
        style.configure("Warn.TLabel", foreground=YELLOW, background=BG,
                         font=("Segoe UI", 9))
        style.configure("TFrame", background=BG)
        style.configure("Launch.TButton", font=("Segoe UI", 12, "bold"), padding=(20, 10))
        style.configure("Small.TButton", font=("Segoe UI", 9), padding=(8, 4))

    def _build_ui(self, cfg: dict):
        main = ttk.Frame(self, padding=30)
        main.pack(fill="both", expand=True)

        ttk.Label(main, text="FrostMP", style="Title.TLabel").pack(pady=(0, 2))
        ttk.Label(main, text="Skyrim Multiplayer Launcher", style="Sub.TLabel").pack(pady=(0, 20))

        # --- Server IP ---
        ip_frame = ttk.Frame(main)
        ip_frame.pack(fill="x", pady=(0, 10))
        ttk.Label(ip_frame, text="Server-IP:", style="Field.TLabel").pack(anchor="w")
        self.ip_var = tk.StringVar(value=cfg.get("server_ip", ""))
        ip_entry = ttk.Entry(ip_frame, textvariable=self.ip_var, font=("Consolas", 12), width=30)
        ip_entry.pack(fill="x", pady=(4, 0))
        ip_entry.focus_set()

        # --- Profil-ID ---
        pid_frame = ttk.Frame(main)
        pid_frame.pack(fill="x", pady=(0, 10))
        ttk.Label(pid_frame, text="Profil-ID (eindeutige Spielernummer):",
                  style="Field.TLabel").pack(anchor="w")
        self.pid_var = tk.StringVar(value=str(cfg.get("profile_id", 1)))
        ttk.Entry(pid_frame, textvariable=self.pid_var, font=("Consolas", 12),
                  width=10).pack(anchor="w", pady=(4, 0))

        # --- Skyrim-Pfad ---
        sky_frame = ttk.Frame(main)
        sky_frame.pack(fill="x", pady=(0, 10))
        ttk.Label(sky_frame, text="Skyrim SE Verzeichnis:", style="Field.TLabel").pack(anchor="w")
        path_row = ttk.Frame(sky_frame)
        path_row.pack(fill="x", pady=(4, 0))
        self.skyrim_var = tk.StringVar(value=str(self.skyrim_dir) if self.skyrim_dir else "")
        ttk.Entry(path_row, textvariable=self.skyrim_var, font=("Segoe UI", 9),
                  width=40).pack(side="left", fill="x", expand=True)
        ttk.Button(path_row, text="...", style="Small.TButton",
                   command=self.browse_skyrim, width=3).pack(side="left", padx=(6, 0))
        sky_status = "Automatisch erkannt" if self.skyrim_dir else "Nicht gefunden"
        self.sky_status_label = ttk.Label(sky_frame, text=f"Status: {sky_status}",
                                          style="Sub.TLabel")
        self.sky_status_label.pack(anchor="w", pady=(2, 0))

        # --- Client dist source ---
        dist_frame = ttk.Frame(main)
        dist_frame.pack(fill="x", pady=(0, 10))
        ttk.Label(dist_frame, text="Client-Distribution (URL, ZIP oder Ordner):",
                  style="Field.TLabel").pack(anchor="w")
        dist_row = ttk.Frame(dist_frame)
        dist_row.pack(fill="x", pady=(4, 0))
        self.dist_var = tk.StringVar(
            value=cfg.get("client_dist_source", DEFAULT_CLIENT_DIST_URL)
        )
        ttk.Entry(dist_row, textvariable=self.dist_var, font=("Segoe UI", 9),
                  width=40).pack(side="left", fill="x", expand=True)
        ttk.Button(dist_row, text="...", style="Small.TButton",
                   command=self.browse_dist, width=3).pack(side="left", padx=(6, 0))
        ttk.Label(dist_frame,
                  text="Pfad zu build/dist/client (Ordner oder ZIP) bzw. Download-URL",
                  style="Sub.TLabel").pack(anchor="w", pady=(2, 0))

        # --- Component status ---
        sep = ttk.Separator(main, orient="horizontal")
        sep.pack(fill="x", pady=(8, 8))

        self.status_frame = ttk.Frame(main)
        self.status_frame.pack(fill="x", pady=(0, 10))
        self.component_labels: Dict[str, ttk.Label] = {}
        self._refresh_status()

        ttk.Button(main, text="Status aktualisieren", style="Small.TButton",
                   command=self._refresh_status).pack(pady=(0, 12))

        # --- Launch ---
        ttk.Button(main, text="Skyrim starten", style="Launch.TButton",
                   command=self.launch).pack(pady=(0, 0))

    def _refresh_status(self):
        for w in self.status_frame.winfo_children():
            w.destroy()
        self.component_labels.clear()

        skyrim_path = self.skyrim_var.get().strip()
        if not skyrim_path or not (Path(skyrim_path) / "SkyrimSE.exe").exists():
            ttk.Label(self.status_frame,
                      text="Skyrim SE nicht gefunden - bitte Pfad angeben",
                      style="Bad.TLabel").pack(anchor="w")
            return

        skyrim_dir = Path(skyrim_path)
        components = check_all_components(skyrim_dir)
        for comp in components:
            if comp.installed:
                label = ttk.Label(self.status_frame,
                                  text=f"  {comp.name}: installiert",
                                  style="Good.TLabel")
            else:
                label = ttk.Label(self.status_frame,
                                  text=f"  {comp.name}: fehlt",
                                  style="Bad.TLabel")
            label.pack(anchor="w")
            self.component_labels[comp.name] = label

    def browse_skyrim(self):
        d = filedialog.askdirectory(title="Skyrim SE Verzeichnis auswaehlen")
        if d:
            p = Path(d)
            if (p / "SkyrimSE.exe").exists():
                self.skyrim_dir = p
                self.skyrim_var.set(str(p))
                self.sky_status_label.config(text="Status: Manuell ausgewaehlt")
                self._refresh_status()
            else:
                messagebox.showerror("Fehler",
                    "SkyrimSE.exe wurde im ausgewaehlten Verzeichnis nicht gefunden.\n"
                    "Bitte waehle das korrekte Skyrim SE Verzeichnis aus.")

    def browse_dist(self):
        choice = messagebox.askquestion(
            "Client-Distribution",
            "Moechtest du einen Ordner auswaehlen?\n\n"
            "Ja = Ordner auswaehlen\nNein = ZIP-Datei auswaehlen",
        )
        if choice == "yes":
            d = filedialog.askdirectory(title="Client-Distribution Ordner")
            if d:
                self.dist_var.set(d)
        else:
            f = filedialog.askopenfilename(
                title="Client-Distribution ZIP",
                filetypes=[("ZIP-Dateien", "*.zip"), ("Alle Dateien", "*.*")],
            )
            if f:
                self.dist_var.set(f)

    def launch(self):
        server_ip = self.ip_var.get().strip()
        if not server_ip:
            messagebox.showerror("Fehler", "Bitte gib eine Server-IP ein.")
            return

        try:
            profile_id = int(self.pid_var.get().strip())
            if profile_id < 1:
                raise ValueError
        except ValueError:
            messagebox.showerror("Fehler",
                                 "Bitte gib eine gueltige Profil-ID ein (Zahl >= 1).")
            return

        skyrim_path = self.skyrim_var.get().strip()
        if not skyrim_path:
            messagebox.showerror("Fehler", "Bitte gib das Skyrim SE Verzeichnis an.")
            return
        skyrim_dir = Path(skyrim_path)
        if not (skyrim_dir / "SkyrimSE.exe").exists():
            messagebox.showerror("Fehler",
                "SkyrimSE.exe wurde im angegebenen Verzeichnis nicht gefunden.")
            return

        # Check what's missing
        components = check_all_components(skyrim_dir)
        missing = [c for c in components if not c.installed]

        if missing:
            needs_client = any(
                c.name in ("Skyrim Platform", "FrostMP Client", "Address Library (NG)")
                for c in missing
            )
            if needs_client and not self.dist_var.get().strip():
                messagebox.showwarning(
                    "Client-Distribution fehlt",
                    "Skyrim Platform, FrostMP Client und/oder die Address Library fehlen.\n\n"
                    "Bitte gib im Feld 'Client-Distribution' den Pfad zu deinem\n"
                    "build/dist/client Ordner, einer ZIP-Datei oder einer Download-URL an.\n"
                    "(Die ZIP sollte auch Data/SKSE/Plugins/versionlib-*.bin enthalten.)",
                )
                return

            names = ", ".join(c.name for c in missing)
            proceed = messagebox.askyesno(
                "Installation erforderlich",
                f"Folgende Komponenten fehlen:\n{names}\n\n"
                "Sollen diese jetzt automatisch installiert werden?",
            )
            if not proceed:
                return

            dlg = InstallDialog(self, skyrim_dir, components, self.dist_var.get().strip())
            self.wait_window(dlg)

            if not dlg.success:
                return

            # Re-check after install
            components = check_all_components(skyrim_dir)
            still_missing = [c for c in components if not c.installed]
            if still_missing:
                names = ", ".join(c.name for c in still_missing)
                messagebox.showerror("Fehler",
                    f"Installation unvollstaendig. Es fehlt noch:\n{names}")
                self._refresh_status()
                return

            self._refresh_status()

        # Everything is in place - verify SKSE loader exists
        skse = find_skse_loader(skyrim_dir)
        if not skse:
            messagebox.showerror("Fehler",
                "skse64_loader.exe wurde nicht gefunden, obwohl SKSE als\n"
                "installiert erkannt wurde. Bitte pruefe die Installation.")
            return

        # Write connection settings
        write_client_settings(skyrim_dir, server_ip, DEFAULT_PORT, profile_id)

        # Save launcher config
        save_config({
            "server_ip": server_ip,
            "profile_id": profile_id,
            "skyrim_dir": str(skyrim_dir),
            "client_dist_source": self.dist_var.get().strip(),
        })

        # Launch SKSE
        try:
            subprocess.Popen(
                [str(skse)],
                cwd=str(skyrim_dir),
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
            )
        except Exception as e:
            messagebox.showerror("Fehler", f"SKSE konnte nicht gestartet werden:\n{e}")
            return

        self.destroy()


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
    except Exception as e:
        return False, "install_failed", str(e)

    components = check_all_components(skyrim_dir)
    still = [c.name for c in components if not c.installed]
    if still:
        return False, "install_incomplete", ", ".join(still)
    return True, None, None


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

    write_client_settings(skyrim_dir, server_ip, port, profile_id)
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
    write skymp5-client-settings.txt, start skse64_loader.exe (NOT SkyrimSE.exe).
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

    write_client_settings(skyrim_dir, server_ip, port, profile_id)
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
    print(json.dumps(out, ensure_ascii=False))


def cli_json_play() -> None:
    result = ensure_components_and_launch_headless()
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result.get("ok") else 1)


def cli_json_setup() -> None:
    result = ensure_components_install_headless()
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result.get("ok") else 1)


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--json-status":
        cli_json_status()
    elif len(sys.argv) >= 2 and sys.argv[1] == "--json-play":
        cli_json_play()
    elif len(sys.argv) >= 2 and sys.argv[1] == "--json-setup":
        cli_json_setup()
    else:
        app = FrostMPLauncher()
        app.mainloop()
