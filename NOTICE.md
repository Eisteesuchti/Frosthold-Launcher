# NOTICE — Drittanbieter-Komponenten in FrostMP / FrostholdRP

FrostMP ist die Eigenmarke der **FrostholdRP-Community** für unseren
Skyrim-Multiplayer-Stack. Die Marke und alles, was wir selbst geschrieben
haben (Launcher, Chat-Server, Client-Bridge, Gamemode-Skripte) gehören
FrostholdRP. Das eigentliche Multiplayer-Fundament basiert aber auf einer
Reihe großartiger Open-Source-Projekte, die hier ausdrücklich gewürdigt
werden.

> Diese Datei erfüllt unsere Pflichten aus den GPL-3.0/MIT/BSD-Lizenzen der
> verwendeten Komponenten und macht transparent, woher der Code stammt.

---

## SkyMP

- **Projekt:** [skymp / skymp](https://github.com/skymp/skymp)
- **Lizenz:** GNU General Public License v3.0 (GPL-3.0)
- **Verwendung:** FrostMP entstand als Fork-/Custom-Build-Pipeline auf Basis
  des SkyMP-Stacks. Der `frostmp-client.js` und die Gamemode-Anbindung
  enthalten direkt von SkyMP abgeleiteten Code (`skymp5-client`,
  `skymp5-server`, `skymp5-front`, `skymp5-functions-lib`,
  `skymp5-server-addons`, `skymp5-scripts`).
- **Konsequenz:** Sämtliche von uns ausgelieferten, von SkyMP abgeleiteten
  Binaries (insbesondere `frostmp-client.js`) stehen ebenfalls unter
  GPL-3.0.
- **Hinweis:** Unser eigener Chat-/Auth-/Bridge-Server ist eigenständiger
  Node.js-Code, kommuniziert mit dem SkyMP-Gamemode nur über Netzwerk-APIs
  und ist damit kein abgeleitetes Werk im Sinne der GPL-3.0. Er wird nicht
  an Spieler ausgeliefert und liegt in einem eigenen (nicht-öffentlichen)
  Repository.

Großen Dank an **Pospelov & alle SkyMP-Contributors**.

## Skyrim Platform

- **Projekt:** Bestandteil des SkyMP-Repositorys (`skyrim-platform/`)
- **Lizenz:** GPL-3.0
- **Verwendung:** Skyrim Platform stellt die Brücke zwischen Skyrim SE/AE
  (SKSE) und unserem JavaScript-Plugin her. Ohne Skyrim Platform kein
  FrostMP-Client.

## Tilted Online (libhelpers / TiltedOnline)

- **Projekt:** [tiltedphoques/TiltedOnline](https://github.com/tiltedphoques/TiltedOnline)
- **Lizenz:** GPL-3.0
- **Verwendung:** Bestandteile aus `tilted/` werden indirekt über
  Skyrim Platform genutzt.

## Chromium Embedded Framework (CEF)

- **Projekt:** [Chromium Embedded Framework](https://bitbucket.org/chromiumembedded/cef)
- **Lizenz:** New BSD License (3-clause)
- **Verwendung:** Skyrim Platform bringt einen eingebetteten Chromium-Browser
  mit, in dem das Frosthold-Chat-UI läuft. Wir liefern die CEF-Runtime
  unverändert mit `Data/Platform/Distribution/CEF/...` aus.

## Skyrim Script Extender (SKSE64)

- **Projekt:** [SKSE64 — silverlock.org](https://skse.silverlock.org/)
- **Lizenz:** SKSE64 License — Redistribution erlaubt, kein kommerzieller
  Vertrieb.
- **Verwendung:** Der FrostholdRP-Launcher lädt SKSE64 direkt von
  silverlock.org herunter und entpackt es in die Skyrim-Installation des
  Spielers. Wir vertreiben SKSE64 **nicht** weiter — der Spieler holt sich
  das offizielle Archiv selbst.

## Bethesda / The Elder Scrolls V: Skyrim

FrostMP setzt eine legal erworbene Kopie von **The Elder Scrolls V: Skyrim
Special Edition** voraus. *Skyrim*, das Logo und alle Marken gehören
**Bethesda Game Studios / ZeniMax Media Inc.** FrostMP ist ein
nicht-kommerzielles, fan-erstelltes Multiplayer-Projekt und ist weder von
Bethesda autorisiert noch mit Bethesda verbunden.

## Weitere Bibliotheken

| Bibliothek | Lizenz | Zweck |
|---|---|---|
| Node.js / npm-Pakete | jeweilige (MIT, BSD, …) | Launcher-Server-Side, Lizenzen bei den jeweiligen Paketen im `node_modules/*/LICENSE` |
| Electron | MIT | FrostholdRP-Launcher |
| electron-builder | MIT | Installer-Build |
| Python 3 (Embeddable) | PSF License | Launcher-Backend |

---

## Deine Rechte als Spieler

- Du bekommst den FrostMP-Client als GPL-3.0-Software. Quellcode,
  Modifikationen und das Recht zur Weitergabe garantiert dir die GPL.
- Quellen unseres Wrapper-Codes:
  - [Eisteesuchti/Frosthold-Server](https://github.com/Eisteesuchti/Frosthold-Server) — FrostMP-SkyMP-Fork (GPL-3.0), Build-Tools, Doku
  - [Eisteesuchti/Frosthold-Launcher](https://github.com/Eisteesuchti/Frosthold-Launcher) — Electron-Launcher

Wenn du eine vollständige Kopie der GPL-3.0 brauchst: liegt im Repo unter
`Frosthold/skymp5-client/LICENSE` (identisch in den anderen `skymp5-*`
Unterordnern und `skyrim-platform/LICENSE`).
