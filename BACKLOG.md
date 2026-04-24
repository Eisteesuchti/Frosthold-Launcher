# Frosthold Backlog / Zukunfts-Features

Dieses Dokument sammelt Features und Ideen, die aktuell **noch nicht** umgesetzt
werden, aber später kommen sollen. Wenn ein Eintrag in Arbeit geht, wandert er
heraus in einen aktiven To-Do-Plan.

---

## Später geplant

### Horse-Sync-Fix für `.spawnhorse`

**Kontext:** `.spawnhorse` (siehe `chat-server/server.mjs` +
`frostholdChatService.ts`) spawnt das Pferd aktuell **lokal** beim
ausführenden GM via `player.placeAtMe(baseForm, 1, false, false)`. Das Pferd
ist für den GM reitbar, aber andere Spieler sehen es entweder gar nicht oder
an falscher Position — SkyMP syncht Mount-States (`actor.setVehicle()`) nicht
sauber.

**Ziel:** `.spawnhorse` spawnt ein Pferd, das für alle Spieler sichtbar und
vom GM reitbar ist. Bonus: Pferd bleibt persistent, bis es abgespeckt oder
vom GM wieder entfernt wird.

**Mögliche Bausteine:**
- Server-seitiger Actor-Spawn über skymp5-server-Addon (statt Client-
  `placeAtMe`). Addon hängt sich an `mp.createActor()` oder an eine
  äquivalente Low-Level-API und registriert die Form dauerhaft im Worldspace.
- Mount/Dismount-Events via Papyrus-Hook (`OnSit`/`OnDismount` auf der
  Horse-Actor-Form) an den Server senden, damit der Spieler-Movement-Stream
  an die Horse-Position gekoppelt wird.
- Lore-freundliche Whitelist erweitern (aktuell: vanilla-Horses mit Sattel;
  später: farbig unterscheidbare Variationen für verschiedene RP-Fraktionen).

**Status:** MVP (v1) läuft lokal; Sync-Arbeit ist ein eigener Brocken (SkyMP-
Mount-Limit ist bekannt), daher hier parken.

---

### World-Loot-Lock v2 (Dungeon/Haus/Drop-Tracking)

**Kontext:** `Frosthold/skymp5-server-addons/frosthold-world-loot-lock.cjs`
(v1) sperrt aktuell nur im **Exterior** (Tamriel + Solstheim) alle Items aus
`chat-server/items.json`, mit Ausnahme der Kategorie `Zutat` (Pflanzen /
Kräuter). Alle Interiors sind pass-through, Mob-Loot läuft weiterhin über
`frosthold-loot.cjs`.

**v2 soll:**
1. **Interior-Unterscheidung:** Dungeons, Höhlen, Ruinen sind lootbar;
   Wohnhäuser und Shops sind gesperrt. Klassifizierung über
   `mp.get(refrId, "locationalData").cellOrWorldDesc` gegen eine kuratierte
   Liste von Dungeon-Cell-FormIDs (Vanilla + DLC). Alternativ Keyword-Check
   (`LocTypeDungeon` / `LocTypeStore` / `LocTypeHouse` auf dem Parent-
   Location-Record).
2. **Drop-Tracking:** Wenn ein Spieler ein Item im Exterior/gesperrten
   Interior fallen lässt, muss er (und nur er) es wieder aufheben können.
   Dafür ein In-Memory-Set `<refrId, ownerProfileId>` pflegen, das beim
   Drop-Event geschrieben und beim onActivate gelesen wird. Persistenz nur,
   falls gewünscht (wird unhandlich bei 1000+ Drops).
3. **FLOR-Support:** Wenn FLOR-Records (Pflanzen direkt in der Welt, nicht
   als Item-Drops) doch onActivate triggern, sauber durchreichen ohne
   Block. Aktuell scheinen sie nicht zu triggern, aber v2 sollte das
   explizit behandeln.
4. **Throttle für Block-Feedback:** v1 blockt silently; v2 sollte eine
   kurze System-Notification schicken ("Dieses Item lässt sich hier nicht
   mitnehmen") mit 3s-Cooldown pro Spieler, damit Kinder-RP nicht im
   Unklaren sind, warum Activate nichts tut.

**Status:** v1 deckt Exterior-Minimalvariante ab; v2 ist Nice-to-have und
kommt nur, wenn die Server-Community konkret fordert, dass Häuser/Dungeons
anders behandelt werden sollen.

---

### Live-Enchantment-Effekte für Unique-Items

**Kontext:** Der Live-Stats-Bridge (`query_unique_stats` →
`frostholdChatService.ts` → `Weapon.getBaseDamage/getEnchantment/getName`)
liest aktuell pro Unique-Item: Basis-Schaden, Gewicht, Name der
Verzauberung. **Nicht** gelesen werden die eigentlichen Effekte
(`Enchantment.getEffect(i)` + `getMagnitude` / `getDuration` /
`getArea`), weil das pro Item mehrere Effekte mit unterschiedlichen
Units (Punkte, Sekunden, %) sind und die UI-Darstellung Arbeit kostet.

**Ziel:** Im Unique-Detail-Modal neben der Enchantment-Bezeichnung auch die
einzelnen Effekte mit Magnitude/Duration als saubere Liste anzeigen, z. B.
"Absorbiert 25 Lebenspunkte" oder "Feuerschaden 15 pro Sekunde, 5 Sekunden".

**Mögliche Bausteine:**
- `Enchantment.from(weapon.getEnchantment())` + `.getEffectCount()` +
  Schleife über `.getNthEffect(i)` (gibt eine `MagicEffect`-Form zurück).
- Magnitude/Duration/Area liegen auf dem `EffectItem`, nicht auf dem
  MagicEffect direkt — die API dafür existiert in SkyrimPlatform als
  `Enchantment.getEffectMagnitude(i) / getEffectDuration(i) / getEffectArea(i)`.
- Localisiertes Mapping von `MagicEffect.getName()` auf deutsche Texte
  (manuelle Tabelle, weil die Vanilla-Namen teils englisch bleiben in den
  SkyMP-Strings).
- Cache-Layer auf Server-Seite: Effekt-Listen sind stabil pro Form, hier
  ist ein permanentes Cache (kein 2min-TTL) vertretbar, evtl. sogar als
  Teil des `unique-shop.mjs`-Schemas manuell gepflegt.

**Status:** Vorgemerkt; v1 des Detail-Modals reicht für die meisten
Spieler, weil der Enchantment-Name im Tooltip schon Lore liefert.

---

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
