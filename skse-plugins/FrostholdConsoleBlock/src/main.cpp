// ─── Frosthold Console Block + Keyboard Reclaim (SKSE Plugin) ──────────────
//
// Zweck (zwei Responsibilities in einer DLL)
// ==========================================
// 1) CONSOLE-BLOCK (urspruenglicher Zweck):
// Der Frosthold-Voice-Chat nutzt die Taste `^` (DIK_GRAVE, DxScanCode 0x29)
// als Hotkey für den Range-Picker. Dieselbe Taste öffnet Vanilla-Skyrim die
// Dev-Console. Ein rein JS-seitiges "beim menuOpen wieder zumachen"-Konstrukt
// funktioniert, flackert aber einen Frame. Dieses Plugin setzt tiefer an: es
// klinkt sich in den globalen Input-Event-Stream ein, sucht Keyboard-Button-
// Events mit ScanCode 0x29 heraus und entwertet sie, BEVOR Skyrim daraus eine
// User-Event-Mapping („Toggle Console") macht. Ergebnis: kein Console-Flash,
// die Taste ist für Vanilla komplett tot — bleibt aber für Skyrim-Platform
// nutzbar, weil SP seinen eigenen Keybind-Query-Pfad über DirectInput / die
// Game-Input-Struct nutzt (er wird vor unserem Remap abgegriffen).
//
// 2) KEYBOARD-RECLAIM (erweiterter Zweck seit 1.1.0):
// Voice-Aktivierung triggert Chromiums user_input_monitor_win, der Skyrims
// DirectInput blockiert bis zum naechsten Alt-Tab. Dieses Plugin pollt eine
// Flag-Datei und simuliert fuer Skyrim einen Alt-Tab-Roundtrip via
// WM_ACTIVATE, damit BSInputDeviceManager seine Devices re-acquired — ohne
// dass der User die Tasten muss. Details im Abschnitt "Keyboard-Reclaim-
// Sub-System" weiter unten.
//
// Alternative, die wir bewusst NICHT gewählt haben:
//   - Hook auf MenuOpenCloseEvent → wie das JS-Fallback, visueller Flash.
//   - ControlMap::ToggleControls: deaktiviert zu viele User-Events auf einmal.
//   - Unmap des Console-UserEvents: persistiert in der Options-INI und hätte
//     Seiteneffekte für andere Plugins / Tools (z. B. ConsoleCommandsExtender).
//
// Warum nicht 0x29 → 0xFF? Weil 0xFF in einigen Skyrim-Pfaden als "ungesetzt"
// interpretiert und das Event ganz verworfen wird, andere Pfade aber den Wert
// dennoch als Tastendruck an UI-Elemente wie die Chat-Eingabe weiterreichen.
// Wir nehmen 0x00, ein definitiv ungenutzter Scancode für Skyrim-Bindings.
//
// Kompatibilitäts-Notizen
// =======================
// - Plugin ist AE-only (Skyrim 1.6.1170+). Auf SE würde der gleiche Hook
//   funktionieren; wir sparen uns den Build, weil Frosthold-Spieler AE
//   verwenden.
// - Keine Version-Specific-Offsets. Wir nutzen ausschließlich öffentliche
//   CommonLibSSE-NG-APIs (BSInputDeviceManager::AddEventSink) — robust gegen
//   Engine-Updates.

#include "PCH.h"

namespace {

    // Cache für den Logger, damit wir nicht bei jedem Event spdlog::get()
    // aufrufen. Nur beim Load einmal initialisiert.
    std::shared_ptr<spdlog::logger> g_log;

    constexpr std::uint32_t kConsoleScanCode = 0x29;  // DIK_GRAVE

    // Counter, damit wir im Log sehen können wie oft der Block angeschlagen
    // hat — ohne jeden einzelnen Key zu loggen (wäre Spam).
    std::atomic<std::uint64_t> g_blockedCount{ 0 };

