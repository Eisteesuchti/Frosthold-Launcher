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
import time
import stat
import errno
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
import urllib.request
import urllib.error
import zipfile
import shutil
import tempfile
import threading

# Windows-spezifische Imports. Auf Linux/macOS laeuft der Launcher zwar nicht
# produktiv, aber Tests und CI sollen weiterhin importieren koennen.
_IS_WIN = os.name == "nt"
if _IS_WIN:
    import ctypes
    from ctypes import wintypes  # noqa: F401  (Typen werden im Aufruf gebraucht)

# ============================================================================
# Progress-Events fuer den Electron-Launcher.
#
# Python streamt line-delimited JSON zu stdout. Electron liest stdout
# zeilenweise und leitet "event":"progress" | "status" an den Renderer
# weiter (-> Fortschrittsbalken). Die LETZTE JSON-Zeile ohne "event"-Feld
# ist das Endresultat (wie bisher).
#
# Wir schreiben bewusst auf stdout (nicht stderr), damit Electron nur EINEN
# Stream parsen muss und Formate kompatibel bleiben.
# ============================================================================

def _emit_event(event_type: str, **kwargs: Any) -> None:
    try:
        data: Dict[str, Any] = {"event": event_type}
        data.update(kwargs)
        sys.stdout.write(json.dumps(data, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:
        # Progress darf unter KEINEN Umstaenden die Installation abschiessen.
        pass


def _make_progress_emitter(phase: str, label: str, throttle_ms: int = 120):
    """
    Erzeugt eine `progress_cb(done, total)` Funktion, die JSON-Events mit
    Phase, Label, Bytes und Prozentwert an den Launcher schickt.

    Throttling: max. ein Update alle `throttle_ms`, ausser das finale
    (done >= total) — das geht immer durch, damit der Balken sauber 100 %
    erreicht und auf die naechste Phase wechseln kann.
    """
    state: Dict[str, Any] = {"t": 0.0, "done": -1, "total": -1, "sent_zero": False}

    def emit(done: int, total: int) -> None:
        now = time.monotonic() * 1000.0
        is_last = total > 0 and done >= total
        if not state["sent_zero"]:
            state["sent_zero"] = True
        elif not is_last and state["t"] and (now - state["t"]) < throttle_ms:
            return
        if done == state["done"] and total == state["total"] and not is_last:
            return
        state["t"] = now
        state["done"] = done
        state["total"] = total
        percent: Optional[float] = None
        if total > 0:
            percent = round((done / total) * 100.0, 1)
        _emit_event(
            "progress",
            phase=phase,
            label=label,
            bytesDone=int(done),
            bytesTotal=int(total),
            percent=percent,
        )

    return emit


def _emit_status(phase: str, message: str) -> None:
    _emit_event("status", phase=phase, message=message)


def _make_status_emitter(phase: str):
    def cb(message: str) -> None:
        _emit_status(phase, message)
    return cb

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

# Microsoft Visual C++ 2015-2022 Redistributable (x64). Skyrim Platform und
# MpClientPlugin brauchen VCRUNTIME140.dll, VCRUNTIME140_1.dll, MSVCP140.dll —
# auf frischen Windows-Installationen fehlen die oft und Skyrim crasht via
# skse64_loader.exe noch vor dem Hauptmenue, obwohl Vanilla-Skyrim startet.
VCREDIST_DLLS = (
    "VCRUNTIME140.dll",
    "VCRUNTIME140_1.dll",
    "MSVCP140.dll",
)


def has_address_library(skyrim_dir: Path) -> bool:
    plug = skyrim_dir / "Data" / "SKSE" / "Plugins"
    if not plug.is_dir():
        return False
    for p in plug.glob("versionlib-*.bin"):
        if p.is_file():
            return True
    return False


def has_vc_redist() -> bool:
    """True, wenn Microsoft VC++ 2015-2022 Redistributable (x64) installiert ist.

    Strategie 1: Registry-Key, den der vc_redist.x64.exe nach Install setzt.
    Strategie 2: Pruefe, ob die drei DLLs in System32 existieren.
    """
    # Strategie 1 — Registry.
    try:
        import winreg
        subkeys = (
            r"SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64",
            r"SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64",
        )
        for sub in subkeys:
            try:
                key = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, sub)
                try:
                    val, _ = winreg.QueryValueEx(key, "Installed")
                    if int(val) == 1:
                        return True
                finally:
                    winreg.CloseKey(key)
            except FileNotFoundError:
                continue
    except ImportError:
        pass

    # Strategie 2 — DLL-Existenz als Fallback (z. B. wenn Registry-Schluessel fehlt).
    system_root = Path(os.environ.get("SystemRoot", r"C:\Windows"))
    system32 = system_root / "System32"
    if all((system32 / dll).is_file() for dll in VCREDIST_DLLS):
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
    vcr_ok = has_vc_redist()
    vcr = ComponentStatus(
        "VC++ Redistributable",
        vcr_ok,
        [] if vcr_ok else ["Microsoft Visual C++ 2015-2022 Redistributable (x64) fehlt"],
    )
    return [
        check_component(skyrim_dir, "SKSE64", SKSE_MARKERS),
        check_component(skyrim_dir, "Skyrim Platform", SP_MARKERS),
        check_component(skyrim_dir, "FrostMP Client", CLIENT_MARKERS),
        addr,
        vcr,
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

def _find_bundled_vcredist() -> Optional[Path]:
    """Sucht den gebundelten vc_redist.x64.exe, den der Electron-Launcher beim
    Spawn als FROSTMP_BUNDLED_VCREDIST bereitstellt. Fallback: relativ zur .py."""
    env_path = os.environ.get("FROSTMP_BUNDLED_VCREDIST")
    here = Path(__file__).resolve().parent
    candidates: List[Path] = []
    if env_path:
        candidates.append(Path(env_path))
    candidates.extend([
        here / "bin" / "vc_redist.x64.exe",
        here.parent / "bin" / "vc_redist.x64.exe",
        here / "FrostholdRP-Launcher" / "bin" / "vc_redist.x64.exe",
    ])
    for p in candidates:
        if p.is_file():
            return p
    return None


def install_vc_redist() -> bool:
    """Installiert Microsoft Visual C++ 2015-2022 Redistributable (x64).
    Loest ggf. einen UAC-Prompt aus (Windows verlangt Elevation fuer
    System-DLLs). Wenn schon installiert -> No-Op (Exit-Code 1638).
    """
    if has_vc_redist():
        return True
    installer = _find_bundled_vcredist()
    if installer is None:
        raise RuntimeError(
            "vc_redist.x64.exe nicht gefunden. Erwartet in bin/vc_redist.x64.exe "
            "im Launcher-Ordner. Launcher bitte neu installieren oder VC++ "
            "Redistributable manuell von https://aka.ms/vs/17/release/vc_redist.x64.exe "
            "installieren."
        )
    # /install /quiet /norestart ist der offizielle Silent-Mode.
    # Exit-Codes:  0 = OK, 1638 = bereits neuere Version da, 3010 = OK + Reboot noetig.
    try:
        proc = subprocess.run(
            [str(installer), "/install", "/quiet", "/norestart"],
            capture_output=True,
        )
    except FileNotFoundError as e:
        raise RuntimeError(f"VC++ Redistributable-Installer nicht startbar: {e}")
    rc = proc.returncode
    if rc in (0, 1638, 3010):
        return True
    stderr_tail = (proc.stderr or b"")[-400:].decode("utf-8", errors="replace")
    raise RuntimeError(
        f"VC++ Redistributable-Installation fehlgeschlagen (Exit {rc}). "
        f"Details: {stderr_tail or 'keine Ausgabe'}"
    )


# ============================================================================
# Robuste Datei-Operationen fuer die Install-Phase.
#
# Hintergrund: Auf vielen Spieler-PCs liegt Skyrim unter "C:\Program Files
# (x86)\Steam\...". Selbst mit Admin-Rechten failen Writes dort haeufig mit
# [Errno 13] Permission denied. Konkrete Ursachen die wir in der Praxis
# gesehen haben:
#
#   1) Eine alte SkyrimPlatformCEF.exe / SkyrimPlatformBrowser.exe / SkyrimSE
#      laeuft noch im Hintergrund und haelt die Ziel-Datei offen
#      (Sharing-Violation, Python uebersetzt das ebenfalls zu Errno 13).
#   2) Die Zieldatei hat ReadOnly/Hidden/System-Attribute (z.B. vom
#      .hidden-Suffix-Mechanismus von Skyrim Platform oder von Mod-Managern).
#      open("wb") scheitert dann auch als Admin.
#   3) Windows Defender scannt die Datei gerade (Real-Time-Scan) und haelt
#      sie kurzzeitig im Share-Lock. Retry nach ein paar hundert Millisekunden
#      reicht dann meistens.
#   4) Der Prozess ist nicht elevated, und der Ordner ist UAC-geschuetzt.
#      Hier bleibt nur Elevation.
#
# Die Helper unten versuchen die Faelle 1-3 transparent zu behandeln und
# signalisieren 4 als strukturierten NeedsElevation-Error, damit Electron
# den Launcher gezielt mit Admin-Rechten neu starten kann.
# ============================================================================

_FILE_ATTRIBUTE_NORMAL = 0x80
_FILE_ATTRIBUTE_READONLY = 0x01

# Prozesse die typischerweise Skyrim-Platform-Dateien offen halten, wenn das
# Spiel abgestuerzt ist oder der Launcher nach einem Crash direkt wieder
# aufgemacht wird. Reihenfolge: erst die Helper (damit CEF den Renderer
# nicht neu forkt), dann SKSE/SkyrimSE selbst.
_SKYRIM_LOCK_PROCESSES = (
    "SkyrimPlatformCEF.exe",
    "SkyrimPlatformBrowser.exe",
    "SkyrimPlatformRender.exe",
    "skse64_loader.exe",
    "SkyrimSE.exe",
)


class NeedsElevation(OSError):
    """Wird geworfen, wenn ein Write definitiv nur mit Admin-Rechten klappt.

    Tragt den failenden Pfad fuer eine aussagekraeftige Fehlermeldung.
    """

    def __init__(self, path: Path, original: Optional[BaseException] = None):
        msg = (
            f"Schreibzugriff auf {path} verweigert. Der Launcher muss mit "
            f"Administrator-Rechten neu gestartet werden."
        )
        super().__init__(errno.EACCES, msg)
        self.path = str(path)
        self.original = original


def _is_elevated() -> bool:
    """True, wenn der aktuelle Prozess als Admin/elevated laeuft."""
    if not _IS_WIN:
        return os.geteuid() == 0  # type: ignore[attr-defined]
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def _path_uac_protected(p: Path) -> bool:
    """Grobe Heuristik: Liegt p unter Program Files/WindowsApps/System32?

    Dort koennen Standard-User nicht schreiben ohne Elevation.
    """
    if not _IS_WIN:
        return False
    try:
        s = str(p.resolve()).lower()
    except Exception:
        s = str(p).lower()
    return any(
        frag in s
        for frag in (
            r"\program files",      # enthaelt auch "program files (x86)"
            r"\windows\system32",
            r"\windowsapps\\",
        )
    )


def _kill_skyrim_processes() -> List[str]:
    """Killt bekannte Skyrim/Platform-Prozesse. Best-effort, silent.

    Gibt die Namen zurueck, bei denen taskkill ein OK (Exitcode 0) meldete —
    nur fuers Logging interessant, nie fuer Flow-Control.
    """
    if not _IS_WIN:
        return []
    killed: List[str] = []
    for name in _SKYRIM_LOCK_PROCESSES:
        try:
            r = subprocess.run(
                ["taskkill", "/F", "/IM", name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=0x08000000,  # CREATE_NO_WINDOW
                timeout=5,
            )
            if r.returncode == 0:
                killed.append(name)
        except Exception:
            continue
    # Kurz warten, damit Windows die File-Handles wirklich freigibt. CEF
    # braucht ein paar Millisekunden zum Aufraeumen nach SIGKILL.
    if killed:
        time.sleep(0.3)
    return killed


def _clear_blocking_attrs(path: Path) -> None:
    """Entfernt ReadOnly/Hidden/System, damit open("wb") nicht scheitert.

    No-op wenn die Datei nicht existiert — das haelt den Caller einfach,
    weil er den Check nicht selber machen muss.
    """
    try:
        if not path.exists():
            return
    except OSError:
        return
    if _IS_WIN:
        try:
            ctypes.windll.kernel32.SetFileAttributesW(
                str(path), _FILE_ATTRIBUTE_NORMAL
            )
            return
        except Exception:
            pass
    try:
        os.chmod(str(path), stat.S_IWRITE | stat.S_IREAD)
    except Exception:
        pass


def _is_permission_error(exc: BaseException) -> bool:
    """Python wirft bei Windows-Sharing-Violations manchmal PermissionError,
    manchmal OSError mit winerror=32. Beides soll als 'retryable' gelten."""
    if isinstance(exc, PermissionError):
        return True
    if isinstance(exc, OSError):
        win = getattr(exc, "winerror", None)
        if win in (5, 32, 33):  # ACCESS_DENIED, SHARING_VIOLATION, LOCK_VIOLATION
            return True
        if exc.errno in (errno.EACCES, errno.EPERM):
            return True
    return False


def _robust_write(dest: Path, writer_fn: Callable[[Any], None]) -> None:
    """Oeffnet `dest` fuer binary-write und ruft writer_fn(handle) auf.

    Strategie gegen Windows-Permission-/Lock-Zicken:
      1) Direkt oeffnen + schreiben.
      2) Bei Fail: Attribute clearen, kurz warten, retry (5x exponential).
      3) Wenn immer noch blockiert: Ziel aus dem Weg umbenennen
         (`<file>.old-<ts>`) und frisch neu anlegen. Unter Windows klappt
         MoveFile oft auch wenn die Datei geoeffnet ist, weil nur der
         Open-Handle gehalten wird — nicht der Directory-Slot.
      4) Wenn auch das failt: Temp-Datei im selben Verzeichnis schreiben und
         per os.replace() atomic druebermoven (funktioniert auf dem gleichen
         Volume ohne Schreibrecht auf die Ziel-Datei, solange wir
         Verzeichnis-Schreibrecht haben).
      5) Wenn alles scheitert und wir NICHT elevated sind -> NeedsElevation.
         Wenn wir elevated sind und trotzdem nix geht -> original-Fehler raus.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)

    def _attempt(path: Path) -> None:
        _clear_blocking_attrs(path)
        with open(path, "wb") as dst:
            writer_fn(dst)

    last_err: Optional[BaseException] = None

    # 1+2) Direkt schreiben mit Retry (0.1, 0.2, 0.4, 0.8, 1.6 Sekunden).
    for attempt in range(5):
        try:
            _attempt(dest)
            return
        except (PermissionError, OSError) as e:
            if not _is_permission_error(e):
                raise
            last_err = e
            time.sleep(0.1 * (2 ** attempt))

    # 3) Rename-out-of-way-Fallback. Die alte Datei lassen wir liegen — ein
    # spaeterer Install-Cleanup koennte sie aufsammeln, aber das ist uns
    # hier egal, Hauptsache die neue Datei landet an der richtigen Stelle.
    try:
        if dest.exists():
            ts = int(time.time())
            sidelined = dest.parent / f"{dest.name}.old-{ts}"
            os.replace(str(dest), str(sidelined))
        _attempt(dest)
        return
    except (PermissionError, OSError) as e:
        if _is_permission_error(e):
            last_err = e
        else:
            raise

    # 4) Atomic via Temp-Datei im gleichen Verzeichnis.
    tmp = dest.parent / f".{dest.name}.tmp-{int(time.time()*1000)}"
    try:
        with open(tmp, "wb") as dst:
            writer_fn(dst)
        _clear_blocking_attrs(dest)
        os.replace(str(tmp), str(dest))
        return
    except (PermissionError, OSError) as e:
        try:
            tmp.unlink(missing_ok=True)
        except Exception:
            pass
        if _is_permission_error(e):
            last_err = e
        else:
            raise

    # 5) Game over. Wenn wir nicht elevated sind, geben wir das dem Caller
    # mit, damit Electron die UAC-Elevation anbieten kann.
    if not _is_elevated() and _path_uac_protected(dest):
        raise NeedsElevation(dest, last_err)
    assert last_err is not None
    raise last_err


def _robust_copy_file(src_file: Path, dest: Path) -> None:
    """Robust-Variante von shutil.copy2 — erhaelt mtime/mode wo moeglich."""
    with open(str(src_file), "rb") as s:
        _robust_write(dest, lambda dst: shutil.copyfileobj(s, dst, 1024 * 1024))
    try:
        shutil.copystat(str(src_file), str(dest))
    except Exception:
        # Metadaten sind "nice to have" — wenn wir mtime nicht setzen koennen,
        # ist die Datei trotzdem installiert und funktioniert.
        pass


def _robust_copytree(src_dir: Path, dest_dir: Path) -> None:
    """Robust-Variante von shutil.copytree(dirs_exist_ok=True).

    Walkt den Source-Tree und kopiert jede Datei ueber _robust_copy_file,
    damit wir pro Datei den kompletten Retry-Apparat bekommen.
    """
    src_dir = Path(src_dir)
    dest_dir = Path(dest_dir)
    for root, _dirs, files in os.walk(str(src_dir)):
        rel = Path(root).relative_to(src_dir)
        out_dir = dest_dir / rel
        out_dir.mkdir(parents=True, exist_ok=True)
        for f in files:
            _robust_copy_file(Path(root) / f, out_dir / f)


def _robust_unlink(path: Path) -> bool:
    """Loescht path mit Attribut-Clear + Retry. Gibt True bei Erfolg zurueck."""
    try:
        if not path.exists():
            return True
    except OSError:
        return False
    for attempt in range(3):
        try:
            _clear_blocking_attrs(path)
            path.unlink()
            return True
        except (PermissionError, OSError) as e:
            if not _is_permission_error(e):
                return False
            time.sleep(0.15 * (attempt + 1))
    return False


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
            _robust_copytree(item, dest)
        else:
            _robust_copy_file(item, dest)

    shutil.rmtree(tmp, ignore_errors=True)
    return True


def install_client_dist_from_zip(
    skyrim_dir: Path, zip_path: Path,
    progress_cb=None, status_cb=None,
) -> bool:
    """Extract a client dist zip into the Skyrim directory."""
    if status_cb:
        status_cb("Client-Dateien werden entpackt...")

    # Zombie-Prozesse vor dem Schreiben killen — das ist die haeufigste
    # Ursache fuer "Permission denied" auf SkyrimPlatformCEF.exe(.hidden) &
    # Konsorten: der Spieler hatte Skyrim an, Spiel ist gecrasht, der
    # CEF-Helper haengt noch im Memory und haelt die exe-Datei gelockt.
    _kill_skyrim_processes()

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
            with zf.open(member) as src:
                _robust_write(
                    dest,
                    lambda dst, _src=src: shutil.copyfileobj(_src, dst, 1024 * 1024),
                )

            if progress_cb:
                progress_cb(i + 1, total)

    cleanup_legacy_client_files(skyrim_dir)
    ensure_frosthold_plugins_enabled(skyrim_dir)
    return True


def install_client_dist_from_folder(
    skyrim_dir: Path, source: Path,
    progress_cb=None, status_cb=None,
) -> bool:
    """Copy client dist from a local folder into the Skyrim directory."""
    if status_cb:
        status_cb("Client-Dateien werden kopiert...")

    _kill_skyrim_processes()

    all_files = list(source.rglob("*"))
    files = [f for f in all_files if f.is_file()]
    total = len(files)

    for i, src_file in enumerate(files):
        rel = src_file.relative_to(source)
        dest = skyrim_dir / rel
        _robust_copy_file(src_file, dest)
        if progress_cb:
            progress_cb(i + 1, total)

    cleanup_legacy_client_files(skyrim_dir)
    ensure_frosthold_plugins_enabled(skyrim_dir)
    return True


def install_client_dist_from_url(
    skyrim_dir: Path, url: str,
    progress_cb=None, status_cb=None,
    extract_progress_cb=None,
) -> bool:
    """
    Download a client dist zip from URL and install it.

    progress_cb           -> Download-Fortschritt (bytes_done, bytes_total).
    extract_progress_cb   -> Entpack-Fortschritt (files_done, files_total).
                             Fallback auf progress_cb, wenn nicht gesetzt (legacy).
    status_cb             -> Phasen-Status-Message (str).
    """
    if status_cb:
        status_cb("Client-Distribution wird heruntergeladen...")

    tmp = Path(tempfile.mkdtemp(prefix="frostmp_"))
    zip_path = tmp / "client-dist.zip"
    try:
        download_file(url, zip_path, progress_cb)
        if status_cb:
            status_cb("Client-Dateien werden entpackt...")
        install_client_dist_from_zip(
            skyrim_dir, zip_path,
            extract_progress_cb if extract_progress_cb is not None else progress_cb,
            status_cb,
        )
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
            if p.is_file() and _robust_unlink(p):
                removed.append(rel)
        except OSError:
            pass
    return removed


# Frosthold-eigene Plugins, die in plugins.txt enabled werden muessen, damit
# Skyrim die zugehoerigen Records ueberhaupt laedt. Einfache ESLs ohne Eintrag
# in plugins.txt werden von Skyrim SE/AE stillschweigend ignoriert.
FROSTHOLD_REQUIRED_PLUGINS: List[str] = [
    "FrostholdKeys.esl",
]


def _skyrim_appdata_dir() -> Optional[Path]:
    """Gibt den AppData-Pfad von Skyrim SE zurueck (%LOCALAPPDATA%/Skyrim Special Edition)."""
    base = os.environ.get("LOCALAPPDATA")
    if not base:
        return None
    p = Path(base) / "Skyrim Special Edition"
    return p


def ensure_frosthold_plugins_enabled(skyrim_dir: Path) -> List[str]:
    """Sorgt dafuer, dass unsere Frosthold-ESLs in plugins.txt enabled sind.

    - Kopiert fehlende Plugins NICHT (das macht der ZIP-Install).
    - Prueft: liegt das Plugin in <Data>?
    - Falls ja: stellt sicher, dass "*FrostholdKeys.esl" in der User-plugins.txt
      steht (%LOCALAPPDATA%/Skyrim Special Edition/plugins.txt). Wenn das
      Plugin bereits gelistet, aber disabled (ohne fuehrendes '*'), aktiviert
      es die Zeile.

    Gibt die tatsaechlich ergaenzten/aktivierten Plugin-Dateinamen zurueck.
    """
    changed: List[str] = []
    appdata = _skyrim_appdata_dir()
    if not appdata:
        return changed

    data_dir = skyrim_dir / "Data"
    plug_txt = appdata / "plugins.txt"

    try:
        lines: List[str] = []
        if plug_txt.is_file():
            # plugins.txt wird von Skyrim in UTF-16 LE geschrieben, neuere
            # Versionen auch mal UTF-8 mit BOM. Wir lesen tolerant und
            # schreiben zurueck im gelesenen Format, um den Loader nicht zu
            # verunsichern.
            raw = plug_txt.read_bytes()
            try:
                if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff"):
                    text = raw.decode("utf-16")
                    encoding = "utf-16"
                elif raw.startswith(b"\xef\xbb\xbf"):
                    text = raw.decode("utf-8-sig")
                    encoding = "utf-8-sig"
                else:
                    text = raw.decode("utf-8", errors="replace")
                    encoding = "utf-8"
            except UnicodeDecodeError:
                text = raw.decode("latin-1")
                encoding = "utf-8"
            lines = text.splitlines()
        else:
            encoding = "utf-8"
            plug_txt.parent.mkdir(parents=True, exist_ok=True)

        mutated = False
        for plugin in FROSTHOLD_REQUIRED_PLUGINS:
            if not (data_dir / plugin).is_file():
                continue
            target = plugin.lower()

            found_idx = -1
            for idx, ln in enumerate(lines):
                stripped = ln.strip()
                key = stripped.lstrip("*").strip().lower()
                if key == target:
                    found_idx = idx
                    break

            if found_idx < 0:
                lines.append(f"*{plugin}")
                changed.append(plugin)
                mutated = True
            else:
                ln = lines[found_idx].strip()
                if not ln.startswith("*"):
                    lines[found_idx] = f"*{plugin}"
                    changed.append(plugin)
                    mutated = True

        if mutated:
            new_text = "\r\n".join(lines)
            if not new_text.endswith("\r\n"):
                new_text += "\r\n"
            if encoding == "utf-16":
                plug_txt.write_bytes(b"\xff\xfe" + new_text.encode("utf-16-le"))
            elif encoding == "utf-8-sig":
                plug_txt.write_bytes(b"\xef\xbb\xbf" + new_text.encode("utf-8"))
            else:
                plug_txt.write_bytes(new_text.encode("utf-8"))
    except OSError:
        # plugins.txt nicht schreibbar -> still weitermachen, der Spieler kann
        # das Plugin notfalls manuell aktivieren.
        pass
    return changed


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
    # Wenn der Launcher eine explizite HTTP-URL fuer den chat-server kennt,
    # reichen wir sie mit durch. Sonst leitet der Client sie aus der WS-URL ab
    # (Port +1, siehe frostholdChatService.deriveHttpUrlFromWs).
    http = (cfg.get("frosthold_chat_http_url") or "").strip()
    if http:
        out["frosthold-chat-http-url"] = http
    uid = (cfg.get("frosthold_chat_user_id") or "").strip()
    if uid:
        out["frosthold-chat-user-id"] = uid
    sec = (cfg.get("frosthold_chat_secret") or "").strip()
    if sec:
        out["frosthold-chat-secret"] = sec
    return out


def _read_launcher_discord_id_from_session() -> Optional[str]:
    """
    Liest die Discord-ID aus der vom Electron-Launcher gepflegten
    discord-session.json. Diese Datei liegt in %APPDATA%/frostholdrp-launcher
    (Electron userData) und wird nach erfolgreichem OAuth2-Login geschrieben
    (vgl. main.js: saveDiscordSession).

    Wird als Fallback genutzt, wenn der User `frosthold_admin_discord_id` nicht
    manuell in frostmp-launcher.json gesetzt hat — Policy des GM-Panels ist
    kein Passwort/Discord-Prompt, also mappen wir die bereits verifizierte
    Login-Identitaet automatisch auf den AdminService-Discord-Kontext.
    """
    candidates: List[Path] = []
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidates.append(Path(appdata) / "frostholdrp-launcher" / "discord-session.json")
        candidates.append(Path(appdata) / "FrostholdRP Launcher" / "discord-session.json")
    for p in candidates:
        try:
            if p.is_file():
                data = json.loads(p.read_text(encoding="utf-8"))
                did = str(data.get("discordId") or "").strip()
                if did:
                    return did
        except Exception:
            continue
    return None


def _frosthold_admin_keys_for_client_settings(cfg: dict, server_ip: str) -> Dict[str, Any]:
    """
    AdminService (frostmp-client) liest unter sp.settings['frostmp-client']
    den Block 'frostholdAdmin' mit host/port/discordId, um die Admin-API des
    Servers zu kontaktieren. Wenn der Launcher nichts konfiguriert hat, setzen
    wir als Default den Haupt-Server-IP + den Standard-Port 3214 (wie auch
    im Server-Addon frosthold-admin.cjs als Default konfiguriert). Ohne
    diese Werte fiele die Admin-Panel-UI auf "127.0.0.1:3214" zurueck, was
    aus Skyrim heraus ins Leere fetchen wuerde.

    Fuer die discordId gilt: explizite Einstellung in frostmp-launcher.json
    (`frosthold_admin_discord_id`) hat Vorrang. Sonst uebernehmen wir die
    Discord-ID aus der vom Launcher schon verifizierten OAuth-Session
    (discord-session.json). Damit oeffnet sich das GM-Panel bei F10 fuer
    whitelisted Admins automatisch, ohne dass der User irgendwo eine ID
    eintippen muss.
    """
    host = (cfg.get("frosthold_admin_host") or "").strip() or server_ip
    try:
        port = int(cfg.get("frosthold_admin_port") or 0) or 3214
    except (TypeError, ValueError):
        port = 3214
    discord_id = (cfg.get("frosthold_admin_discord_id") or "").strip() or None
    if not discord_id:
        discord_id = _read_launcher_discord_id_from_session()
    block: Dict[str, Any] = {"host": host, "port": port}
    if discord_id:
        block["discordId"] = discord_id
    return {"frostholdAdmin": block}


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
    settings.update(_frosthold_admin_keys_for_client_settings(cfg, server_ip))
    path = get_settings_path(skyrim_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(settings, indent=2), encoding="utf-8")
    # SkyrimPlatform-Installationen haben teilweise einen zweiten Plugins-
    # Ordner direkt unter <SkyrimSE>/Platform/Plugins (neben dem kanonischen
    # Data/Platform/Plugins). Damit alte Installationen nicht auf einem
    # Mini-Stub haengenbleiben und frostmp-client die Settings eindeutig
    # findet, spiegeln wir die Datei bei Existenz des Alt-Ordners.
    alt_dir = skyrim_dir / "Platform" / "Plugins"
    if alt_dir.is_dir():
        try:
            (alt_dir / path.name).write_text(
                json.dumps(settings, indent=2), encoding="utf-8"
            )
        except OSError:
            pass
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



def _install_client_files_sync(
    skyrim_dir: Path,
    client_dist_url: str,
    download_progress_cb=None,
    extract_progress_cb=None,
    status_cb=None,
) -> None:
    """Install Skyrim Platform / client without GUI (for Electron)."""
    url = client_dist_url.strip()
    if url and (url.startswith("http://") or url.startswith("https://")):
        install_client_dist_from_url(
            skyrim_dir, url,
            progress_cb=download_progress_cb,
            status_cb=status_cb,
            extract_progress_cb=extract_progress_cb,
        )
        return
    if url and Path(url).exists():
        p = Path(url)
        if p.is_file() and p.suffix.lower() == ".zip":
            install_client_dist_from_zip(
                skyrim_dir, p,
                progress_cb=extract_progress_cb,
                status_cb=status_cb,
            )
            return
        if p.is_dir():
            install_client_dist_from_folder(
                skyrim_dir, p,
                progress_cb=extract_progress_cb,
                status_cb=status_cb,
            )
            return
    raise RuntimeError(
        "Keine gueltige Client-Distribution. URL, ZIP oder Ordner in den Einstellungen angeben."
    )


def _install_missing_components(
    cfg: dict, skyrim_dir: Path, client_src: str
) -> Tuple[bool, Optional[str], Optional[str], Optional[Dict[str, Any]]]:
    """
    Returns (success, error_code, message, extras).

    error_code: z.B. client_dist_required, install_failed, needs_elevation.
    extras: optionales Dict mit Zusatz-Info (z.B. failender Pfad bei
    needs_elevation) fuer die Electron-Seite.
    """

    def _wrap_install_err(exc: BaseException) -> Tuple[bool, str, str, Optional[Dict[str, Any]]]:
        # NeedsElevation soll Electron NICHT als generischer Stacktrace
        # erreichen — dann koennen wir den Launcher gezielt neu starten.
        if isinstance(exc, NeedsElevation):
            return False, "needs_elevation", str(exc), {"path": exc.path}
        return False, "install_failed", str(exc), None

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
                _install_client_files_sync(
                    skyrim_dir, client_src,
                    download_progress_cb=_make_progress_emitter(
                        "client_download", "FrostMP-Client wird heruntergeladen"
                    ),
                    extract_progress_cb=_make_progress_emitter(
                        "client_extract", "FrostMP-Client wird entpackt"
                    ),
                    status_cb=_make_status_emitter("client"),
                )
                new_fp = http_head_fingerprint(client_src) or remote_fp
                patch: Dict[str, Any] = {"client_force_update_once": False}
                if new_fp:
                    patch["client_dist_remote_fp"] = new_fp
                save_config(patch)
            except Exception as e:
                return _wrap_install_err(e)
            return True, None, None, None

        if remote_fp and stored_fp and remote_fp != stored_fp:
            try:
                _install_client_files_sync(
                    skyrim_dir, client_src,
                    download_progress_cb=_make_progress_emitter(
                        "client_download", "Update: FrostMP-Client wird heruntergeladen"
                    ),
                    extract_progress_cb=_make_progress_emitter(
                        "client_extract", "Update: FrostMP-Client wird entpackt"
                    ),
                    status_cb=_make_status_emitter("client"),
                )
                new_fp = http_head_fingerprint(client_src) or remote_fp
                if new_fp:
                    save_config({"client_dist_remote_fp": new_fp})
            except Exception as e:
                return _wrap_install_err(e)
            return True, None, None, None

        # Erstes Mal mit dieser Logik: Fingerprint speichern ohne erneuten Download
        if remote_fp and not stored_fp:
            save_config({"client_dist_remote_fp": remote_fp})

        return True, None, None, None

    if not missing:
        return True, None, None, None

    needs_skse = any(c.name == "SKSE64" and not c.installed for c in missing)
    needs_client = any(
        c.name in ("Skyrim Platform", "FrostMP Client", "Address Library (NG)")
        and not c.installed
        for c in missing
    )
    needs_vcredist = any(c.name == "VC++ Redistributable" and not c.installed for c in missing)
    if needs_client and not client_src:
        return False, "client_dist_required", (
            "Keine Client-Download-Quelle. Lege frosthold-client-dist.url (eine Zeile URL) "
            "neben FrostMP-Launcher.py an oder setze FROSTHOLD_CLIENT_DIST_URL."
        ), None

    try:
        if needs_vcredist:
            _emit_status("vcredist", "Visual C++ 2015-2022 Redistributable wird installiert...")
            install_vc_redist()
        if needs_skse:
            install_skse(
                skyrim_dir,
                progress_cb=_make_progress_emitter("skse_download", "SKSE wird heruntergeladen"),
                status_cb=_make_status_emitter("skse"),
            )
        if needs_client:
            _install_client_files_sync(
                skyrim_dir, client_src,
                download_progress_cb=_make_progress_emitter(
                    "client_download", "FrostMP-Client wird heruntergeladen"
                ),
                extract_progress_cb=_make_progress_emitter(
                    "client_extract", "FrostMP-Client wird entpackt"
                ),
                status_cb=_make_status_emitter("client"),
            )
            if _is_http_url(client_src):
                new_fp = http_head_fingerprint(client_src)
                if new_fp:
                    save_config({"client_dist_remote_fp": new_fp})
    except Exception as e:
        return _wrap_install_err(e)

    components = check_all_components(skyrim_dir)
    still = [c.name for c in components if not c.installed]
    if still:
        return False, "install_incomplete", ", ".join(still), None
    return True, None, None, None


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
    # profile_id kommt ausschliesslich aus dem Discord-OAuth-Flow (Chat-Server).
    # Fehlt er oder ist <1, blockieren wir jede Aktion und verweisen den User auf
    # den Discord-Login-Button im Launcher.
    try:
        profile_id = int(cfg.get("profile_id", 0))
    except (TypeError, ValueError):
        profile_id = 0
    if profile_id < 1:
        return {
            "ok": False,
            "error": "login_required",
            "message": (
                "Bitte erst mit Discord anmelden. Ohne Login bekommst du keinen"
                " eigenen Charakter-Slot und kannst nicht spielen."
            ),
            "ready_to_play": False,
        }

    skyrim_dir = resolve_skyrim_dir(cfg)
    if skyrim_dir is None:
        return {
            "ok": False,
            "error": "skyrim_not_found",
            "message": "Skyrim SE wurde nicht gefunden. Installation über Steam prüfen oder Pfad in den Einstellungen.",
            "ready_to_play": False,
        }

    client_src = get_effective_client_dist(cfg)
    ok, err, msg, extras = _install_missing_components(cfg, skyrim_dir, client_src)
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
        if err == "needs_elevation" and extras:
            out["path"] = extras.get("path")
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
    # profile_id kommt ausschliesslich aus dem Discord-OAuth-Flow (Chat-Server).
    # Fehlt er oder ist <1, blockieren wir den Spielstart -> User muss erst
    # ueber den Discord-Login-Button im Launcher authentifizieren.
    try:
        profile_id = int(cfg.get("profile_id", 0))
    except (TypeError, ValueError):
        profile_id = 0
    if profile_id < 1:
        return {
            "ok": False,
            "error": "login_required",
            "message": (
                "Bitte erst mit Discord anmelden. Ohne Login bekommst du keinen"
                " eigenen Charakter-Slot und kannst nicht spielen."
            ),
        }

    skyrim_dir = resolve_skyrim_dir(cfg)
    if skyrim_dir is None:
        return {"ok": False, "error": "skyrim_not_found", "message": "Skyrim SE wurde nicht gefunden. Pfad in den Einstellungen setzen."}

    client_src = get_effective_client_dist(cfg)
    ok, err, msg, extras = _install_missing_components(cfg, skyrim_dir, client_src)
    if not ok:
        out: Dict[str, Any] = {"ok": False, "error": err, "message": msg}
        if err == "client_dist_required":
            comps = check_all_components(skyrim_dir)
            out["missing"] = [c.name for c in comps if not c.installed]
        if err == "needs_elevation" and extras:
            out["path"] = extras.get("path")
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
