"""Tkinter-GUI — nur bei direktem Start ohne --json-*."""

import subprocess
import threading
from pathlib import Path
from typing import Dict, List

from frostmp_core import *
import tkinter as tk
from tkinter import ttk, messagebox, filedialog


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

        # Write connection settings (inkl. optional Frosthold-Chat aus frostmp-launcher.json)
        write_client_settings(skyrim_dir, server_ip, DEFAULT_PORT, profile_id, load_config())

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


def run_app() -> None:
    app = FrostMPLauncher()
    app.mainloop()