    // ─── Keyboard-Reclaim-Sub-System ─────────────────────────────────────────
    //
    // Problem
    // =======
    // Sobald Chromium (via Skyrim-Platform-CEF) getUserMedia() fuer Voice-Chat
    // anruft, startet es intern den user_input_monitor_win. Der registriert
    // sich per RegisterRawInputDevices auf HID-Keyboards (um Tipp-Geraeusche
    // fuer AEC zu erkennen) und blockiert dabei Skyrims DirectInput-Poll-Loop.
    // Symptom: Tastatur komplett tot bis der User Alt-Tab aus dem Spiel macht
    // und wieder rein — Alt-Tab schickt WM_ACTIVATEAPP ans Skyrim-Fenster,
    // was BSInputDeviceManager zum Re-Acquire seiner DirectInput-Devices
    // zwingt.
    //
    // Warum nicht in CEF fixen
    // ========================
    // setFocused(true/false) im CEF-Browser togglet nur CEF-internen Input-
    // State — die Raw-Input-Registration ist aber process-weit. Bounces auf
    // CEF-Ebene greifen nachweislich (frostmp-browser.log zeigt sauber
    // focused=true/false-Toggles), aendern aber nichts am user_input_monitor-
    // Grab. Einziger Weg: dem Skyrim-HWND explizit WM_ACTIVATE schicken,
    // wie es Windows beim Alt-Tab macht.
    //
    // Kommunikation CEF → Plugin
    // ==========================
    // CEF-JS hat keinen WinAPI-Zugriff. SkyrimPlatforms Node-Bridge (erreichbar
    // aus skymp5-client TS) schreibt eine Flag-Datei; der Worker-Thread hier
    // pollt den Pfad alle 50ms, loescht das Flag bei Fund, und posted die
    // WM_ACTIVATE-Sequenz. File-Flag wurde gegenueber UDP/Shared-Memory
    // bevorzugt, weil (a) trivial zu debuggen, (b) keine zusaetzlichen Ports
    // im VPN/Firewall-Setup, (c) TS-Seite kann require("fs") direkt.
    //
    // Flag-Pfad: Documents\My Games\Skyrim Special Edition\SKSE\
    //            frosthold-kb-reclaim.flag
    //   (gleicher Ordner wie FrostholdConsoleBlock.log — SKSE-Standard).

    // HWND-Cache: wird beim SKSE::MessagingInterface::kDataLoaded-Event
    // via GetForegroundWindow() gesetzt. Zu diesem Zeitpunkt hat Skyrim
    // die Fenster-Aktivierung sicher abgeschlossen und ist (im Normalfall)
    // Foreground. FindWindowW waere ein Alternativ-Weg, aber window title
    // variiert zwischen AE-Versionen ("Skyrim Special Edition" vs.
    // "Skyrim Anniversary Edition") — GetForegroundWindow ist unabhaengig
    // davon. Fallback: falls beim Reclaim das HWND leer/invalid ist,
    // probiert der Worker einen Lazy-Lookup.
    std::atomic<HWND> g_skyrimHwnd{ nullptr };

    // Worker-Thread-Kontrolle. Wir setzen g_workerShutdown nur fuer
    // Ordentlichkeit — Skyrim-Exit reisst den gesamten Process mit, der
    // Worker stirbt dann ohnehin. Detach statt Join aus demselben Grund.
    std::atomic<bool> g_workerShutdown{ false };
    std::thread g_kbWorker;

    std::filesystem::path GetReclaimFlagPath() {
        auto logDir = SKSE::log::log_directory();
        if (logDir) {
            return *logDir / L"frosthold-kb-reclaim.flag";
        }
        // Fallback ueber USERPROFILE. Sollte nicht passieren, weil SKSE den
        // Ordner zuverlaessig liefert, aber defensiv ist gratis.
        std::filesystem::path fallback;
        wchar_t* home = nullptr;
        size_t len = 0;
        if (_wdupenv_s(&home, &len, L"USERPROFILE") == 0 && home) {
            fallback = std::filesystem::path(home)
                / L"Documents" / L"My Games"
                / L"Skyrim Special Edition" / L"SKSE"
                / L"frosthold-kb-reclaim.flag";
            free(home);
        }
        return fallback;
    }

