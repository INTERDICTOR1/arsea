const { Tray, Menu, app, nativeImage } = require('electron');
const path = require('path');
const DaemonClient = require('./daemon-client');
const DaemonHealthMonitor = require('./daemon-health-monitor');
const { execSync } = require('child_process');

// --- Auto-start helpers ---
const appName = 'ArseaContentBlocker';

function setupAutoStart(enable) {
    if (process.platform !== 'win32') return;
    const exePath = process.execPath;
    try {
        if (enable) {
            const regCommand = `reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${appName}" /t REG_SZ /d "${exePath}" /f`;
            execSync(regCommand);
            console.log('Auto-start enabled');
        } else {
            const regCommand = `reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${appName}" /f`;
            execSync(regCommand);
            console.log('Auto-start disabled');
        }
        return true;
    } catch (error) {
        console.error('Failed to setup auto-start:', error);
        return false;
    }
}

function isAutoStartEnabled() {
    if (process.platform !== 'win32') return false;
    try {
        const regCommand = `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${appName}"`;
        execSync(regCommand);
        return true;
    } catch (error) {
        return false;
    }
}
// --- End auto-start helpers ---

class TrayController {
    constructor() {
        this.tray = null;
        this.daemonClient = new DaemonClient();
        this.currentStatus = {
            isAvailable: false,
            isBlocking: false,
            domainsBlocked: 0,
            totalDomains: 0
        };

        // Status refresh interval (every 10 seconds)
        this.statusInterval = null;
        this.statusRefreshRate = 10000;

        // Add health monitor
        this.healthMonitor = new DaemonHealthMonitor(this.daemonClient, {
            healthCheckInterval: 5000, // 5 seconds
            maxRetries: 3,
            retryDelay: 2000
        });

        this.setupHealthMonitorEvents();
    }

    setupHealthMonitorEvents() {
        this.healthMonitor.on('health-restored', () => {
            this.updateTrayIcon(this.currentStatus);
            this.updateMenu();
        });

        this.healthMonitor.on('health-lost', () => {
            this.updateTrayIcon({ ...this.currentStatus, isAvailable: false });
            this.updateMenu();
        });

        this.healthMonitor.on('reconnecting', (data) => {
            console.log(`Reconnecting to daemon (${data.attempt}/${data.maxRetries})...`);
        });

        this.healthMonitor.on('max-retries-exceeded', () => {
            this.updateTrayIcon({ ...this.currentStatus, isAvailable: false });
            console.error('Cannot connect to daemon. Please restart Arsea.');
            this.updateMenu();
        });
    }

    async initialize() {
        try {
            // Wait for daemon to become available
            const daemonReady = await this.daemonClient.waitForDaemon(30000);
            if (!daemonReady) {
                console.warn('⚠️ Starting tray without daemon connection');
            }
            
            this.createTray();
            this.startStatusMonitoring();
            
            console.log('✅ Tray initialized successfully');
        } catch (error) {
            console.error('❌ Failed to initialize tray:', error);
            throw error;
        }
    }
    
    createTray() {
        // Create tray icon
        const iconPath = this.getIconPath(false); // Start with inactive icon
        this.tray = new Tray(nativeImage.createFromPath(iconPath));
        
        this.tray.setToolTip('Arsea DNS Blocker');
        this.updateMenu();
        
        // Handle tray click (optional)
        this.tray.on('click', () => {
            this.refreshStatus();
        });
    }
    
    getIconPath(isActive) {
        const iconName = isActive ? 'icon-active.png' : 'icon-inactive.png';
        return path.join(__dirname, 'assets', iconName);
    }
    
    updateTrayIcon(status) {
        if (!this.tray) return;
        
        const iconPath = this.getIconPath(status.isBlocking && status.isAvailable);
        this.tray.setImage(nativeImage.createFromPath(iconPath));
        
        // Update tooltip
        let tooltip = 'Arsea DNS Blocker';
        if (status.isAvailable) {
            tooltip += status.isBlocking ? ' - Blocking Active' : ' - Blocking Disabled';
            if (status.domainsBlocked > 0) {
                tooltip += ` (${status.domainsBlocked} blocked)`;
            }
        } else {
            tooltip += ' - Daemon Offline';
        }
        this.tray.setToolTip(tooltip);
    }
    
