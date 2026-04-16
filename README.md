# Frosthold Server & Launcher

**Launcher-Repository (dieses Repo):** [Frosthold-Launcher](https://github.com/Eisteesuchti/Frosthold-Launcher)

**Chat & MP-Stack:** [Frosthold-Server](https://github.com/Eisteesuchti/Frosthold-Server) — dort liegt `chat-server/` (Node-WebSocket-Chat mit Discord-OAuth).

Dieses Repository enthält unter anderem:

- **`FrostholdRP-Launcher/`** — Electron-Launcher (NSIS/Portable, gebündelte Python-Runtime)
- **`FrostMP-Launcher.py`**, **`frostmp_core.py`**, **`frostmp_gui.py`** — Steuerung/Download-Logik für den Launcher

Das Skyrim-Multiplayer-Setup baut auf **SkyMP** auf ([Repository](https://github.com/skyrim-multiplayer/skymp)); FrostholdRP pflegt Launcher und Konfiguration separat.

## Chat-Server weiterentwickeln (nur noch Repo Frosthold-Server)

Der Ordner `chat-server/` in diesem Workspace ist **gitignored** — er taucht **nicht** im Launcher-Repo auf. Änderungen am Chat gehören ausschließlich ins **[Frosthold-Server](https://github.com/Eisteesuchti/Frosthold-Server)**-Repository.

**Lokal wie bisher arbeiten:**

1. **`Frosthold-Server`** einmal klonen (eigener Ordner, z. B. neben diesem Projekt):  
   `git clone https://github.com/Eisteesuchti/Frosthold-Server.git`
2. Im Klon unter **`chat-server/`** editieren (`server.mjs`, `roles.mjs`, …), dort **`git add` / `commit` / `push`** zu `origin` (Branch `main`).
3. Optional: dieselbe `config.json` wie auf dem VPS in **`chat-server/config.json`** legen (liegt bei **Frosthold-Server** in `.gitignore`, wird nicht committed).

**Auf dem Hetzner:** im Klon von **`Frosthold-Server`** `git pull`, dann Chat neu starten (`pm2 restart …`).

**Optional ein Fenster:** Ordner-Verknüpfung (Junction) von diesem Workspace `chat-server` auf `…\Frosthold-Server\chat-server` — dann öffnest du hier weiter den gleichen Pfad, bearbeitest aber die Dateien im Server-Repo (Push immer aus dem **Frosthold-Server**-Klon heraus).