    // Sendet die Alt-Tab-Sequenz an das Skyrim-Fenster. PostMessage statt
    // SendMessage, damit wir nicht auf den Skyrim-Main-Thread warten — die
    // Messages landen in der Queue und werden im naechsten Pump verarbeitet.
    void ReclaimKeyboardFocus() {
        HWND hwnd = g_skyrimHwnd.load(std::memory_order_acquire);
        if (!hwnd || !IsWindow(hwnd)) {
            // Cache invalid — einmal lazy re-cachen. Das passiert normalerweise
            // nur, wenn der User waehrend DataLoaded zufaellig Alt-Tab gedrueckt
            // hatte.
            HWND fg = GetForegroundWindow();
            if (fg && IsWindow(fg)) {
                DWORD wndPid = 0;
                GetWindowThreadProcessId(fg, &wndPid);
                if (wndPid == GetCurrentProcessId()) {
                    g_skyrimHwnd.store(fg, std::memory_order_release);
                    hwnd = fg;
                    if (g_log) g_log->info("KB-Reclaim: HWND lazy-recached via GetForegroundWindow.");
                }
            }
        }
        if (!hwnd || !IsWindow(hwnd)) {
            if (g_log) g_log->warn("KB-Reclaim: kein gueltiges HWND, Reclaim skipped.");
            return;
        }

        // WM_ACTIVATE WA_INACTIVE -> WA_ACTIVE. MAKEWPARAM(state, minimized).
        // Skyrims BSInputDeviceManager re-acquired DirectInput beim WA_ACTIVE
        // (genau wie bei echtem Alt-Tab zurueck ins Spiel). lParam=0 bedeutet
        // "kein previous-HWND" fuer WA_INACTIVE bzw. "kein activated-from-HWND"
        // fuer WA_ACTIVE — das ist die Vanilla-Semantik wenn Windows selbst
        // den Activate-Event dispatcht.
        PostMessageW(hwnd, WM_ACTIVATE, MAKEWPARAM(WA_INACTIVE, 0), 0);
        PostMessageW(hwnd, WM_ACTIVATE, MAKEWPARAM(WA_ACTIVE,   0), 0);
        if (g_log) {
            g_log->info("KB-Reclaim: WM_ACTIVATE INACTIVE/ACTIVE posted to HWND=0x{:x}",
                reinterpret_cast<std::uintptr_t>(hwnd));
        }
    }

