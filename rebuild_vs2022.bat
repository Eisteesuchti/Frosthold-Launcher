@echo off
echo ========================================
echo Rebuilding Frosthold with VS 2022
echo ========================================

REM Force vcpkg to use VS 2022 Community instead of VS 2026 BuildTools
set VCPKG_VISUAL_STUDIO_PATH=C:\Program Files\Microsoft Visual Studio\2022\Community

call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvarsall.bat" x64

echo.
echo === Step 1: CMake Configure ===
cmake -S "c:\Users\Danie\Desktop\Programmieren Ordner\Frosthold Server\Frosthold" -B "c:\Users\Danie\Desktop\Programmieren Ordner\Frosthold Server\Frosthold\build" -G "Visual Studio 17 2022" -T v143

if %ERRORLEVEL% NEQ 0 (
    echo CMAKE CONFIGURE FAILED!
    pause
    exit /b 1
)

echo.
echo === Step 2: Build SkyrimPlatform ===
cmake --build "c:\Users\Danie\Desktop\Programmieren Ordner\Frosthold Server\Frosthold\build" --config Release --target skyrim_platform -- /m

if %ERRORLEVEL% NEQ 0 (
    echo BUILD FAILED!
    pause
    exit /b 1
)

echo.
echo ========================================
echo BUILD SUCCESSFUL!
echo ========================================
pause