    updateMenu() {
        const healthStatus = this.healthMonitor.getHealthStatus();
        const connectionStatus = healthStatus.isHealthy ? 'Connected' : 'Disconnected';

        // --- Add auto-start menu item ---
        const autoStartEnabled = isAutoStartEnabled();
        const autoStartMenuItem = {
            label: `Auto-start: ${autoStartEnabled ? 'ON' : 'OFF'}`,
            click: () => {
                const newState = !autoStartEnabled;
                if (setupAutoStart(newState)) {
                    // Refresh menu to reflect new state
                    setTimeout(() => this.updateMenu(), 500);
                }
            }
        };
        // --- End auto-start menu item ---

        const menuTemplate = [
            { label: `Status: ${connectionStatus}`, enabled: false },
            { type: 'separator' },
            {
                label: this.currentStatus.isAvailable ?
                    (this.currentStatus.isBlocking ? '✅ Blocking: ON' : '❌ Blocking: OFF') :
                    '⚠️ Status: Offline',
                enabled: false
            },
            {
                label: this.currentStatus.isAvailable ?
                    `Domains: ${this.currentStatus.totalDomains.toLocaleString()}` :
                    'Daemon not available',
                enabled: false
            },
            {
                label: this.currentStatus.isAvailable && this.currentStatus.domainsBlocked > 0 ?
                    `Blocked: ${this.currentStatus.domainsBlocked.toLocaleString()}` :
                    'No blocks recorded',
                enabled: false
            },
            { type: 'separator' },
            autoStartMenuItem, // <-- Inserted here
            {
                label: this.currentStatus.isBlocking ? 'Disable Blocking' : 'Enable Blocking',
                enabled: this.currentStatus.isAvailable,
                click: () => this.toggleBlocking()
            },
            {
                label: 'Refresh Status',
                click: () => this.refreshStatus()
            },
            { type: 'separator' },
            {
                label: 'Quit Arsea',
                click: () => this.quitApplication()
            }
        ];

        this.tray.setContextMenu(Menu.buildFromTemplate(menuTemplate));
    }
    
    async toggleBlocking() {
        try {
            console.log('Toggling blocking state...');
            const result = await this.daemonClient.toggleBlocking();
            console.log('Toggle result:', result.message);
            
            // Refresh status immediately after toggle
            await this.refreshStatus();
            
        } catch (error) {
            console.error('Failed to toggle blocking:', error);
            // Show error in menu temporarily
            this.showError(`Error: ${error.message}`);
        }
    }
    
    async refreshStatus() {
        try {
            const status = await this.daemonClient.getTrayStatus();
            this.currentStatus = status;
            
            this.updateTrayIcon(status);
            this.updateMenu();
            
        } catch (error) {
            console.error('Failed to refresh status:', error);
            this.currentStatus.isAvailable = false;
            this.updateTrayIcon(this.currentStatus);
            this.updateMenu();
        }
    }
    
    startStatusMonitoring() {
        // Initial status refresh
        this.refreshStatus();
        
        // Set up periodic refresh
        this.statusInterval = setInterval(() => {
            this.refreshStatus();
        }, this.statusRefreshRate);
    }
    
    stopStatusMonitoring() {
        if (this.statusInterval) {
            clearInterval(this.statusInterval);
            this.statusInterval = null;
        }
    }
    
    showError(message) {
        // Temporarily show error in tray tooltip
        if (this.tray) {
            this.tray.setToolTip(`Arsea DNS Blocker - ${message}`);
            
            // Reset tooltip after 5 seconds
            setTimeout(() => {
                this.updateTrayIcon(this.currentStatus);
            }, 5000);
        }
    }
    
    async start() {
        // ...existing tray setup code...
        await this.initialize();
        this.healthMonitor.start();
    }

    async quitApplication() {
        try {
            console.log('Quitting Arsea tray application...');
            this.stopStatusMonitoring();

            if (this.healthMonitor) {
                this.healthMonitor.stop();
            }

            if (this.tray) {
                this.tray.destroy();
                this.tray = null;
            }

            app.quit();
        } catch (error) {
            console.error('Error during quit:', error);
            app.quit();
        }
    }
    
    destroy() {
        this.stopStatusMonitoring();
        if (this.tray) {
            this.tray.destroy();
            this.tray = null;
        }
    }
}

module.exports = TrayController;