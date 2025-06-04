// api-server.js
const express = require('express');
const cors = require('cors');

class DaemonAPIServer {
    constructor(daemon) {
        this.daemon = daemon;
        this.app = express();
        this.server = null;
        this.port = 3847; // Default port
        this.host = '127.0.0.1';
        
        this.setupMiddleware();
        this.setupRoutes();
    }
    
    setupMiddleware() {
        // Enable CORS for localhost only
        this.app.use(cors({
            origin: ['http://127.0.0.1', 'http://localhost'], // Allow specific origins
            credentials: true
        }));
        
        // Parse JSON bodies
        this.app.use(express.json());
        
        // Basic security headers
        this.app.use((req, res, next) => {
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('X-Frame-Options', 'DENY');
            next();
        });
    }
    
    setupRoutes() {
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            const processInfo = {
                status: 'healthy',
                uptime: process.uptime(),
                memory: process.memoryUsage(),
                timestamp: new Date().toISOString(),
                pid: process.pid
            };

            res.json({
                success: true,
                data: processInfo
            });
        });

        // Get current daemon status
        this.app.get('/status', (req, res) => {
            try {
                // Directly use daemon's comprehensive getStats()
                const stats = this.daemon.getStats(); 
                res.json({
                    success: true,
                    data: {
                        isRunning: stats.isRunning,
                        isBlocking: stats.isBlocking,
                        domainsInList: stats.blocklist ? stats.blocklist.domainsInList : 0,
                        dnsQueries: stats.dnsProxy ? stats.dnsProxy.queriesHandledByProxy : 0,
                        dnsBlocked: stats.dnsProxy ? stats.dnsProxy.blockedByProxy : 0,
                        dnsAllowed: stats.dnsProxy ? stats.dnsProxy.allowedByProxy : 0,
                        blockingMethod: stats.blockingMethod || 'dns-proxy',
                        uptimeSeconds: Math.floor((new Date() - new Date(stats.startTime)) / 1000),
                        lastBlocklistUpdate: stats.blocklist ? stats.blocklist.lastUpdate : null,
                        timestamp: new Date().toISOString()
                    }
                });
            } catch (error) {
                console.error('Error getting daemon status via API:', error);
                res.status(500).json({
                    success: false,
                    error: 'Failed to get daemon status',
                    message: error.message
                });
            }
        });

        // Toggle blocking on/off
        this.app.post('/toggle', async (req, res) => {
            try {
                const wasBlocking = this.daemon.isBlocking;

                if (wasBlocking) {
                    // Disable blocking
                    await this.daemon.removeBlocking(); 
                } else {
                    // Enable blocking
                    this.daemon.isBlocking = true; // Set state before applying
                    await this.daemon.applyBlocking();
                }

                const newState = this.daemon.isBlocking;

                res.json({
                    success: true,
                    data: {
                        isBlocking: newState,
                        message: `Blocking ${newState ? 'enabled' : 'disabled'}`,
                        timestamp: new Date().toISOString()
                    }
                });
            } catch (error) {
                console.error('Error toggling blocking via API:', error);
                // If applyBlocking or removeBlocking failed, the daemon's isBlocking state might be out of sync
                // It's important that the daemon methods correctly set isBlocking on failure.
                res.status(500).json({
                    success: false,
                    error: 'Failed to toggle blocking',
                    message: error.message,
                    currentState: this.daemon.isBlocking // Reflect potentially reverted state
                });
            }
        });

        // Get blocking statistics (comprehensive)
        this.app.get('/stats', (req, res) => {
            try {
                const stats = this.daemon.getStats(); // This should be the comprehensive one
                res.json({
                    success: true,
                    data: {
                        ...stats, // Send all stats from daemon.getStats()
                        timestamp: new Date().toISOString()
                    }
                });
            } catch (error) {
                console.error('Error getting stats via API:', error);
                res.status(500).json({
                    success: false,
                    error: 'Failed to get statistics',
                    message: error.message
                });
            }
        });

        // Handle 404s
        this.app.use((req, res) => {
            res.status(404).json({
                success: false,
                error: 'Endpoint not found'
            });
        });

        // Global error handler
        this.app.use((error, req, res, next) => {
            console.error('API Server Error:', error);
            res.status(500).json({
                success: false,
                error: 'Internal server error',
                message: error.message // Be cautious about exposing too much detail in production
            });
        });
    }
    
    start() {
        return new Promise((resolve, reject) => {
            if (this.server && this.server.listening) {
                console.log(`API server already running on http://${this.host}:${this.port}`);
                resolve();
                return;
            }
            this.server = this.app.listen(this.port, this.host, (error) => {
                if (error) {
                    console.error('Failed to start API server:', error);
                    this.server = null; // Ensure server is null if listen failed
                    reject(error);
                    return;
                }
                
                const address = this.server.address();
                this.port = address.port; // Update port if it was dynamically assigned (e.g., port 0)
                this.host = address.address;
                console.log(`🌐 Daemon API server running on http://${this.host}:${this.port}`);
                resolve();
            });
            
            this.server.on('error', (error) => {
                this.server = null; // Ensure server is null on error
                if (error.code === 'EADDRINUSE') {
                    console.error(`API Port ${this.port} is already in use.`);
                } else {
                    console.error('API server error:', error);
                }
                reject(error); // Reject the promise from start()
            });
        });
    }
    
    stop() {
        return new Promise((resolve) => {
            if (this.server) {
                this.server.close(() => {
                    console.log('🔌 API server stopped');
                    this.server = null;
                    resolve();
                });
            } else {
                resolve();
            }
        });
    }

    // Added isRunning method
    isRunning() {
        return !!this.server && this.server.listening;
    }

    // Added getPort method
    getPort() {
        // Return the actual port the server is listening on,
        // which might be different from the initial this.port if port 0 was used.
        if (this.server && this.server.address()) {
            return this.server.address().port;
        }
        return this.port; // Fallback to the configured port if server not started or address not available yet
    }
}

module.exports = DaemonAPIServer;