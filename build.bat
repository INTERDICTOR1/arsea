@echo off
REM build.bat - Build Arsea for Windows

echo Building Arsea Content Blocker...
echo.

REM Install dependencies
echo Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo Failed to install root dependencies
    pause
    exit /b 1
)

REM Install daemon dependencies
echo Installing daemon dependencies...
cd daemon
call npm install
if %errorlevel% neq 0 (
    echo Failed to install daemon dependencies
    pause
    exit /b 1
)
cd ..

REM Install tray dependencies  
echo Installing tray dependencies...
cd tray
call npm install
if %errorlevel% neq 0 (
    echo Failed to install tray dependencies
    pause
    exit /b 1
)
cd ..

REM Build the application
echo Building application...
call npm run build:win
if %errorlevel% neq 0 (
    echo Build failed
    pause
    exit /b 1
)

echo.
echo Build completed successfully!
echo Installer can be found in: dist/
echo.
pause