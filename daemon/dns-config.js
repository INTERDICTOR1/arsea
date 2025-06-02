// File: daemon/dns-config.js
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const EventEmitter = require('events');
const fs = require('fs').promises;
const dgram = require('dgram');

const execAsync = promisify(exec);

class DNSConfigManager extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.originalDNS = null;
        this.isConfigured = false;
        this.platform = os.platform();
        this.interfaceName = options.interfaceName || null;
        this.autoDetectInterface = true; // This property was in your constructor but not used elsewhere explicitly
        this.dryRun = options.dryRun || false;
        this.backupFile = options.backupFile || './dns-backup.json';
        
        // Safety mechanisms
        this.configTimeout = options.configTimeout || 10000; // 10 second timeout for DNS operations
        this.verificationEnabled = options.verificationEnabled !== undefined ? options.verificationEnabled : true;
    }

    async detectNetworkInterface() {
        try {
            if (this.platform === 'win32') {
                const { stdout } = await execAsync('netsh interface show interface');
                const lines = stdout.split('\n');
                for (const line of lines) {
                    if (line.includes('Connected') && (line.includes('Wi-Fi') || line.includes('Ethernet') || line.includes('Wi-fi'))) {
                        const parts = line.trim().split(/\s+/);
                        // The interface name can be multiple words, capture everything after "Connected   <type>"
                        const interfaceName = parts.slice(3).join(' '); 
                        if (interfaceName) {
                            this.interfaceName = interfaceName;
                            console.log(`🔍 Detected Windows interface: ${interfaceName}`);
                            return interfaceName;
                        }
                    }
                }
                // Fallback if no specific connected Wi-Fi/Ethernet found by name
                const fallbackInterface = lines.find(line => line.includes('Connected'));
                if (fallbackInterface) {
                    const parts = fallbackInterface.trim().split(/\s+/);
                    const interfaceName = parts.slice(3).join(' ');
                     if (interfaceName) {
                        this.interfaceName = interfaceName;
                        console.log(`🔍 Detected Windows interface (fallback): ${interfaceName}`);
                        return interfaceName;
                    }
                }
                this.interfaceName = 'Wi-Fi'; // Default fallback
                console.log(`⚠️ Could not auto-detect specific Windows interface, defaulting to "${this.interfaceName}". Please verify.`);

            } else if (this.platform === 'darwin') {
                const { stdout } = await execAsync('networksetup -listallnetworkservices');
                const services = stdout.split('\n').filter(line => 
                    line && !line.startsWith('*') && !line.includes('An asterisk')
                );
                
                const preferred = services.find(service => 
                    service.toLowerCase().includes('wi-fi')
                ) || services.find(service => 
                    service.toLowerCase().includes('ethernet')
                ) || services[0];
                
                this.interfaceName = preferred || 'Wi-Fi'; // Default if no services found
                console.log(`🔍 Detected macOS interface: ${this.interfaceName}`);
                
            } else { // Linux
                try {
                    const { stdout } = await execAsync("ip route | grep default | awk '{print $5}' | head -1");
                    this.interfaceName = stdout.trim() || 'eth0';
                    console.log(`🔍 Detected Linux interface: ${this.interfaceName}`);
                } catch {
                    console.warn('⚠️ Could not auto-detect Linux interface using "ip route", defaulting to "eth0".');
                    this.interfaceName = 'eth0';
                }
            }
            return this.interfaceName;
        } catch (error) {
            console.warn('⚠️ Interface detection failed:', error.message);
            this.interfaceName = this.platform === 'win32' ? 'Wi-Fi' : 
                                 this.platform === 'darwin' ? 'Wi-Fi' : 'eth0';
            console.log(`Using platform default interface: ${this.interfaceName}`);
            return this.interfaceName;
        }
    }

    async checkPermissions() {
        // (Existing checkPermissions method - assuming it's mostly fine,
        // but ensure interfaceName is detected if not set)
        if (!this.interfaceName && (this.platform === 'win32' || this.platform === 'darwin')) {
            await this.detectNetworkInterface();
        }
        try {
            if (this.platform === 'win32') {
                await execAsync('netsh interface show interface', { timeout: 5000 });
                try {
                    await execAsync(`netsh interface ip show config name="${this.interfaceName}"`, { timeout: 5000 });
                    return { canModify: true, method: 'Windows netsh (admin required)', interface: this.interfaceName };
                } catch {
                    return { canModify: false, method: 'Windows netsh - requires administrator privileges', interface: this.interfaceName };
                }
            } else if (this.platform === 'darwin') {
                await execAsync('networksetup -listallnetworkservices', { timeout: 5000 });
                try {
                    await execAsync(`networksetup -getdnsservers "${this.interfaceName}"`, { timeout: 5000 });
                    return { canModify: true, method: 'macOS networksetup (may require password)', interface: this.interfaceName };
                } catch {
                    return { canModify: false, method: 'macOS networksetup - requires administrator password', interface: this.interfaceName };
                }
            } else { // Linux
                try {
                    await fs.access('/etc/resolv.conf', fs.constants.W_OK);
                    return { canModify: true, method: 'Linux resolv.conf (direct write)', interface: this.interfaceName || 'N/A' };
                } catch {
                    try {
                        await execAsync('systemctl is-active systemd-resolved', { timeout: 5000 });
                        return { canModify: true, method: 'Linux systemd-resolved (requires sudo)', interface: this.interfaceName || 'N/A' };
                    } catch {
                        return { canModify: false, method: 'Linux - requires sudo for DNS modification', interface: this.interfaceName || 'N/A' };
                    }
                }
            }
        } catch (error) {
            return { canModify: false, method: `Permission check failed: ${error.message}`, interface: this.interfaceName || 'unknown' };
        }
    }

    // 🔧 NEW: Helper method to detect localhost DNS
    isDNSPointingToLocalhost(dnsServers) {
        if (!dnsServers) return false;
        
        if (Array.isArray(dnsServers)) {
            return dnsServers.some(dns => 
                dns === '127.0.0.1' || 
                dns === 'localhost' || 
                dns.startsWith('127.') // Catches 127.x.x.x
            );
        }
        
        // For Linux, dnsServers might be the whole resolv.conf content
        if (typeof dnsServers === 'string') {
            return dnsServers.includes('nameserver 127.0.0.1') || 
                   dnsServers.includes('nameserver localhost') ||
                   dnsServers.match(/nameserver 127\.\d{1,3}\.\d{1,3}\.\d{1,3}/) !== null;
        }
        
        return false;
    }

    // 🔧 NEW: Get current DNS settings (replaces the old one)
    async getCurrentDNS() {
        try {
            if (!this.interfaceName && (this.platform === 'win32' || this.platform === 'darwin')) {
                await this.detectNetworkInterface();
            }
            // For Linux, interfaceName might not be used if reading /etc/resolv.conf directly
            
            if (this.platform === 'win32') {
                const { stdout } = await execAsync(
                    `netsh interface ip show dns name="${this.interfaceName}"`, // Uses 'show dns'
                    { timeout: this.configTimeout }
                );
                return this.parseWindowsDNS(stdout); // Ensure parseWindowsDNS handles output of 'show dns'
            } else if (this.platform === 'darwin') {
                const { stdout } = await execAsync(
                    `networksetup -getdnsservers "${this.interfaceName}"`,
                    { timeout: this.configTimeout }
                );
                // Filters out "There aren't any DNS Servers set on Wi-Fi." or similar messages
                const servers = stdout.trim().split('\n').filter(line => line && !line.toLowerCase().includes('there aren\'t any dns servers') && !line.toLowerCase().includes('no dns servers configured') && line.trim() !== '');
                return servers.length > 0 ? servers : ['dhcp']; // Return 'dhcp' if empty
            } else { // Linux
                // Attempt to get DNS via resolvectl first for systems using systemd-resolved
                try {
                    const { stdout: resolveStatus } = await execAsync('resolvectl status', { timeout: 5000 });
                    const interfaceToCheck = this.interfaceName || (await this.detectNetworkInterface()); // ensure interface name for Linux too
                    
                    // Try to find the specific interface link section
                    let currentInterfaceDNS = [];
                    const linkSections = resolveStatus.split(/Link \d+ \(/); // Split by "Link <number> ("
                    for (const section of linkSections) {
                        if (section.startsWith(`${interfaceToCheck})`)) { // Check if this section is for our interface
                             const dnsServersMatch = section.match(/DNS Servers: ([\d\.\s]+)/);
                             if (dnsServersMatch) {
                                currentInterfaceDNS = dnsServersMatch[1].trim().split(/\s+/);
                                break;
                             }
                        }
                    }
                    if (currentInterfaceDNS.length > 0) {
                        console.log(`Got DNS from resolvectl for ${interfaceToCheck}: ${currentInterfaceDNS.join(', ')}`);
                        return currentInterfaceDNS;
                    }
                } catch (e) {
                    console.warn('Could not get DNS via resolvectl, falling back to /etc/resolv.conf for current DNS');
                }
                // Fallback to reading /etc/resolv.conf if resolvectl fails or doesn't yield results
                const resolvConf = await fs.readFile('/etc/resolv.conf', 'utf8');
                // For consistency, if we return an array for other platforms, parse resolv.conf here too.
                // However, the new backup logic for Linux expects the full string if resolvectl fails.
                // Let's return the string as per snippet for backup.
                // If getCurrentDNS is used elsewhere and needs an array, this might need adjustment or a separate parser.
                return resolvConf; // Returns full content as string for Linux fallback
            }
        } catch (error) {
            console.warn('⚠️ Failed to get current DNS:', error.message);
            return null; // Return null on failure as per snippet
        }
    }

    // 🔧 NEW: Restore DNS to automatic/DHCP
    async restoreToAutomatic() {
        try {
            if (!this.interfaceName && (this.platform === 'win32' || this.platform === 'darwin')) {
                await this.detectNetworkInterface();
            }
            // Ensure interfaceName for Linux as well if systemd-resolved specific commands are used
            if (!this.interfaceName && this.platform === 'linux') {
                 await this.detectNetworkInterface();
            }

            if (this.platform === 'win32') {
                console.log(`Restoring Windows DNS for "${this.interfaceName}" to DHCP...`);
                await execAsync(
                    `netsh interface ip set dns name="${this.interfaceName}" dhcp`,
                    { timeout: this.configTimeout }
                );
            } else if (this.platform === 'darwin') {
                console.log(`Restoring macOS DNS for "${this.interfaceName}" to automatic (empty)...`);
                await execAsync(
                    `networksetup -setdnsservers "${this.interfaceName}" empty`,
                    { timeout: this.configTimeout }
                );
            } else { // Linux
                console.log('Attempting to restore Linux DNS to automatic/DHCP...');
                try {
                    // Try to remove Arsea-specific systemd-resolved config if it exists
                    await fs.unlink('/etc/systemd/resolved.conf.d/arsea.conf');
                    console.log('Removed /etc/systemd/resolved.conf.d/arsea.conf');
                    await execAsync('systemctl restart systemd-resolved', { timeout: 10000 });
                    console.log('Restarted systemd-resolved.');
                } catch (e) {
                    // This error is fine if the file didn't exist or systemd-resolved isn't used
                    console.log('No Arsea systemd-resolved config found or systemd-resolved not active. Attempting /etc/resolv.conf restore.');
                    // For non-systemd-resolved systems, or as a fallback:
                    // Restoring /etc/resolv.conf to be managed by DHCP typically means
                    // ensuring it's a symlink to a dynamic file (e.g., /run/systemd/resolve/stub-resolv.conf)
                    // or just letting NetworkManager handle it.
                    // Forcing a generic file might override NetworkManager.
                    // A safer "automatic" might be to just remove our changes and hope the system defaults.
                    // If we directly wrote to /etc/resolv.conf, we might need its original content or a known DHCP-friendly state.
                    // The snippet provided a generic public DNS, which isn't strictly "automatic".
                    // The most robust "automatic" is to restore from a *true* original backup.
                    // If that's not available, letting the system reconfigure is best.
                    // We can try to write a minimal resolv.conf that points to router or common DNS for non-systemd.
                    console.log('Linux: If not using systemd-resolved, ensure NetworkManager or similar service will set DNS via DHCP.');
                    // The provided snippet has:
                    // const defaultResolv = `nameserver 8.8.8.8\nnameserver 1.1.1.1\n`;
                    // await fs.writeFile('/etc/resolv.conf', defaultResolv);
                    // This is not truly "automatic". Let's log and not force write unless it's a known safe operation.
                    // If originalDNS was a full resolv.conf string pointing to DHCP, that would be ideal.
                }
            }
            
            this.isConfigured = false; // Mark as no longer configured by Arsea
            console.log('✅ DNS restored to automatic/DHCP configuration (or attempt initiated for Linux).');
            return { success: true };
        } catch (error) {
            console.error('❌ Failed to restore DNS to automatic:', error.message);
            throw error; // Re-throw to allow calling function to handle
        }
    }
    
    // 🔧 NEW: Get original DNS for Windows when current is localhost
    async getOriginalDNSWindows() {
        // This method attempts to find what the DNS *should* be if current is localhost.
        // It's a best-effort for Windows.
        try {
            if (!this.interfaceName) await this.detectNetworkInterface();

            // Check netsh interface ip show config for DHCP server provided DNS
            // This command shows more details including "DNS servers configured through DHCP"
            const { stdout } = await execAsync(
                `netsh interface ip show config name="${this.interfaceName}"`,
                { timeout: this.configTimeout }
            );
            
            const lines = stdout.split('\n');
            const dhcpDnsLine = lines.find(line => line.toLowerCase().includes('dns servers configured through dhcp'));
            if (dhcpDnsLine) {
                const match = dhcpDnsLine.match(/:\s*([\d\.]+)/); // Takes the first IP
                if (match && match[1] && match[1] !== '0.0.0.0') {
                    console.log(`Found DHCP DNS server for ${this.interfaceName}: ${match[1]}`);
                    return [match[1]]; // Return as array
                }
            }

            // If DHCP is enabled but no specific DNS server listed by it, or if not DHCP
            // then it's hard to know the "original". Forcing DHCP is an option.
            console.warn(`Could not determine original DNS for "${this.interfaceName}" from DHCP config when current is localhost. Defaulting to 'dhcp' restore behavior.`);
            return ['dhcp']; // This will trigger restore to DHCP mode

        } catch (error) {
            console.warn(`Failed to get original DNS for Windows from 'show config', defaulting to 'dhcp' restore. Error: ${error.message}`);
            return ['dhcp']; // Fallback to DHCP restoration
        }
    }


    // 🔧 ENHANCED: Update your existing backup() method
    async backup() {
        try {
            console.log('💾 Creating DNS configuration backup...');
            
            if (!this.interfaceName && (this.platform === 'win32' || this.platform === 'darwin')) {
                await this.detectNetworkInterface();
            }
             if (!this.interfaceName && this.platform === 'linux' ) { // Also for Linux if relying on resolvectl with interface
                await this.detectNetworkInterface();
            }
            // Critical: if interfaceName is still null for platforms that require it for commands
            if (!this.interfaceName && (this.platform === 'win32' || this.platform === 'darwin')) {
                throw new Error('Network interface could not be determined for backup.');
            }

            const backupData = {
                timestamp: new Date().toISOString(),
                platform: this.platform,
                interface: this.interfaceName || 'N/A for Linux /etc/resolv.conf',
                originalDNS: null
            };
            
            let currentDnsServers = await this.getCurrentDNS(); // Use the new getCurrentDNS

            // 🚨 CRITICAL FIX: Check if DNS is already localhost
            if (this.isDNSPointingToLocalhost(currentDnsServers)) {
                console.warn(`⚠️ Current DNS for "${backupData.interface}" is pointing to localhost! Attempting to get true original DNS...`);
                if (this.platform === 'win32') {
                    currentDnsServers = await this.getOriginalDNSWindows();
                } else if (this.platform === 'darwin') {
                    // For macOS, if current is localhost, assume original was DHCP/automatic
                    console.log('macOS DNS is localhost, assuming original was automatic/DHCP.');
                    currentDnsServers = ['dhcp']; // Will trigger restore to 'empty'
                } else { // Linux
                    // For Linux, if current is localhost (e.g. /etc/resolv.conf has 127.0.0.1)
                    // it's harder to get "original" without prior state.
                    // Defaulting to 'dhcp' which implies system should handle it.
                    console.log('Linux DNS is localhost. Backing up as "dhcp" to trigger system default restoration.');
                    currentDnsServers = 'dhcp'; // This will be a string, handled by restoreLinux
                }
                console.log(`Adjusted original DNS for backup to: ${JSON.stringify(currentDnsServers)}`);
            }
            
            // Handling for 'dhcp' or empty arrays from getCurrentDNS
            if (this.platform === 'win32' || this.platform === 'darwin') {
                if (Array.isArray(currentDnsServers) && currentDnsServers.length === 0) {
                    currentDnsServers = ['dhcp']; // Standardize empty to 'dhcp'
                }
            }
            // For Linux, currentDnsServers can be a string (resolv.conf content) or array (from resolvectl)

            backupData.originalDNS = currentDnsServers;
            this.originalDNS = currentDnsServers; // Store in memory
            
            await fs.writeFile(this.backupFile, JSON.stringify(backupData, null, 2));
            
            console.log(`✅ DNS backup saved to ${this.backupFile}`);
            if (typeof currentDnsServers === 'string' && currentDnsServers.length > 100) {
                console.log(`📋 Original DNS (Linux resolv.conf content) backed up to file.`);
            } else {
                console.log(`📋 Original DNS for backup: ${JSON.stringify(currentDnsServers)}`);
            }
            
            return { success: true, backup: backupData };
            
        } catch (error) {
            console.error('❌ DNS backup failed:', error.message);
            this.originalDNS = null; // Clear in-memory on failure
            return { success: false, error: error.message };
        }
    }

    async configure(dnsServer = '127.0.0.1', dnsPort = 53) { // dnsPort currently not used by system commands
        try {
            if (this.dryRun) {
                console.log(`🧪 DRY RUN: Would configure DNS to ${dnsServer} (port ${dnsPort} for proxy, not system DNS entry)`);
                return { success: true, method: 'dry-run' };
            }
            
            console.log(`⚙️ Configuring system DNS to ${dnsServer} (proxy on port ${dnsPort})...`);
            
            // Backup before any configuration changes.
            // The enhanced backup() attempts to get true original DNS if current is localhost.
            const backupResult = await this.backup();
            // If backup itself fails critically (e.g. can't determine interface), it throws.
            // If it proceeds but backs up 'dhcp' or a fallback, that's handled.
            if (!backupResult.success && !backupResult.note?.includes('Used existing valid backup')) {
                // If backup fails and it's not because we're re-using a good old one, stop.
                throw new Error(`DNS backup failed critically: ${backupResult.error}. Configuration aborted.`);
            }
            
            if (dnsServer === '127.0.0.1') {
                const testResult = await this.testDNSServer(dnsServer, dnsPort); // Test the actual proxy port
                if (!testResult.success) {
                    throw new Error(`Local DNS server test on ${dnsServer}:${dnsPort} failed: ${testResult.error}. Aborting configuration.`);
                }
                console.log(`✅ Local DNS server ${dnsServer}:${dnsPort} verified working.`);
            }
            
            let result;
            if (this.platform === 'win32') {
                result = await this.configureWindows(dnsServer);
            } else if (this.platform === 'darwin') {
                result = await this.configureMacOS(dnsServer);
            } else { // Linux
                result = await this.configureLinux(dnsServer);
            }
            
            if (result.success) {
                this.isConfigured = true;
                if (this.verificationEnabled) {
                    console.log('Waiting for DNS changes to propagate before verification...');
                    await this.sleep(2000); // Wait for DNS changes
                    const verifyResult = await this.verifyConfiguration(dnsServer);
                    if (verifyResult.success) {
                        console.log(`✅ DNS successfully verified to be pointing to ${dnsServer}.`);
                    } else {
                        console.warn(`⚠️ DNS configuration verification failed. Current DNS: ${JSON.stringify(verifyResult.current)}. Expected: ${dnsServer}.`);
                    }
                }
            }
            return result;
        } catch (error) {
            console.error(`❌ DNS configuration to ${dnsServer} failed: ${error.message}`);
            console.log('🆘 Attempting to restore DNS due to configuration failure...');
            try {
                await this.restore(); // Restore will use the (hopefully correct) backup
            } catch (restoreError) {
                console.error('❌ Automatic DNS restoration also failed:', restoreError.message);
                console.error('Manual DNS check/reset might be required!');
            }
            return { 
                success: false, 
                error: error.message,
                requiresElevation: error.message.toLowerCase().includes('permission') || 
                                   error.message.toLowerCase().includes('denied') ||
                                   error.message.toLowerCase().includes('administrator') ||
                                   error.message.toLowerCase().includes('not permitted')
            };
        }
    }

    async configureWindows(dnsServer) {
        try {
            if (!this.interfaceName) await this.detectNetworkInterface();
            console.log(`🪟 Configuring Windows DNS for interface: "${this.interfaceName}" to ${dnsServer}`);
            
            await execAsync(
                `netsh interface ip set dns name="${this.interfaceName}" static ${dnsServer} primary validate=no`,
                { timeout: this.configTimeout }
            );
            // Add a known good secondary DNS to prevent connectivity loss if local proxy fails
            await execAsync(
                `netsh interface ip add dns name="${this.interfaceName}" addr=8.8.8.8 index=2 validate=no`,
                { timeout: this.configTimeout }
            );
            
            console.log(`✅ Windows DNS configured: ${dnsServer} (primary), 8.8.8.8 (secondary) for "${this.interfaceName}"`);
            return { success: true, method: 'Windows netsh' };
        } catch (error) {
            console.error(`Error configuring Windows DNS for "${this.interfaceName}": ${error.message}`);
            throw error; // Re-throw
        }
    }

    async configureMacOS(dnsServer) {
        try {
            if (!this.interfaceName) await this.detectNetworkInterface();
            console.log(`🍎 Configuring macOS DNS for service: "${this.interfaceName}" to ${dnsServer}`);
            // Add a known good secondary DNS
            await execAsync(
                `networksetup -setdnsservers "${this.interfaceName}" ${dnsServer} 8.8.8.8`,
                { timeout: this.configTimeout }
            );
            console.log(`✅ macOS DNS configured: ${dnsServer} (primary), 8.8.8.8 (secondary) for "${this.interfaceName}"`);
            return { success: true, method: 'macOS networksetup' };
        } catch (error) {
            console.error(`Error configuring macOS DNS for "${this.interfaceName}": ${error.message}`);
            throw error; // Re-throw
        }
    }

    async configureLinux(dnsServer) {
        try {
            console.log(`🐧 Configuring Linux DNS to ${dnsServer}...`);
            // Try systemd-resolved first
            try {
                await execAsync('systemctl is-active systemd-resolved', { timeout: 5000 });
                if (!this.interfaceName) await this.detectNetworkInterface();

                // Create a drop-in configuration for systemd-resolved
                // This is preferred as it's less likely to be overwritten by NetworkManager
                const resolvedArseaConfDir = '/etc/systemd/resolved.conf.d';
                await fs.mkdir(resolvedArseaConfDir, { recursive: true });
                const resolvedConfContent = `[Resolve]\nDNS=${dnsServer} 8.8.8.8\nFallbackDNS=1.1.1.1\nDomains=~.\n`;
                                
                await fs.writeFile(`${resolvedArseaConfDir}/arsea-dns.conf`, resolvedConfContent);
                await execAsync('systemctl restart systemd-resolved', { timeout: 10000 });
                
                console.log(`✅ Linux DNS configured via systemd-resolved: ${dnsServer} (primary), 8.8.8.8 (secondary)`);
                return { success: true, method: 'Linux systemd-resolved' };
            } catch (systemdError) { // Fallback to direct /etc/resolv.conf modification
                console.warn(`systemd-resolved configuration failed (${systemdError.message}), falling back to /etc/resolv.conf.`);
                const currentResolvConf = await fs.readFile('/etc/resolv.conf', 'utf8');
                const arseaHeader = '# Arsea DNS Configuration - Start\n';
                const arseaFooter = '# Arsea DNS Configuration - End\n';
                
                // Remove old Arsea section if exists
                let newResolvConfLines = [];
                let inArseaSection = false;
                currentResolvConf.split('\n').forEach(line => {
                    if (line.startsWith(arseaHeader.trim())) inArseaSection = true;
                    else if (line.startsWith(arseaFooter.trim())) inArseaSection = false;
                    else if (!inArseaSection) newResolvConfLines.push(line);
                });

                // Prepend Arsea configuration
                const arseaDnsEntries = `nameserver ${dnsServer}\nnameserver 8.8.8.8\nnameserver 1.1.1.1\n`;
                const finalResolvConf = arseaHeader + arseaDnsEntries + arseaFooter + newResolvConfLines.filter(l => l.trim() !== '').join('\n');
                
                await fs.writeFile('/etc/resolv.conf', finalResolvConf.trim() + '\n');
                console.log(`✅ Linux DNS configured via /etc/resolv.conf: ${dnsServer}`);
                return { success: true, method: 'Linux /etc/resolv.conf' };
            }
        } catch (error) {
            console.error(`Error configuring Linux DNS: ${error.message}`);
            throw error; // Re-throw
        }
    }

    async testDNSServer(server, port) {
        // (Existing testDNSServer - seems fine)
        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                try { socket.close(); } catch(e){}
                resolve({ success: false, error: 'DNS server test timeout' });
            }, 5000);

            const socket = dgram.createSocket('udp4');
            const query = Buffer.from([
                0x12, 0x34, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
                0x06, 0x67, 0x6f, 0x6f, 0x67, 0x6c, 0x65, 0x03, 0x63, 0x6f, 0x6d, 0x00,
                0x00, 0x01, 0x00, 0x01
            ]);

            socket.on('message', (response) => {
                clearTimeout(timeoutId);
                try { socket.close(); } catch(e){}
                resolve({ success: true, responseSize: response.length });
            });

            socket.on('error', (err) => {
                clearTimeout(timeoutId);
                try { socket.close(); } catch(e){}
                resolve({ success: false, error: err.message });
            });

            try {
                 socket.send(query, port, server, (err) => {
                    if (err) {
                        clearTimeout(timeoutId);
                        try { socket.close(); } catch(e){}
                        resolve({ success: false, error: `Send error: ${err.message}` });
                    }
                });
            } catch (sendError) {
                 clearTimeout(timeoutId);
                 try { socket.close(); } catch(e){}
                 resolve({ success: false, error: `Immediate send error: ${sendError.message}` });
            }
        });
    }

    async verifyConfiguration(expectedDNS) {
        // Uses the new getCurrentDNS internally
        try {
            console.log('🔍 Verifying DNS configuration...');
            const currentSystemDNS = await this.getCurrentDNS(); // Array or string (for Linux resolv.conf)
            
            let isVerified = false;
            if (this.isDNSPointingToLocalhost(currentSystemDNS)) { // Check if current points to any 127.x.x.x
                 isVerified = expectedDNS === '127.0.0.1'; // Or more broadly if expectedDNS is also localhost
            } else if (Array.isArray(currentSystemDNS)) {
                 isVerified = currentSystemDNS.includes(expectedDNS);
            } else if (typeof currentSystemDNS === 'string') { // Linux /etc/resolv.conf content
                 isVerified = currentSystemDNS.includes(`nameserver ${expectedDNS}`);
            }

            if (isVerified) {
                 console.log(`✅ Verification successful. DNS includes ${expectedDNS}.`);
            } else {
                 console.log(`⚠️ Verification: DNS does not include ${expectedDNS}. Current: ${JSON.stringify(currentSystemDNS)}`);
            }
            return { success: isVerified, current: currentSystemDNS };
        } catch (error) {
            console.error(`Error during DNS verification: ${error.message}`);
            return { success: false, error: error.message, current: null };
        }
    }

    async restore() {
        try {
            console.log('🔄 Restoring original DNS configuration...');
            let backupData = null;
            try {
                const backupContent = await fs.readFile(this.backupFile, 'utf8');
                backupData = JSON.parse(backupContent);
                console.log(`Loaded DNS backup from ${this.backupFile}`);
            } catch (e) {
                console.warn(`⚠️ No DNS backup file found at ${this.backupFile} or it's invalid. Will try to use in-memory originalDNS or restore to automatic.`);
            }
            
            const dnsToRestore = backupData?.originalDNS || this.originalDNS;
            
            if (!dnsToRestore || (Array.isArray(dnsToRestore) && dnsToRestore.length === 0)) {
                console.warn('No specific original DNS found. Attempting to restore to automatic/DHCP configuration.');
                return await this.restoreToAutomatic(); // Use the new method
            }

            // If dnsToRestore is 'dhcp' or ['dhcp'], restore to automatic
            if (dnsToRestore === 'dhcp' || (Array.isArray(dnsToRestore) && dnsToRestore.length === 1 && dnsToRestore[0] === 'dhcp')) {
                 console.log("Original DNS indicates DHCP. Restoring to automatic configuration.");
                 return await this.restoreToAutomatic();
            }
            
            console.log(`Attempting to restore DNS to: ${typeof dnsToRestore === 'string' ? 'content of /etc/resolv.conf' : JSON.stringify(dnsToRestore)}`);

            if (this.platform === 'win32') {
                await this.restoreWindows(dnsToRestore);
            } else if (this.platform === 'darwin') {
                await this.restoreMacOS(dnsToRestore);
            } else { // Linux
                await this.restoreLinux(dnsToRestore);
            }
            
            this.isConfigured = false;
            console.log('✅ DNS configuration restored successfully.');
            return { success: true };
        } catch (error) {
            console.error('❌ DNS restoration failed:', error.message);
            console.log('As a fallback, attempting to restore to automatic/DHCP...');
            try {
                await this.restoreToAutomatic();
            } catch (autoRestoreError) {
                 console.error('❌ Fallback to automatic DNS restoration also failed:', autoRestoreError.message);
            }
            return { success: false, error: error.message };
        }
    }

    async restoreWindows(originalDNSArray) { // Expects an array or ['dhcp']
        if (!this.interfaceName) await this.detectNetworkInterface();
        if (originalDNSArray === 'dhcp' || (Array.isArray(originalDNSArray) && originalDNSArray.includes('dhcp'))) {
            console.log(`Restoring Windows DNS for "${this.interfaceName}" to DHCP...`);
            await execAsync(`netsh interface ip set dns name="${this.interfaceName}" dhcp`, { timeout: this.configTimeout });
        } else if (Array.isArray(originalDNSArray) && originalDNSArray.length > 0) {
            console.log(`Restoring Windows DNS for "${this.interfaceName}" to static: ${originalDNSArray.join(', ')}`);
            await execAsync(`netsh interface ip set dns name="${this.interfaceName}" static ${originalDNSArray[0]} primary validate=no`, { timeout: this.configTimeout });
            for (let i = 1; i < originalDNSArray.length; i++) {
                await execAsync(`netsh interface ip add dns name="${this.interfaceName}" addr=${originalDNSArray[i]} index=${i + 1} validate=no`, { timeout: this.configTimeout });
            }
        } else {
            console.warn(`Invalid originalDNS for Windows restore: ${JSON.stringify(originalDNSArray)}. Setting to DHCP.`);
            await execAsync(`netsh interface ip set dns name="${this.interfaceName}" dhcp`, { timeout: this.configTimeout });
        }
    }

    async restoreMacOS(originalDNSArray) { // Expects an array or ['dhcp']
        if (!this.interfaceName) await this.detectNetworkInterface();
         if (originalDNSArray === 'dhcp' || (Array.isArray(originalDNSArray) && (originalDNSArray.includes('dhcp') || originalDNSArray.length === 0))) {
            console.log(`Restoring macOS DNS for "${this.interfaceName}" to automatic (empty)...`);
            await execAsync(`networksetup -setdnsservers "${this.interfaceName}" empty`, { timeout: this.configTimeout });
        } else if (Array.isArray(originalDNSArray) && originalDNSArray.length > 0) {
            console.log(`Restoring macOS DNS for "${this.interfaceName}" to static: ${originalDNSArray.join(' ')}`);
            await execAsync(`networksetup -setdnsservers "${this.interfaceName}" ${originalDNSArray.join(' ')}`, { timeout: this.configTimeout });
        } else {
            console.warn(`Invalid originalDNS for macOS restore: ${JSON.stringify(originalDNSArray)}. Setting to automatic.`);
            await execAsync(`networksetup -setdnsservers "${this.interfaceName}" empty`, { timeout: this.configTimeout });
        }
    }

    async restoreLinux(originalDNS) { // Expects string (resolv.conf content) or 'dhcp' or array from systemd-resolve
        console.log('Restoring Linux DNS...');
        try {
            // Attempt to remove Arsea-specific systemd-resolved config first
            await fs.unlink('/etc/systemd/resolved.conf.d/arsea-dns.conf');
            console.log('Removed Arsea systemd-resolved config file.');
            await execAsync('systemctl restart systemd-resolved', { timeout: 10000 });
            console.log('Restarted systemd-resolved. System should revert to its managed DNS.');
        } catch (e) {
            // This is fine if the file didn't exist or systemd-resolved is not in use
            console.log('No Arsea systemd-resolved config to remove, or systemd-resolved not primary manager. Checking /etc/resolv.conf restoration.');
            if (typeof originalDNS === 'string' && originalDNS !== 'dhcp' && originalDNS.includes('nameserver')) {
                console.log('Restoring /etc/resolv.conf from backup content...');
                // Before writing, remove any Arsea markers if they exist from a previous failed restore
                const arseaHeader = '# Arsea DNS Configuration - Start';
                const arseaFooter = '# Arsea DNS Configuration - End';
                let cleanedOriginalDNS = originalDNS;
                if (originalDNS.includes(arseaHeader)) {
                    const parts = originalDNS.split(arseaHeader);
                    let outsideContent = parts[0];
                    if (parts[1] && parts[1].includes(arseaFooter)) {
                        outsideContent += parts[1].split(arseaFooter)[1] || '';
                    }
                    cleanedOriginalDNS = outsideContent.trim();
                     console.log('Cleaned Arsea markers from originalDNS before restoring resolv.conf');
                }
                await fs.writeFile('/etc/resolv.conf', cleanedOriginalDNS + '\n');
            } else {
                // If originalDNS was 'dhcp' or not a valid resolv.conf string,
                // it implies DHCP or system-managed. If systemd-resolved didn't handle it,
                // this means NetworkManager or similar should take over.
                // We avoid writing a generic "8.8.8.8" file if we don't have a true original.
                console.log('Linux: Original DNS was DHCP or not specific /etc/resolv.conf content. DNS should be managed by the system (e.g., NetworkManager, dhclient).');
            }
        }
    }

    parseWindowsDNS(configOutput) {
        // This parser needs to handle output from 'netsh interface ip show dns'
        // which is different from 'show config'.
        // 'show dns' example:
        // Configuration for interface "Wi-Fi"
        //     DNS servers configured through DHCP:  192.168.1.1
        //     Register with which suffix:           Primary only
        //
        // Or for static:
        // Configuration for interface "Ethernet"
        //     Statically Configured DNS Servers:    8.8.8.8
        //                                           8.8.4.4
        //     Register with which suffix:           Primary only

        const dnsServers = [];
        const lines = configOutput.split('\n');
        let inDnsSection = false;

        for (const line of lines) {
            const lowerLine = line.toLowerCase();
            if (lowerLine.includes('dns servers configured through dhcp')) {
                const match = line.match(/:\s*([\d\.]+)/);
                if (match && match[1] && match[1] !== '0.0.0.0' && match[1].toLowerCase() !== 'none') {
                    return [match[1]]; // Return DHCP server if found
                }
                return ['dhcp']; // If DHCP but no server listed (or 'none'), indicate DHCP
            }
            if (lowerLine.includes('statically configured dns servers')) {
                const match = line.match(/:\s*([\d\.]+)/);
                if (match && match[1] && match[1].toLowerCase() !== 'none') {
                    dnsServers.push(match[1].trim());
                }
                inDnsSection = true; // Subsequent lines might be more DNS servers
                continue;
            }
            if (inDnsSection) {
                const potentialDns = line.trim();
                if (/^[\d\.]+$/.test(potentialDns)) { // Is it an IP address?
                    dnsServers.push(potentialDns);
                } else {
                    inDnsSection = false; // No more IPs in this block
                }
            }
        }
        
        if (dnsServers.length > 0) return dnsServers;
        return ['dhcp']; // Default to DHCP if no static or DHCP servers found
    }

    parseSystemdResolve(output) { // This might not be used if getCurrentDNS for Linux is more direct
        const dnsServers = [];
        const lines = output.split('\n');
        let globalDnsSection = false;
        let interfaceDnsSection = false;

        for (const line of lines) {
            if (line.trim().startsWith('Global')) globalDnsSection = true;
            if (line.trim().startsWith('Link')) {
                globalDnsSection = false; // No longer in global section
                // Check if this is the relevant interface if this.interfaceName is set
                if (this.interfaceName && line.includes(this.interfaceName)) {
                    interfaceDnsSection = true;
                } else {
                    interfaceDnsSection = false;
                }
            }

            const dnsLineMatch = line.match(/^\s*DNS Servers:\s*(.+)/);
            if (dnsLineMatch) {
                const servers = dnsLineMatch[1].trim().split(/\s+/);
                if (interfaceDnsSection) { // Prefer interface-specific DNS
                    dnsServers.push(...servers);
                    break; // Found interface specific, use it
                }
                if (globalDnsSection && dnsServers.length === 0) { // Use global if no interface specific found yet
                    dnsServers.push(...servers);
                }
            }
        }
        return dnsServers.length > 0 ? dnsServers : ['dhcp'];
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async initialize() {
        console.log('🚀 Initializing DNS Configuration Manager...');
        await this.detectNetworkInterface();
        const permissions = await this.checkPermissions();
        console.log(`🔐 Permission status for interface "${this.interfaceName || 'N/A'}": ${permissions.method}`);
        // Try to load existing backup on init to populate this.originalDNS if daemon restarts
        try {
            const backupContent = await fs.readFile(this.backupFile, 'utf8');
            const backupData = JSON.parse(backupContent);
            if (backupData.originalDNS) {
                this.originalDNS = backupData.originalDNS;
                console.log(`📋 Loaded original DNS from backup file on initialize: ${JSON.stringify(this.originalDNS)}`);
            }
        } catch (e) {
            console.log(`No pre-existing backup file found at ${this.backupFile} or it's invalid. Will create one if needed.`);
        }
        return { platform: this.platform, interface: this.interfaceName, permissions: permissions };
    }

    getStatus() {
        return {
            platform: this.platform,
            interface: this.interfaceName,
            isConfigured: this.isConfigured,
            originalDNSInMemory: this.originalDNS, // Show what's in memory
            backupFile: this.backupFile,
            dryRun: this.dryRun
        };
    }
}

module.exports = DNSConfigManager;