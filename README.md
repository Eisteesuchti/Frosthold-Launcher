# Frosthold Server & Launcher

**Launcher-Repository (dieses Repo):** [Frosthold-Launcher](https://github.com/Eisteesuchti/Frosthold-Launcher)

**Chat & MP-Stack:** [Frosthold-Server](https://github.com/Eisteesuchti/Frosthold-Server) — dort liegt `chat-server/` (Node-WebSocket-Chat mit Discord-OAuth).

Dieses Repository enthält unter anderem:

- **`FrostholdRP-Launcher/`** — Electron-Launcher (NSIS/Portable, gebündelte Python-Runtime)
- **`FrostMP-Launcher.py`**, **`frostmp_core.py`**, **`frostmp_gui.py`** — Steuerung/Download-Logik für den Launcher

Das Skyrim-Multiplayer-Setup baut auf **SkyMP** auf ([Repository](https://github.com/skyrim-multiplayer/skymp)); FrostholdRP pflegt Launcher und Konfiguration separat.

## Chat-Server (nur noch Repo Frosthold-Server)

**Lokal bleibt alles wie bei dir:** Workspace `…\Frosthold Server\` mit **`FrostholdRP-Launcher/`**, **`Frosthold/`** und **`chat-server/`** — du arbeitest weiter genau in diesem Ordner.

**Nur die Git-Zuordnung:** Änderungen am Chat sollen **nicht** ins Repo **Frosthold-Launcher** (dieses Repo), sondern ins **[Frosthold-Server](https://github.com/Eisteesuchti/Frosthold-Server)**. Dafür ist `chat-server/` hier per **`.gitignore`** vom Launcher-Repo ausgeschlossen — der Launcher „sieht“ den Chat-Ordner beim Commit nicht.

**Empfohlen (ein Pfad, richtiges Remote):** **`Frosthold-Server`** einmal klonen (z. B. `…\Programmieren Ordner\Frosthold-Server\`), dann unter Windows die **Junction** legen, damit `…\Frosthold Server\chat-server` physisch derselbe Ordner wie `…\Frosthold-Server\chat-server` ist:

1. `config.json` (und ggf. `node_modules`) aus dem alten `chat-server` sichern.
2. Den bisherigen Ordner `Frosthold Server\chat-server` löschen (nur wenn leer/ersetzbar).
3. Als Administrator in **cmd**:  
   `mklink /J "C:\Users\Danie\Desktop\Programmieren Ordner\Frosthold Server\chat-server" "C:\Users\Danie\Desktop\Programmieren Ordner\Frosthold-Server\chat-server"`  
   (Zielpfad anpassen, wo dein **Frosthold-Server**-Klon liegt.)

Danach öffnest du in Cursor weiterhin `…\Frosthold Server\chat-server\…` — `git pull` / `git push` im Terminal **aus diesem Ordner** nutzen den aufgelösten Pfad und landen im **Frosthold-Server**-Repository.

**Auf dem Hetzner:** im Klon von **Frosthold-Server** `git pull`, Chat neu starten (`pm2 restart …`), falls der Prozess noch auf einen alten Pfad zeigt.
