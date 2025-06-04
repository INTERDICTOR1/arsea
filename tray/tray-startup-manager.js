const fs = require('fs');
const path = require('path');
const os = require('os');

class TrayStartupManager {
    constructor() {
        this.appName = 'ArseaTray';
        this.startupFolder = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
        this.batchFileName = 'arsea-tray-startup.bat';
        this.batchFilePath = path.join(this.startupFolder, this.batchFileName);
        this.trayPath = __dirname; // Current tray directory
        this.electronPath = path.join(this.trayPath, 'node_modules', '.bin', 'electron.cmd');
        this.mainScript = path.join(this.trayPath, 'main.js');
    }

    /**
     * Create the batch script content that will launch the tray
     */
    createBatchScript() {
        const batchContent = `@echo off
REM Arsea Tray Auto-Start Script
REM This script starts the Arsea tray automatically on Windows startup

echo Starting Arsea Tray...
cd /d "${this.trayPath}"

REM Wait a few seconds for system to fully boot and daemon to start
timeout /t 5 /nobreak >nul

REM Start the Electron tray app
npm start

REM If tray exits unexpectedly, show error message
if %ERRORLEVEL% NEQ 0 (
    echo Arsea Tray exited with error code %ERRORLEVEL%
    pause
)
`;
        return batchContent;
    }

    /**
     * Alternative batch script using electron directly
     */
    createDirectBatchScript() {
        const batchContent = `@echo off
REM Arsea Tray Auto-Start Script (Direct Electron Launch)
REM This script starts the Arsea tray automatically on Windows startup

echo Starting Arsea Tray...
cd /d "${this.trayPath}"

REM Wait for system to fully boot and daemon to start
timeout /t 5 /nobreak >nul

REM Start Electron directly (fallback if npm start doesn't work)
"${this.electronPath}" "${this.mainScript}"

REM If tray exits unexpectedly, show error message
if %ERRORLEVEL% NEQ 0 (
    echo Arsea Tray exited with error code %ERRORLEVEL%
    pause
)
`;
        return batchContent;
    }

    /**
     * Install the tray to start automatically on system boot
     */
    async install(useDirect = false) {
        try {
            console.log('🔧 Installing Arsea Tray auto-start...');
            
            // Check if startup folder exists
            if (!fs.existsSync(this.startupFolder)) {
                throw new Error(`Startup folder not found: ${this.startupFolder}`);
            }

            // Check if tray files exist
            if (!fs.existsSync(this.mainScript)) {
                throw new Error(`Tray main script not found: ${this.mainScript}`);
            }

            // Create batch script content
            const batchContent = useDirect ? this.createDirectBatchScript() : this.createBatchScript();

            // Write batch file to startup folder
            fs.writeFileSync(this.batchFilePath, batchContent, 'utf8');

            console.log(`✅ Tray auto-start installed successfully!`);
            console.log(`📁 Batch file created: ${this.batchFilePath}`);
            console.log(`🚀 Arsea Tray will now start automatically on Windows boot`);
            console.log(`⏱️ Tray will wait 5 seconds after boot for daemon to be ready`);
            
            return true;
        } catch (error) {
            console.error('❌ Failed to install tray auto-start:', error.message);
            return false;
        }
    }

    /**
     * Remove the tray from auto-start
     */
    async uninstall() {
        try {
            console.log('🔧 Removing Arsea Tray auto-start...');
            
            if (fs.existsSync(this.batchFilePath)) {
                fs.unlinkSync(this.batchFilePath);
                console.log('✅ Tray auto-start removed successfully!');
                console.log(`🗑️ Deleted: ${this.batchFilePath}`);
            } else {
                console.log('ℹ️ Tray auto-start was not installed (batch file not found)');
            }
            
            return true;
        } catch (error) {
            console.error('❌ Failed to remove tray auto-start:', error.message);
            return false;
        }
    }

    /**
     * Check if auto-start is currently installed
     */
    isInstalled() {
        return fs.existsSync(this.batchFilePath);
    }

    /**
     * Get status information about auto-start
     */
    getStatus() {
        const installed = this.isInstalled();
        return {
            installed,
            batchFilePath: this.batchFilePath,
            trayPath: this.trayPath,
            startupFolder: this.startupFolder,
            electronPath: this.electronPath,
            mainScript: this.mainScript
        };
    }

    /**
     * Test if all required paths exist
     */
    validatePaths() {
        const issues = [];
        
        if (!fs.existsSync(this.startupFolder)) {
            issues.push(`Startup folder not found: ${this.startupFolder}`);
        }
        
        if (!fs.existsSync(this.mainScript)) {
            issues.push(`Tray main script not found: ${this.mainScript}`);
        }
        
        // Note: electron.cmd might not exist if installed differently
        // This is optional validation
        
        return {
            valid: issues.length === 0,
            issues
        };
    }
}

module.exports = TrayStartupManager;