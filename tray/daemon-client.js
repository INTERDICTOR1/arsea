const axios = require('axios');

class DaemonClient {
    constructor(options = {}) {
        this.baseURL = options.baseURL || 'http://127.0.0.1:3847';
        this.timeout = options.timeout || 5000;
        this.retryAttempts = options.retryAttempts || 3;
        this.retryDelay = options.retryDelay || 1000;
        
        // Create axios instance with default config
        this.client = axios.create({
            baseURL: this.baseURL,
            timeout: this.timeout,
            headers: {
                'Content-Type': 'application/json',
            }
        });
        
        // Add response interceptor for error handling
        this.client.interceptors.response.use(
            (response) => response,
            (error) => {
                if (error.code === 'ECONNREFUSED') {
                    throw new Error('Daemon is not running or API server is unavailable');
                } else if (error.code === 'ETIMEDOUT') {
                    throw new Error('Request timed out - daemon may be unresponsive');
                } else if (error.response) {
                    throw new Error(`API Error: ${error.response.data?.message || error.response.statusText}`);
                } else {
                    throw new Error(`Network Error: ${error.message}`);
                }
            }
        );
    }
    
    /**
     * Helper method to retry failed requests
     */
    async withRetry(operation, attempts = this.retryAttempts) {
        for (let i = 0; i < attempts; i++) {
            try {
                return await operation();
            } catch (error) {
                if (i === attempts - 1) {
                    throw error;
                }
                console.log(`Retry attempt ${i + 1}/${attempts} failed:`, error.message);
                await this.delay(this.retryDelay);
            }
        }
    }
    
    /**
     * Delay helper for retries
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    /**
     * Check if daemon API is reachable
     */
    async checkHealth() {
        try {
            const response = await this.client.get('/health');
            return {
                success: true,
                data: response.data
            };
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
    
    /**
     * Get current daemon status
     */
    async getStatus() {
        return await this.withRetry(async () => {
            const response = await this.client.get('/status');
            if (response.data.success) {
                return response.data.data;
            } else {
                throw new Error(response.data.error || 'Failed to get status');
            }
        });
    }
    
    /**
     * Toggle blocking on/off
     */
    async toggleBlocking() {
        return await this.withRetry(async () => {
            const response = await this.client.post('/toggle');
            if (response.data.success) {
                return response.data.data;
            } else {
                throw new Error(response.data.error || 'Failed to toggle blocking');
            }
        });
    }
    
    /**
     * Get detailed statistics
     */
    async getStats() {
        return await this.withRetry(async () => {
            const response = await this.client.get('/stats');
            if (response.data.success) {
                return response.data.data;
            } else {
                throw new Error(response.data.error || 'Failed to get statistics');
            }
        });
    }
    
    /**
     * Check if daemon is running and accessible
     */
    async isDaemonRunning() {
        try {
            const health = await this.checkHealth();
            return health.success;
        } catch (error) {
            return false;
        }
    }
    
    /**
     * Wait for daemon to become available
     */
    async waitForDaemon(maxWaitTime = 30000) {
        const startTime = Date.now();
        const pollInterval = 1000;
        
        console.log('Waiting for daemon to become available...');
        
        while (Date.now() - startTime < maxWaitTime) {
            if (await this.isDaemonRunning()) {
                console.log('✅ Daemon is available');
                return true;
            }
            
            console.log('⏳ Daemon not ready, waiting...');
            await this.delay(pollInterval);
        }
        
        console.log('❌ Timeout waiting for daemon');
        return false;
    }
    
    /**
     * Get simplified status for tray display
     */
    async getTrayStatus() {
        try {
            const status = await this.getStatus();
            return {
                isAvailable: true,
                isBlocking: status.isBlocking,
                domainsBlocked: status.dnsBlocked || 0,
                totalDomains: status.domainsInList || 0,
                uptime: status.uptime || 0
            };
        } catch (error) {
            return {
                isAvailable: false,
                isBlocking: false,
                error: error.message,
                domainsBlocked: 0,
                totalDomains: 0,
                uptime: 0
            };
        }
    }
}

module.exports = DaemonClient;