    void KbReclaimWorkerLoop() {
        const auto flagPath = GetReclaimFlagPath();
        if (g_log) {
            g_log->info("KB-Reclaim-Worker gestartet — polling alle 50ms, flag='{}'",
                flagPath.string());
        }
        std::error_code ec;
        while (!g_workerShutdown.load(std::memory_order_acquire)) {
            ec.clear();
            if (!flagPath.empty() && std::filesystem::exists(flagPath, ec) && !ec) {
                // Flag zuerst loeschen, dann reacten. Umgekehrte Reihenfolge
                // koennte bei einer schnellen zweiten Anforderung die neue
                // Anforderung verschlucken.
                std::filesystem::remove(flagPath, ec);
                ReclaimKeyboardFocus();
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        if (g_log) g_log->info("KB-Reclaim-Worker beendet.");
    }

    // ─── Input-Sink ────────────────────────────────────────────────────────
    //
    // CommonLibSSE-NG liefert uns Events als einfach verkettete Liste
    // (InputEvent::next). Wir können einzelne Button-Events nicht cleanly
    // aus der Liste entfernen (andere Plugins könnten den Stream schon
    // konsumiert haben), wohl aber ihren ScanCode entwerten. Das Ergebnis
    // ist identisch: der weitere Dispatch findet keinen zugeordneten
    // User-Event mehr und lässt das Event fallen.
    class ConsoleKeyFilter final : public RE::BSTEventSink<RE::InputEvent*> {
    public:
        static ConsoleKeyFilter* GetSingleton() {
            static ConsoleKeyFilter instance;
            return &instance;
        }

        RE::BSEventNotifyControl ProcessEvent(
            RE::InputEvent* const* a_event,
            RE::BSTEventSource<RE::InputEvent*>* /*a_source*/) override
        {
            if (!a_event || !*a_event) {
                return RE::BSEventNotifyControl::kContinue;
            }

            for (auto* evt = *a_event; evt; evt = evt->next) {
                if (evt->eventType != RE::INPUT_EVENT_TYPE::kButton) {
                    continue;
                }
                auto* button = evt->AsButtonEvent();
                if (!button) {
                    continue;
                }
                // Nur Keyboard-Events betrachten. Gamepad / Maus behalten ihren
                // Lauf, damit wir nicht versehentlich andere Hotkeys killen.
                if (button->device.get() != RE::INPUT_DEVICE::kKeyboard) {
                    continue;
                }
                if (button->idCode != kConsoleScanCode) {
                    continue;
                }

                // Entwerten: 0x00 ist kein gültiger DIK-Code für Skyrim, das
                // Event wird stumm verworfen. userEvent ebenfalls neutralisieren,
                // für den Fall dass der Translator schon gelaufen ist.
                button->idCode = 0;
                if (!button->userEvent.empty()) {
                    button->userEvent = RE::BSFixedString();
                }

                const auto n = g_blockedCount.fetch_add(1, std::memory_order_relaxed) + 1;
                // Nur jeden 64. Treffer loggen, um Log-Spam bei Key-Repeat
                // (~30-60 events/sec) zu vermeiden.
                if (g_log && (n % 64) == 1) {
                    g_log->info("Suppressed console key (cumulative {}).", n);
                }
            }

            return RE::BSEventNotifyControl::kContinue;
        }

    private:
        ConsoleKeyFilter()  = default;
        ~ConsoleKeyFilter() = default;

        ConsoleKeyFilter(const ConsoleKeyFilter&)            = delete;
        ConsoleKeyFilter(ConsoleKeyFilter&&)                 = delete;
        ConsoleKeyFilter& operator=(const ConsoleKeyFilter&) = delete;
        ConsoleKeyFilter& operator=(ConsoleKeyFilter&&)      = delete;
    };

    // ─── Logging-Setup ──────────────────────────────────────────────────────
    //
    // SKSE stellt uns über GetLogPath() den Standard-Plugin-Log-Ordner zur
    // Verfügung (%USERPROFILE%\Documents\My Games\Skyrim Special Edition\
    // SKSE). Wir schreiben dort FrostholdConsoleBlock.log.
    void InitLogger() {
        auto path = SKSE::log::log_directory();
        if (!path) {
            return;
        }
        *path /= "FrostholdConsoleBlock.log";
        auto sink = std::make_shared<spdlog::sinks::basic_file_sink_mt>(path->string(), /*truncate*/ true);
        g_log = std::make_shared<spdlog::logger>("FrostholdConsoleBlock", sink);
        g_log->set_level(spdlog::level::info);
        g_log->flush_on(spdlog::level::info);
        spdlog::register_logger(g_log);
        spdlog::set_default_logger(g_log);
        g_log->info("FrostholdConsoleBlock boot — build " __DATE__ " " __TIME__);
    }

    // ─── Installer ──────────────────────────────────────────────────────────
    //
    // Wird aufgerufen sobald SKSE das Spiel als „DataLoaded" meldet. Früher
    // ist der BSInputDeviceManager noch nicht garantiert initialisiert.
    void InstallSink() {
        auto* mgr = RE::BSInputDeviceManager::GetSingleton();
        if (!mgr) {
            if (g_log) g_log->error("BSInputDeviceManager not available — console block NOT installed.");
            return;
        }
        mgr->AddEventSink(ConsoleKeyFilter::GetSingleton());
        if (g_log) g_log->info("Console key filter installed on BSInputDeviceManager.");
    }

    // Cacht das Skyrim-HWND und startet den KB-Reclaim-Worker. Wird beim
    // kDataLoaded-Event aufgerufen, wo Skyrim sein Hauptfenster definitiv
    // erzeugt und (meistens) Foreground gezogen hat.
    void InstallKbReclaim() {
        HWND fg = GetForegroundWindow();
        if (fg && IsWindow(fg)) {
            DWORD wndPid = 0;
            GetWindowThreadProcessId(fg, &wndPid);
            if (wndPid == GetCurrentProcessId()) {
                g_skyrimHwnd.store(fg, std::memory_order_release);
                if (g_log) {
                    g_log->info("KB-Reclaim: Skyrim-HWND gecached (HWND=0x{:x}) bei kDataLoaded.",
                        reinterpret_cast<std::uintptr_t>(fg));
                }
            } else {
                if (g_log) {
                    g_log->warn("KB-Reclaim: GetForegroundWindow bei kDataLoaded gehoert anderem Process "
                                "(pid={} vs. self={}) — Worker cached lazy beim ersten Flag-Trigger.",
                                wndPid, GetCurrentProcessId());
                }
            }
        } else {
            if (g_log) {
                g_log->warn("KB-Reclaim: GetForegroundWindow lieferte NULL — Worker cached lazy.");
            }
        }

        if (!g_kbWorker.joinable()) {
            try {
                g_kbWorker = std::thread(KbReclaimWorkerLoop);
                g_kbWorker.detach();  // detach, weil Process-Exit den Thread mitreisst
            } catch (const std::exception& ex) {
                if (g_log) g_log->error("KB-Reclaim: Worker-Thread konnte nicht gestartet werden: {}", ex.what());
            }
        }
    }

    void OnSKSEMessage(SKSE::MessagingInterface::Message* msg) {
        if (!msg) return;
        switch (msg->type) {
        case SKSE::MessagingInterface::kDataLoaded:
            InstallSink();
            InstallKbReclaim();
            break;
        default:
            break;
        }
    }

}  // namespace

// ─── SKSE-Plugin-Entrypoint ────────────────────────────────────────────────

SKSEPluginLoad(const SKSE::LoadInterface* a_skse) {
    SKSE::Init(a_skse);
    InitLogger();
    if (g_log) g_log->info("SKSEPluginLoad — registering message listener.");

    auto* msg = SKSE::GetMessagingInterface();
    if (!msg || !msg->RegisterListener(OnSKSEMessage)) {
        if (g_log) g_log->error("Failed to register SKSE messaging listener.");
        return false;
    }
    return true;
}

// CommonLibSSE-NG erzeugt den plugin-declaration-Block automatisch, wenn wir
// SKSEPlugin_Version als globale SKSE::PluginVersionData bereitstellen. Der
// SKSE-Loader sucht beim Plugin-Load nach diesem Symbol; Methoden hier
// korrespondieren mit den Feldern in der Header-Struct (Interfaces.h).
extern "C" __declspec(dllexport) SKSE::PluginVersionData SKSEPlugin_Version = []() noexcept {
    SKSE::PluginVersionData v;
    v.PluginName("FrostholdConsoleBlock");
    v.AuthorName("Frosthold");
    v.PluginVersion({ 1, 1, 0, 0 });
    // AE-Struct-Layout ab 1.6.629 — sonst weigert sich der AE-SKSE-Loader.
    v.UsesAddressLibrary(true);
    v.UsesStructsPost629(true);
    return v;
}();
