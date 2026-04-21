# Frosthold Backlog / Zukunfts-Features

Dieses Dokument sammelt Features und Ideen, die aktuell **noch nicht** umgesetzt
werden, aber später kommen sollen. Wenn ein Eintrag in Arbeit geht, wandert er
heraus in einen aktiven To-Do-Plan.

---

## Später geplant

### React-Login-UI mit Discord-Anbindung *(weitaus später)*
**Kontext:** Der Original-SkyMP-Tree (`skymp-main/skymp5-front`) liefert eine
fertige React-App mit Skyrim-themed Components (`SkyrimFrame`, `SkyrimInput`,
`SkyrimButton`, `SkyrimHint`, `SkyrimSlider`) und passenden SVG-Assets
(`button.svg`, `chat_corner.svg`, `hint.svg`, Skyrim-Hintergrund etc.).

**Ziel:**
- Eine **Login/Registrierungs-UI** die erscheint **bevor** man auf den Server
  connected (nicht erst im Spiel über Chat-Commands).
- Beim Einloggen wird geprüft, ob der Nutzer bereits im Frosthold-Discord ist.
  Wer nicht drin ist, bekommt den Invite-Link direkt angeboten und wird nach
  dem Beitritt automatisch durchgelassen.
- Visual-Stil: Skyrim-authentisch, wie die SkyMP-Front-Vorlage — aber deutsch.

**Mögliche Bausteine:**
- `skymp5-front`-Komponenten als Basis portieren/adaptieren.
- Discord-OAuth2-Flow (Guild-Mitgliedschaft via `/users/@me/guilds` prüfen).
- Im Launcher oder als separates Fenster vor dem eigentlichen Spielstart.

**Status:** Idee vorgemerkt. Kommt später, Umfang noch nicht geschätzt.

---

## Unter Beobachtung (noch nicht entschieden)

### Voicechat
Im Original-SkyMP **nicht enthalten** (`viet`-Ordner ist nur eine C++-Util-Lib,
kein Voicechat). Müsste komplett neu gebaut werden, z.B. mit Mumble-Link,
einem eigenen WebRTC-Voice-Server oder einer existierenden Discord-Integration.
Aktuell kein aktives Thema.

---

## Pläne zur Abnahme (aktiv diskutiert)

### Persistentes Inventar + Discord-Token-Refresh

**Stand der Technik (Ist-Zustand):**

- **Inventar:** `skymp5-server` speichert bereits ChangeForms als JSON-Dateien in
  `changeForms/`. Jede Mutation (`EditChangeForm` → `RequestSave` →
  `AsyncSaveStorage.Upsert`) landet zeitnah auf der Platte. Persistenz an sich
  ist also vorhanden. Die Zuordnung läuft über `profileId`, der aus der
  Discord-ID deterministisch abgeleitet wird (`deriveProfileId(discordId)`
  im chat-server).
- **Discord-Token:** Der Launcher führt `exchangeCodeWithChatServer(code)` aus
  und bekommt einen `sessionToken` (30-Tage-TTL) zurück. Dieser wird in
  `discord-session.json` und `frostmp-launcher.json` gespeichert. Refresh-Tokens
  von Discord werden **nicht** angefordert — der Launcher nutzt den eigenen
  `sessionToken`, der per `GET /auth/session?token=...` validiert wird.

**Vermutetes Problem:**

1. Inventar scheint bei Relog zu verschwinden → die Actor-Form wird
   wahrscheinlich bei jedem Login **neu** angelegt, statt die gespeicherte
   ChangeForm mit der bestehenden `profileId` zu laden. Oder: `CreateActor`
   bekommt keinen konsistenten `userProfileId`.
2. Discord-Token muss jedes Mal neu → wahrscheinlich wird der gespeicherte
   `sessionToken` entweder nicht gelesen, fällt beim `refreshSession`-Check
   durch, oder wird frühzeitig invalidiert (z. B. bei jeder Launcher-
   Neuinstallation).

**Vorgeschlagenes Vorgehen (2 Phasen):**

**Phase A — Diagnose (kein Code, nur lesen + loggen):**

1. Launcher (`FrostholdRP-Launcher/main.js`) temporär mit zusätzlichen Logs
   versehen: Bei jedem Start loggen, ob `discord-session.json` existiert,
   welcher `sessionToken` drinsteht, und was `refreshSessionFromChatServer`
   zurückgibt. So sehen wir, ob der Token überhaupt wiederverwendet oder ob
   jedes Mal der OAuth-Flow getriggert wird.
2. skymp5-server (`ScampServer.cpp` ~L586–616) loggen bei `CreateActor`:
   Wird derselbe `profileId` wiederverwendet bei Relog? Findet der Server
   die gespeicherte ChangeForm?
3. `changeForms/` auf dem VPS anschauen: Gibt es persistente JSON-Files pro
   Spieler, und zeigen die Mutations-Timestamps, dass Inventar-Events
   überhaupt ankommen?

**Phase B — Fixes (nach Diagnose-Ergebnis):**

Mögliche Maßnahmen, je nachdem was Phase A findet:
- **Token-Seite:** Launcher so fixen, dass `refreshSessionFromChatServer` beim
  Start zuerst probiert wird und der OAuth-Flow nur fällt wenn der Server mit
  `session_not_found` antwortet. Evtl. Session-TTL serverseitig verlängern
  (z. B. von 30 auf 90 Tagen) oder Auto-Renew einbauen: bei erfolgreichem
  `GET /auth/session` wird `expiresAt` um 30 Tage nach vorn geschoben.
