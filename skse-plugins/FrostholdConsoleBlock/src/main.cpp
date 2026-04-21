// ─── Frosthold Console Block (SKSE Plugin) ─────────────────────────────────
//
// Zweck
// =====
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

    void OnSKSEMessage(SKSE::MessagingInterface::Message* msg) {
        if (!msg) return;
        switch (msg->type) {
        case SKSE::MessagingInterface::kDataLoaded:
            InstallSink();
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
    v.PluginVersion({ 1, 0, 0, 0 });
    // AE-Struct-Layout ab 1.6.629 — sonst weigert sich der AE-SKSE-Loader.
    v.UsesAddressLibrary(true);
    v.UsesStructsPost629(true);
    return v;
}();
