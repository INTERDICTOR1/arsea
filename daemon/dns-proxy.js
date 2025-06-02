// File: daemon/dns-proxy.js
const dgram = require('dgram');
const dns = require('dns');
const EventEmitter = require('events');

// Simple DNS packet parser/builder (replaces native-dns-packet dependency)
class SimpleDNSPacket {
    static parse(buffer) {
        try {
            // Ensure buffer is long enough for DNS header (12 bytes)
            if (!Buffer.isBuffer(buffer) || buffer.length < 12) {
                throw new Error('DNS packet too short for header');
            }

            // Basic DNS packet parsing
            const header = {
                id: buffer.readUInt16BE(0),
                flags: buffer.readUInt16BE(2),
                questions: buffer.readUInt16BE(4),
                answers: buffer.readUInt16BE(6),
                authority: buffer.readUInt16BE(8),
                additional: buffer.readUInt16BE(10)
            };

            // Extract question section (simplified)
            let offset = 12;
            // Defensive: ensure at least 5 bytes for minimal question (1 label, 1 byte, type, class)
            if (buffer.length < offset + 5) {
                throw new Error('DNS packet too short for question');
            }
            const question = this.parseName(buffer, offset);

            // Defensive: ensure enough bytes for type and class
            if (buffer.length < question.offset + 4) {
                throw new Error('DNS packet too short for type/class');
            }

            return {
                header: {
                    id: header.id,
                    rd: (header.flags & 0x0100) !== 0
                },
                question: [{
                    name: question.name,
                    type: buffer.readUInt16BE(question.offset),
                    class: buffer.readUInt16BE(question.offset + 2)
                }]
            };
        } catch (error) {
            console.error('DNS packet parse error:', error);
            return null;
        }
    }

    static parseName(buffer, offset) {
        const labels = [];
        let jumped = false;
        let jumpOffset = offset;
        let maxLoops = 20; // Prevent infinite loops

        while (maxLoops-- > 0) {
            // Defensive: check offset in bounds
            if (offset >= buffer.length) {
                throw new Error('DNS name parse: offset out of bounds');
            }
            const length = buffer[offset];

            if (length === 0) {
                offset++;
                break;
            }

            if ((length & 0xC0) === 0xC0) {
                // Pointer - follow it
                if (offset + 1 >= buffer.length) {
                    throw new Error('DNS name pointer out of bounds');
                }
                if (!jumped) {
                    jumpOffset = offset + 2;
                    jumped = true;
                }
                offset = ((length & 0x3F) << 8) | buffer[offset + 1];
                continue;
            }

            offset++;
            if (offset + length > buffer.length) {
                throw new Error('DNS label out of bounds');
            }
            const label = buffer.slice(offset, offset + length).toString();
            labels.push(label);
            offset += length;
        }

        return {
            name: labels.join('.').toLowerCase(),
            offset: jumped ? jumpOffset : offset
        };
    }

    static buildResponse(query, blockedIP = '127.0.0.1') {
        const response = Buffer.alloc(512);
        let offset = 0;

        // Header
        response.writeUInt16BE(query.header.id, 0); // ID
        response.writeUInt16BE(0x8180, 2); // Flags (response, recursion available)
        response.writeUInt16BE(1, 4); // Questions
        response.writeUInt16BE(1, 6); // Answers
        response.writeUInt16BE(0, 8); // Authority
        response.writeUInt16BE(0, 10); // Additional

        offset = 12;

        // Question section (copy from original)
        const questionName = query.question[0].name;
        offset = this.writeName(response, offset, questionName);
        response.writeUInt16BE(query.question[0].type, offset);
        response.writeUInt16BE(query.question[0].class, offset + 2);
        offset += 4;

        // Answer section
        offset = this.writeName(response, offset, questionName);
        response.writeUInt16BE(1, offset); // Type A
        response.writeUInt16BE(1, offset + 2); // Class IN
        response.writeUInt32BE(300, offset + 4); // TTL
        response.writeUInt16BE(4, offset + 8); // Data length
        
        // Write IP address
        const ipParts = blockedIP.split('.');
        for (let i = 0; i < 4; i++) {
            response[offset + 10 + i] = parseInt(ipParts[i]);
        }
        offset += 14;

        return response.slice(0, offset);
    }

    static writeName(buffer, offset, name) {
        const labels = name.split('.');
        for (const label of labels) {
            if (label.length > 0) {
                buffer[offset] = label.length;
                offset++;
                buffer.write(label, offset);
                offset += label.length;
            }
        }
        buffer[offset] = 0; // End of name
        return offset + 1;
    }
}

