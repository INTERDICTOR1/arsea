// tray/daemon-health-monitor.js
// Health monitoring and auto-reconnect for tray app

const EventEmitter = require('events');

class DaemonHealthMonitor extends EventEmitter {
    constructor(daemonClient, options = {}) {
        super();
        this.daemonClient = daemonClient;
        this.isHealthy = false;
        this.isMonitoring = false;
        this.healthCheckInterval = options.healthCheckInterval || 5000; // 5 seconds
        this.maxRetries = options.maxRetries || 3;
        this.retryDelay = options.retryDelay || 2000; // 2 seconds
        this.currentRetries = 0;
        this.lastHealthCheck = null;
        this.intervalId = null;
        this.isReconnecting = false;
    }

    // Start health monitoring
    start() {
        if (this.isMonitoring) {
            console.log('Health monitor already running');
            return;
        }

        console.log('🏥 Starting daemon health monitor...');
        this.isMonitoring = true;
        
        // Initial health check
        this.performHealthCheck();
        
        // Set up periodic health checks
        this.intervalId = setInterval(() => {
            this.performHealthCheck();
        }, this.healthCheckInterval);

        console.log(`✅ Health monitor started (checking every ${this.healthCheckInterval}ms)`);
    }

    // Stop health monitoring
    stop() {
        if (!this.isMonitoring) return;

        console.log('🛑 Stopping daemon health monitor...');
        this.isMonitoring = false;
        
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }

        console.log('✅ Health monitor stopped');
    }

    // Perform single health check
    async performHealthCheck() {
        if (!this.isMonitoring || this.isReconnecting) return;

        try {
            const startTime = Date.now();
            const healthResponse = await this.daemonClient.checkHealth();
            const responseTime = Date.now() - startTime;
            
            if (healthResponse.success) {
                // Daemon is healthy
                if (!this.isHealthy) {
                    console.log('✅ Daemon connection restored');
                    this.isHealthy = true;
                    this.currentRetries = 0;
                    this.emit('health-restored', { responseTime });
                }
                
                this.lastHealthCheck = new Date();
                this.emit('health-check', { 
                    healthy: true, 
                    responseTime,
                    timestamp: this.lastHealthCheck 
                });
                
            } else {
                throw new Error(healthResponse.error || 'Health check failed');
            }
            
        } catch (error) {
            await this.handleHealthCheckFailure(error);
        }
    }

    // Handle health check failure
    async handleHealthCheckFailure(error) {
        console.warn(`⚠️ Daemon health check failed: ${error.message}`);
        
        const wasHealthy = this.isHealthy;
        this.isHealthy = false;
        this.currentRetries++;

        if (wasHealthy) {
            console.log('❌ Daemon connection lost');
            this.emit('health-lost', { error: error.message, retries: this.currentRetries });
        }

        // Emit health check failure
        this.emit('health-check', { 
            healthy: false, 
            error: error.message,
            retries: this.currentRetries,
            timestamp: new Date()
        });

        // Try to reconnect if we haven't exceeded max retries
        if (this.currentRetries <= this.maxRetries && !this.isReconnecting) {
            await this.attemptReconnect();
        } else if (this.currentRetries > this.maxRetries) {
            console.error(`❌ Max reconnection attempts (${this.maxRetries}) exceeded`);
            this.emit('max-retries-exceeded', { retries: this.currentRetries });
        }
    }

    // Attempt to reconnect to daemon
    async attemptReconnect() {
        if (this.isReconnecting) return;

        this.isReconnecting = true;
        console.log(`🔄 Attempting to reconnect to daemon (attempt ${this.currentRetries}/${this.maxRetries})...`);
        
        this.emit('reconnecting', { attempt: this.currentRetries, maxRetries: this.maxRetries });

        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, this.retryDelay));

        try {
            // Try to get daemon status (more comprehensive than health check)
            const statusResponse = await this.daemonClient.getStatus();
            
            if (statusResponse.success) {
                console.log('✅ Reconnection successful');
                this.isHealthy = true;
                this.currentRetries = 0;
                this.isReconnecting = false;
                this.emit('reconnected', statusResponse.data);
                return true;
            } else {
                throw new Error(statusResponse.error || 'Status check failed');
            }
            
        } catch (error) {
            console.warn(`❌ Reconnection attempt ${this.currentRetries} failed: ${error.message}`);
            this.isReconnecting = false;
            return false;
        }
    }

    // Force a health check now
    async forceHealthCheck() {
        console.log('🔍 Forcing immediate health check...');
        await this.performHealthCheck();
    }

    // Get current health status
    getHealthStatus() {
        return {
            isHealthy: this.isHealthy,
            isMonitoring: this.isMonitoring,
            isReconnecting: this.isReconnecting,
            currentRetries: this.currentRetries,
            maxRetries: this.maxRetries,
            lastHealthCheck: this.lastHealthCheck,
            healthCheckInterval: this.healthCheckInterval
        };
    }

    // Reset health monitor (useful for manual reconnection)
    reset() {
        console.log('🔄 Resetting health monitor...');
        this.currentRetries = 0;
        this.isReconnecting = false;
        this.isHealthy = false;
        this.lastHealthCheck = null;
    }

    // Update monitoring settings
    updateSettings(newSettings = {}) {
        if (newSettings.healthCheckInterval && newSettings.healthCheckInterval !== this.healthCheckInterval) {
            this.healthCheckInterval = newSettings.healthCheckInterval;
            
            // Restart monitoring with new interval
            if (this.isMonitoring) {
                this.stop();
                this.start();
            }
        }

        if (newSettings.maxRetries !== undefined) {
            this.maxRetries = newSettings.maxRetries;
        }

        if (newSettings.retryDelay !== undefined) {
            this.retryDelay = newSettings.retryDelay;
        }

        console.log('⚙️ Health monitor settings updated:', {
            healthCheckInterval: this.healthCheckInterval,
            maxRetries: this.maxRetries,
            retryDelay: this.retryDelay
        });
    }
}

module.exports = DaemonHealthMonitor;