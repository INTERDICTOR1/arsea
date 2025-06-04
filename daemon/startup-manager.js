const fs = require('fs');
const path = require('path');
const os = require('os');

class StartupManager {
    constructor() {
        this.appName = 'ArseaDaemon';
        this.startupFolder = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
        this.batchFileName = 'arsea-daemon-startup.bat';
        this.batchFilePath = path.join(this.startupFolder, this.batchFileName);
        this.daemonPath = __dirname; // Current daemon directory
        this.daemonScript = path.join(this.daemonPath, 'index.js');
    }

    /**
     * Create the batch script content that will launch the daemon
     */
    createBatchScript() {
        const batchContent = `@echo off
REM Arsea Daemon Auto-Start Script
REM This script starts the Arsea daemon automatically on Windows startup

echo Starting Arsea Daemon...
cd /d "${this.daemonPath}"
node "${this.daemonScript}"

REM If daemon exits unexpectedly, show error message
if %ERRORLEVEL% NEQ 0 (
    echo Arsea Daemon exited with error code %ERRORLEVEL%
    pause
)
`;
        return batchContent;
    }

    /**
     * Install the daemon to start automatically on system boot
     */
    async install() {
        try {
            console.log('🔧 Installing Arsea Daemon auto-start...');
            
            // Check if startup folder exists
            if (!fs.existsSync(this.startupFolder)) {
                throw new Error(`Startup folder not found: ${this.startupFolder}`);
            }

            // Check if daemon script exists
            if (!fs.existsSync(this.daemonScript)) {
                throw new Error(`Daemon script not found: ${this.daemonScript}`);
            }

            // Create batch script content
            const batchContent = this.createBatchScript();

            // Write batch file to startup folder
            fs.writeFileSync(this.batchFilePath, batchContent, 'utf8');

            console.log(`✅ Auto-start installed successfully!`);
            console.log(`📁 Batch file created: ${this.batchFilePath}`);
            console.log(`🚀 Arsea Daemon will now start automatically on Windows boot`);
            
            return true;
        } catch (error) {
            console.error('❌ Failed to install auto-start:', error.message);
            return false;
        }
    }

    /**
     * Remove the daemon from auto-start
     */
    async uninstall() {
        try {
            console.log('🔧 Removing Arsea Daemon auto-start...');
            
            if (fs.existsSync(this.batchFilePath)) {
                fs.unlinkSync(this.batchFilePath);
                console.log('✅ Auto-start removed successfully!');
                console.log(`🗑️ Deleted: ${this.batchFilePath}`);
            } else {
                console.log('ℹ️ Auto-start was not installed (batch file not found)');
            }
            
            return true;
        } catch (error) {
            console.error('❌ Failed to remove auto-start:', error.message);
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
            daemonPath: this.daemonPath,
            startupFolder: this.startupFolder
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
        
        if (!fs.existsSync(this.daemonScript)) {
            issues.push(`Daemon script not found: ${this.daemonScript}`);
        }
        
        return {
            valid: issues.length === 0,
            issues
        };
    }
}

module.exports = StartupManager;