class ArseaDNSProxy extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.server = null;
        this.blockedDomains = new Set();
        this.upstreamDNS = options.upstreamDNS || ['8.8.8.8', '8.8.4.4'];
        this.preferredPort = options.port || 53;
        this.fallbackPort = 5353;
        this.actualPort = null;
        this.isRunning = false;
        this.stats = {
            queries: 0,
            blocked: 0,
            allowed: 0,
            errors: 0
        };

        // Health check interval
        this.healthCheckInterval = null;
    }

    async loadBlocklist(domains) {
        console.log(`📋 Loading ${domains.length} domains into DNS proxy...`);
        this.blockedDomains.clear();
        
        domains.forEach(domain => {
            const cleanDomain = domain.toLowerCase().trim();
            if (cleanDomain) {
                this.blockedDomains.add(cleanDomain);
                this.blockedDomains.add(`www.${cleanDomain}`);
            }
        });
        
        console.log(`✅ Loaded ${this.blockedDomains.size} domains (including www variants)`);
        return { success: true, domains: this.blockedDomains.size };
    }

    async start() {
        if (this.isRunning) {
            return { success: true, port: this.actualPort };
        }

        try {
            // Try preferred port first, then fallback
            const port = await this.tryStartOnPort(this.preferredPort) || 
                         await this.tryStartOnPort(this.fallbackPort);
            
            if (!port) {
                throw new Error('Could not bind to any available port');
            }

            this.actualPort = port;
            this.isRunning = true;
            
            // Start health monitoring
            this.startHealthCheck();
            
            console.log(`✅ ARSEA DNS Proxy running on 127.0.0.1:${this.actualPort}`);
            this.emit('started', { port: this.actualPort });
            
            return { success: true, port: this.actualPort };
            
        } catch (error) {
            console.error('❌ DNS Proxy start failed:', error.message);
            this.emit('error', error);
            return { success: false, error: error.message };
        }
    }

    async tryStartOnPort(port) {
        return new Promise((resolve) => {
            const server = dgram.createSocket('udp4');
            
            const cleanup = () => {
                try {
                    server.removeAllListeners();
                    server.close();
                } catch {}
            };

            const timeout = setTimeout(() => {
                cleanup();
                resolve(null);
            }, 5000);

            server.on('error', (err) => {
                clearTimeout(timeout);
                cleanup();
                console.log(`⚠️ Port ${port} unavailable: ${err.message}`);
                resolve(null);
            });

            server.on('listening', () => {
                clearTimeout(timeout);
                console.log(`✅ Successfully bound to port ${port}`);
                
                // Set up message handler
                server.on('message', (message, rinfo) => {
                    this.handleDNSQuery(message, rinfo);
                });

                server.on('error', (err) => {
                    console.error('❌ DNS server runtime error:', err);
                    this.emit('error', err);
                });

                this.server = server;
                resolve(port);
            });

            try {
                server.bind(port, '127.0.0.1');
            } catch (err) {
                clearTimeout(timeout);
                cleanup();
                resolve(null);
            }
        });
    }

    handleDNSQuery(message, client) {
        try {
            this.stats.queries++;
            const query = SimpleDNSPacket.parse(message);
            if (!query || !query.question || query.question.length === 0) {
                // Just ignore malformed packets
                return;
            }

            const domain = query.question[0].name;
            const queryType = query.question[0].type;

            // Only handle A records (IPv4) and AAAA records (IPv6)
            if (queryType !== 1 && queryType !== 28) {
                this.forwardQuery(message, client);
                return;
            }

            if (this.isBlocked(domain)) {
                this.stats.blocked++;
                this.sendBlockedResponse(query, client);
                console.log(`🚫 BLOCKED: ${domain}`);
                this.emit('query', domain, true);
            } else {
                this.stats.allowed++;
                this.forwardQuery(message, client);
                this.emit('query', domain, false);
            }
            
        } catch (error) {
            this.stats.errors++;
            console.error('❌ DNS Query handling error:', error);
            this.emit('error', error);
        }
    }

    isBlocked(domain) {
        if (!domain) return false;
        
        const cleanDomain = domain.toLowerCase();
        
        // Direct match
        if (this.blockedDomains.has(cleanDomain)) {
            return true;
        }

        // Check subdomains
        const parts = cleanDomain.split('.');
        for (let i = 0; i < parts.length - 1; i++) {
            const parentDomain = parts.slice(i).join('.');
            if (this.blockedDomains.has(parentDomain)) {
                return true;
            }
        }

        return false;
    }

    sendBlockedResponse(query, client) {
        try {
            const response = SimpleDNSPacket.buildResponse(query, '127.0.0.1');
            this.server.send(response, client.port, client.address, (err) => {
                if (err) {
                    console.error('❌ Failed to send blocked response:', err);
                }
            });
        } catch (error) {
            console.error('❌ Error creating blocked response:', error);
        }
    }

    forwardQuery(message, client) {
        const upstreamServer = this.upstreamDNS[Math.floor(Math.random() * this.upstreamDNS.length)];
        const forwardSocket = dgram.createSocket('udp4');
        
        const cleanup = () => {
            try {
                forwardSocket.removeAllListeners();
                forwardSocket.close();
            } catch {}
        };

        const timeout = setTimeout(() => {
            cleanup();
        }, 5000);

        forwardSocket.on('error', (err) => {
            clearTimeout(timeout);
            cleanup();
            console.error('❌ Forward query error:', err);
        });

        forwardSocket.on('message', (response) => {
            clearTimeout(timeout);
            this.server.send(response, client.port, client.address, (err) => {
                if (err) {
                    console.error('❌ Failed to send forwarded response:', err);
                }
                cleanup();
            });
        });

        forwardSocket.send(message, 53, upstreamServer, (err) => {
            if (err) {
                clearTimeout(timeout);
                cleanup();
                console.error('❌ Failed to forward query:', err);
            }
        });
    }

    startHealthCheck() {
        this.healthCheckInterval = setInterval(() => {
            if (this.server && this.isRunning) {
                // Simple health check - verify server is still bound
                try {
                    const address = this.server.address();
                    if (!address) {
                        console.error('❌ DNS proxy health check failed - server not bound');
                        this.emit('error', new Error('DNS proxy lost binding'));
                    }
                } catch (error) {
                    console.error('❌ DNS proxy health check error:', error);
                    this.emit('error', error);
                }
            }
        }, 30000); // Check every 30 seconds
    }

    async stop() {
        if (!this.isRunning) {
            return { success: true };
        }

        return new Promise((resolve) => {
            // Clear health check
            if (this.healthCheckInterval) {
                clearInterval(this.healthCheckInterval);
                this.healthCheckInterval = null;
            }

            if (this.server) {
                this.server.close(() => {
                    this.isRunning = false;
                    this.actualPort = null;
                    console.log('✅ DNS Proxy stopped cleanly');
                    this.emit('stopped');
                    resolve({ success: true });
                });
            } else {
                this.isRunning = false;
                this.actualPort = null;
                this.emit('stopped');
                resolve({ success: true });
            }
        });
    }

    getPort() {
        return this.actualPort;
    }

    getStats() {
        return {
            ...this.stats,
            blockedDomains: this.blockedDomains.size,
            isRunning: this.isRunning,
            port: this.actualPort,
            upstreamDNS: this.upstreamDNS,
            blockRate: this.stats.queries > 0 ? 
                Math.round((this.stats.blocked / this.stats.queries) * 100) : 0
        };
    }

    // Test method to verify DNS proxy is working
    async test() {
        return new Promise((resolve) => {
            if (!this.isRunning) {
                resolve({ success: false, error: 'DNS proxy not running' });
                return;
            }

            const testClient = dgram.createSocket('udp4');
            const testDomain = 'google.com';
            
            // Create a simple DNS query for google.com
            const query = Buffer.from([
                0x12, 0x34, // ID
                0x01, 0x00, // Flags
                0x00, 0x01, // Questions
                0x00, 0x00, // Answers
                0x00, 0x00, // Authority
                0x00, 0x00, // Additional
                0x06, 0x67, 0x6f, 0x6f, 0x67, 0x6c, 0x65, // "google"
                0x03, 0x63, 0x6f, 0x6d, // "com"
                0x00, // End of name
                0x00, 0x01, // Type A
                0x00, 0x01  // Class IN
            ]);

            const timeout = setTimeout(() => {
                testClient.close();
                resolve({ success: false, error: 'Test timeout' });
            }, 5000);

            testClient.on('message', (response) => {
                clearTimeout(timeout);
                testClient.close();
                resolve({ success: true, responseSize: response.length });
            });

            testClient.on('error', (err) => {
                clearTimeout(timeout);
                testClient.close();
                resolve({ success: false, error: err.message });
            });

            testClient.send(query, this.actualPort, '127.0.0.1');
        });
    }
}

module.exports = ArseaDNSProxy;