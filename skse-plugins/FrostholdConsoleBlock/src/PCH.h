#pragma once

// Pre-compiled header für den CommonLibSSE-NG-Plugin-Build. Das meiste läuft
// über "REL/RelocationTypes.h" und die "RE/"-Forward-Deklarationen; der zentrale
// Sammel-Header "RE/Skyrim.h" bringt alle benötigten Input-/Menu-Typen mit.

#include <SKSE/SKSE.h>
#include <RE/Skyrim.h>
#include <REL/Relocation.h>

#include <spdlog/spdlog.h>
#include <spdlog/sinks/basic_file_sink.h>

#include <cstdint>
#include <atomic>
#include <memory>
#include <thread>
#include <chrono>
#include <filesystem>
#include <string>

// windows.h wird bereits indirekt via SKSE/Skyrim-Header gezogen, aber wir
// nutzen darueber hinaus PostMessage/GetForegroundWindow/IsWindow direkt —
// Expliziter Include macht die Abhaengigkeit klar.
#include <windows.h>