- **Inventar-Seite:** An der Stelle, wo der Server eine neue Actor-Form für
  einen einloggenden Spieler erzeugt, muss zuerst geprüft werden, ob bereits
  eine ChangeForm mit passender `profileId` existiert. Wenn ja: diese Form
  wiederverwenden statt neu spawnen. Dafür gibt es in `skymp5-server` eine
  `FindOrCreateActor(profileId)`-artige Logik, oder wir legen sie an.

**Aufwand:**
- Diagnose (Phase A): ~1 Stunde mit Live-Zugriff auf Server + Launcher-Logs.
- Fix-Implementation: 2–6 Stunden, je nachdem wie tief im skymp5-server C++-
  Code eingegriffen werden muss.

**Risiken:**
- skymp5-server ist C++, ein Fehler hier ist potenziell destruktiv für alle
  gespeicherten Spieler-Daten. Unbedingt **Backup von `changeForms/`** vor
  jedem Deployment.

---

### Permanentes Fix für Kompass-Menü vs. Vanilla-TweenMenu

**Ist-Zustand:**

`mainMenuService.ts` hängt an `queryKeyCodeBindings`, blockt TAB per
`disablePlayerControls(abMenu=true)` + schickt notfalls `Input.tapKey(Tab)`
nach, um das doch geöffnete TweenMenu wieder zu schließen. Dazu 450ms Debounce
+ Generation-Counter + Post-Open-Polling über 8 Frames.

Das ist eine **reaktive** Lösung — jeder Schritt kann racen. Es gibt **kein**
SKSE-Plugin im Frosthold-Repo.

**Drei Lösungsoptionen (aufsteigend im Aufwand):**

#### Option A — ControlMap-Override *(~30 Minuten)*

Modifizierte `Data/Interface/Controls/PC/controlmap.txt` ausrollen, die den
TAB-Bind für TweenMenu komplett entfernt. Skyrim lädt dann beim Start unseren
Override; TAB wird zu einer freien Taste, die nur SkyrimPlatform bekommt. Kein
Race möglich, weil die Engine TAB gar nicht mehr an TweenMenu weiterreicht.

**Risiken:** ControlMap steuert auch andere UIs (Inventar-Tabs, Journal-Tabs
intern per TAB-Cycle). Entfernen-oder-Remap muss getestet werden, um nicht
versehentlich Inventar-Navigation zu killen.

**Rollout:** Entweder als Teil der Client-ZIP (schon jetzt über Launcher
verteilt) oder als optionaler Mod-Eintrag.

#### Option B — Papyrus-Script mit OnMenuOpenCloseEvent *(~2-3 Stunden)*

Kleines Papyrus-Quest-Script in einem eigenen Frosthold.esp, das
`RegisterForMenu("TweenMenu")` macht und im `OnMenuOpen`-Event sofort
`UI.Invoke(TweenMenu, "_root.Close")` aufruft — sobald die Frosthold-Variable
„Kompass offen" gesetzt ist. Papyrus läuft im Game-Thread, reagiert
deterministischer als SkyrimPlatform-JS.

**Risiken:** Papyrus-Events haben ~20ms Latenz → TweenMenu flackert kurz auf.
Zusätzlich braucht man eine SyncVariable zwischen SkyrimPlatform-JS und
Papyrus (via `Debug.Trace` + Reader-Script oder globale Form-Variable).

#### Option C — Eigenes SKSE-Plugin *(1-2 Tage)*

CommonLibSSE-NG-basiertes C++-Plugin, das `RE::UIMessageQueue::AddMessage`
oder `UI::IsMenuOpen("TweenMenu")` hookt. Wenn die Frosthold-Kompass-Flag
gesetzt ist, wird das TweenMenu-AddMessage mit `kHide` überschrieben oder
gar nicht erst angenommen. Wasserdicht, null Race.

**Risiken:** SKSE-Plugins müssen pro Skyrim-SE-Version neu kompiliert werden
(AE vs. SE-1.5.97 vs. Next-Gen). Plugin-Laden-Fehler crasht Skyrim beim
Start. Hoher Setup-Aufwand (Visual Studio + CommonLibSSE-NG-Toolchain). Der
Frosthold-Tree hat aktuell **keine** SKSE-Build-Pipeline.

**Empfehlung:**

Zuerst **Option A** probieren (ControlMap-Override). Das ist eine halbe Stunde
Arbeit und liefert in >80% der Fälle bereits ein stabiles Ergebnis. Wenn
TweenMenu trotz Override immer noch hochpoppt (z. B. weil ein Controller-
Binding dazukommt), eskalieren wir zu **Option C** (SKSE-Plugin). Option B
ist nur interessant, wenn wir aus anderen Gründen eh schon einen .esp mit
Papyrus-Scripts bauen.

**Was ich konkret brauche vom User:**
- Für Option A: Zustimmung, dass wir den TAB-Bind komplett lokal aushebeln
  dürfen (Trade-Off: vanilla TweenMenu ist dann **gar nicht** mehr per TAB
  erreichbar, auch nicht außerhalb des Kompass).
- Für Option C: Zustimmung zum Zeitaufwand + Bereitschaft, die Frosthold-
  Client-ZIP künftig mit einer `.dll` auszuliefern.
