cmake_minimum_required(VERSION 3.21)

# ─── Frosthold Console Block ──────────────────────────────────────────────────
# SKSE-Plugin, das den Tastatur-Scancode der Skyrim-Dev-Console (DIK_GRAVE, 0x29)
# auf Input-Event-Ebene verschluckt. Dadurch öffnet sich die Console auch dann
# nicht, wenn das In-Game-Skyrim-Platform-Layer die Taste für den Voice-Range-
# Picker nutzt (^). Anders als ein reaktives Close über MenuOpenCloseEvent gibt
# es hier nicht mal einen 1-Frame-Flash — der Key wird vor dem Dispatch gekappt.

project(FrostholdConsoleBlock
    VERSION 1.0.0
    DESCRIPTION "Drops DIK_GRAVE so the Skyrim dev console never opens"
    LANGUAGES CXX
)

# CommonLibSSE-NG braucht C++23, wir spiegeln das für das Plugin.
set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")

# CommonLibSSE-NG als Sub-Projekt einbinden. Optionale Teile (Tests, Xbyak,
# nicht benötigte Targets wie SE/VR) abschalten, damit der Build schnell und
# klein bleibt. Wir targetieren Skyrim AE (1.6.x → 1.6.1170 beim User).
set(BUILD_TESTS OFF CACHE BOOL "Build CommonLibSSE tests" FORCE)
set(ENABLE_SKYRIM_SE OFF CACHE BOOL "Skyrim SE support in CommonLibSSE" FORCE)
set(ENABLE_SKYRIM_AE ON  CACHE BOOL "Skyrim AE support in CommonLibSSE" FORCE)
set(ENABLE_SKYRIM_VR OFF CACHE BOOL "Skyrim VR support in CommonLibSSE" FORCE)
set(SKSE_SUPPORT_XBYAK OFF CACHE BOOL "xbyak trampoline support" FORCE)

add_subdirectory(extern/CommonLibSSE EXCLUDE_FROM_ALL)

# ─── Plugin-Target ─────────────────────────────────────────────────────────────
add_library(${PROJECT_NAME} SHARED
    src/main.cpp
    src/PCH.h
)

target_precompile_headers(${PROJECT_NAME} PRIVATE src/PCH.h)

target_include_directories(${PROJECT_NAME} PRIVATE src)

target_link_libraries(${PROJECT_NAME}
    PRIVATE
        CommonLibSSE::CommonLibSSE
)

# .NET-/Signed-Build-Artefakte nicht nötig. Wir brauchen nur die .dll.
set_target_properties(${PROJECT_NAME} PROPERTIES
    OUTPUT_NAME "FrostholdConsoleBlock"
    SUFFIX ".dll"
)

# MSVC-spezifische Warnungs/Optimierungs-Schalter (CommonLibSSE-NG setzt seine
# eigenen Flags für die Lib; wir beschränken uns aufs Plugin).
if (MSVC)
    target_compile_options(${PROJECT_NAME} PRIVATE
        /permissive-
        /Zc:preprocessor
        /utf-8
        /EHsc
        /W3
        /MP
        /wd4100  # unreferenced formal parameter — spammy bei SKSE-Interfaces
    )
endif()

# Kopiere das begleitende .toml in den Build-Output, damit die Plugin-Struktur
# direkt deploy-ready ist.
configure_file(
    "${CMAKE_CURRENT_SOURCE_DIR}/FrostholdConsoleBlock.toml"
    "${CMAKE_CURRENT_BINARY_DIR}/FrostholdConsoleBlock.toml"
    COPYONLY
)

# Optional: Automatischer Deploy in den Skyrim-Data-Ordner. Nur aktiv wenn
# -DSKYRIM_DATA_DIR gesetzt ist, sonst no-op. In diesem Repo greift das
# `deploy-skse-plugin.ps1` — siehe README.
if (DEFINED SKYRIM_DATA_DIR)
    add_custom_command(TARGET ${PROJECT_NAME} POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "$<TARGET_FILE:${PROJECT_NAME}>"
            "${SKYRIM_DATA_DIR}/SKSE/Plugins/FrostholdConsoleBlock.dll"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${CMAKE_CURRENT_SOURCE_DIR}/FrostholdConsoleBlock.toml"
            "${SKYRIM_DATA_DIR}/SKSE/Plugins/FrostholdConsoleBlock.toml"
        COMMENT "Deploying FrostholdConsoleBlock to ${SKYRIM_DATA_DIR}/SKSE/Plugins"
    )
endif()
