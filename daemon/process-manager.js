// daemon/process-manager.js
// Complete Process Management for Arsea Daemon

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

class ProcessManager {
    constructor(options = {}) {
        this.pidFile = options.pidFile || path.join(__dirname, 'arsea-daemon.pid');
        this.stateFile = options.stateFile || path.join(__dirname, 'arsea-state.json');
        this.isShuttingDown = false;
        this.shutdownTimeout = options.shutdownTimeout || 15000; // 15 seconds max shutdown time
        this.daemon = null;
        this.apiServer = null;
    }

    // Initialize process management
    async initialize(daemon, apiServer = null) {
        this.daemon = daemon;
        this.apiServer = apiServer;
        
        // Write PID file
        await this.writePidFile();
        
        // Load previous state if exists
        await this.loadState();
        
        console.log(`📋 Process Manager initialized (PID: ${process.pid})`);
        return true;
    }

    // Write PID file for process tracking
    async writePidFile() {
        try {
            const pidData = {
                pid: process.pid,
                startTime: new Date().toISOString(),
                platform: os.platform(),
                nodeVersion: process.version
            };
            await fs.writeFile(this.pidFile, JSON.stringify(pidData, null, 2));
            console.log(`📝 PID file written: ${this.pidFile}`);
        } catch (error) {
            console.warn(`⚠️ Could not write PID file: ${error.message}`);
        }
    }

    // Remove PID file on shutdown
    async removePidFile() {
        try {
            await fs.unlink(this.pidFile);
            console.log('🗑️ PID file removed');
        } catch (error) {
            // File might not exist, that's ok
            if (error.code !== 'ENOENT') {
                console.warn(`⚠️ Could not remove PID file: ${error.message}`);
            }
        }
    }

    // Save current daemon state
    async saveState() {
        if (!this.daemon) return;
        
        try {
            const state = {
                isBlocking: this.daemon.isBlocking,
                timestamp: new Date().toISOString(),
                stats: this.daemon.getDNSStats ? this.daemon.getDNSStats() : null,
                version: require('./package.json').version
            };
            
            await fs.writeFile(this.stateFile, JSON.stringify(state, null, 2));
            console.log('💾 Daemon state saved');
        } catch (error) {
            console.warn(`⚠️ Could not save state: ${error.message}`);
        }
    }

    // Load previous daemon state
    async loadState() {
        try {
            const stateData = await fs.readFile(this.stateFile, 'utf8');
            const state = JSON.parse(stateData);
            
            if (this.daemon && typeof state.isBlocking === 'boolean') {
                this.daemon.isBlocking = state.isBlocking;
                console.log(`📂 Previous state loaded: blocking ${state.isBlocking ? 'ON' : 'OFF'}`);
            }
            
            return state;
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.warn(`⚠️ Could not load previous state: ${error.message}`);
            }
            return null;
        }
    }

    // Remove state file
    async removeStateFile() {
        try {
            await fs.unlink(this.stateFile);
            console.log('🗑️ State file removed');
        } catch (error) {
            if (error.code !== 'ENOENT') {
                console.warn(`⚠️ Could not remove state file: ${error.message}`);
            }
        }
    }

    // Enhanced graceful shutdown with timeout
    async gracefulShutdown(signal = 'UNKNOWN') {
        if (this.isShuttingDown) {
            console.log('🔄 Shutdown already in progress...');
            return;
        }
        
        this.isShuttingDown = true;
        console.log(`\n🔄 Shutting down Arsea [Signal: ${signal}]...`);
        
        // Set shutdown timeout
        const shutdownTimer = setTimeout(() => {
            console.error('❌ Graceful shutdown timeout! Force exiting...');
            process.exit(1);
        }, this.shutdownTimeout);

        try {
            // 1. Save current state first
            await this.saveState();
            
            // 2. Stop API server
            if (this.apiServer) {
                console.log('🔌 Stopping API server...');
                await this.apiServer.stop();
                console.log('✅ API server stopped');
            }
            
            // 3. Stop daemon (handles DNS restoration)
            if (this.daemon) {
                console.log('🛑 Stopping daemon...');
                await this.daemon.shutdown();
                console.log('✅ Daemon stopped');
            }
            
            // 4. Cleanup files
            await this.removePidFile();
            
            // 5. Clear shutdown timer
            clearTimeout(shutdownTimer);
            
            console.log('✅ Graceful shutdown complete');
            process.exit(0);
            
        } catch (error) {
            clearTimeout(shutdownTimer);
            console.error('❌ Error during graceful shutdown:', error.message);
            
            // Emergency cleanup attempt
            try {
                await this.removePidFile();
                if (this.daemon && this.daemon.dnsConfig) {
                    console.log('🚨 Emergency DNS restore attempt...');
                    await this.daemon.dnsConfig.restore();
                }
            } catch (emergencyError) {
                console.error('❌ Emergency cleanup failed:', emergencyError.message);
            }
            
            process.exit(1);
        }
    }

    // Setup all process signal handlers
    setupSignalHandlers() {
        // Handle Ctrl+C (SIGINT)
        process.on('SIGINT', () => {
            console.log('\n📨 Received SIGINT (Ctrl+C)');
            this.gracefulShutdown('SIGINT');
        });

        // Handle kill command (SIGTERM)
        process.on('SIGTERM', () => {
            console.log('\n📨 Received SIGTERM (kill)');
            this.gracefulShutdown('SIGTERM');
        });

        // Handle Windows close events
        if (process.platform === 'win32') {
            process.on('SIGBREAK', () => {
                console.log('\n📨 Received SIGBREAK (Windows)');
                this.gracefulShutdown('SIGBREAK');
            });
        }

        // Handle uncaught exceptions
        process.on('uncaughtException', async (error) => {
            console.error('💥 Fatal Uncaught Exception:', error);
            console.error('Stack:', error.stack);
            await this.gracefulShutdown('UNCAUGHT_EXCEPTION');
        });

        // Handle unhandled promise rejections
        process.on('unhandledRejection', async (reason, promise) => {
            console.error('💥 Unhandled Promise Rejection at:', promise);
            console.error('Reason:', reason);
            await this.gracefulShutdown('UNHANDLED_REJECTION');
        });

        // Handle process warnings
        process.on('warning', (warning) => {
            console.warn('⚠️ Process Warning:', warning.name, warning.message);
        });

        console.log('📡 Process signal handlers configured');
    }

    // Get process info for monitoring
    getProcessInfo() {
        return {
            pid: process.pid,
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            platform: os.platform(),
            nodeVersion: process.version,
            isShuttingDown: this.isShuttingDown
        };
    }

    // Check if another instance is running
    async checkExistingInstance() {
        try {
            const pidData = await fs.readFile(this.pidFile, 'utf8');
            const { pid } = JSON.parse(pidData);
            
            // Check if process is actually running
            try {
                process.kill(pid, 0); // Signal 0 just checks if process exists
                return { running: true, pid };
            } catch (error) {
                if (error.code === 'ESRCH') {
                    // Process not found, remove stale PID file
                    await this.removePidFile();
                    return { running: false, pid, stale: true };
                }
                throw error;
            }
        } catch (error) {
            if (error.code === 'ENOENT') {
                return { running: false }; // No PID file
            }
            console.warn(`⚠️ Error checking existing instance: ${error.message}`);
            return { running: false, error: error.message };
        }
    }
}

module.exports = ProcessManager;