// index.js (ArseaDaemon.js)
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { promisify } = require('util');
const EventEmitter = require('events');
const net = require('net'); // Added for checkPortAvailability
const dnsPromises = require('dns').promises; // Added for testDNSResolution

// Import new DNS components
const ArseaDNSProxy = require('./dns-proxy');
const DNSConfigManager = require('./dns-config'); // Ensure this uses the updated dns-config.js

// Import API Server
const DaemonAPIServer = require('./api-server'); // INTEGRATED
const ProcessManager = require('./process-manager');

const execAsync = promisify(exec);

let apiServer = null; // INTEGRATED: To hold the API server instance

// Initialize process manager
const processManager = new ProcessManager({
    pidFile: './arsea-daemon.pid',
    stateFile: './arsea-state.json',
    shutdownTimeout: 15000
});

class ArseaDaemon extends EventEmitter {
  constructor(options = {}) {
    super();

    // Core state
    this.isRunning = false;
    this.isBlocking = false; // Default to false, CLI or direct calls can enable it
    this.blockedDomains = new Set();
    this.dryRun = options.dryRun || false;

    // DNS Components
    // Ensure options.dnsOptions and options.dnsConfigOptions are passed if needed, or defaults are fine
    this.dnsProxy = new ArseaDNSProxy(options.dnsOptions || {});
    this.dnsConfig = new DNSConfigManager(options.dnsConfigOptions || {});

    // Enhanced stats with DNS metrics
    this.stats = {
      totalBlocked: 0,
      domainsInList: 0,
      lastUpdate: null,
      startTime: new Date(),
      blocklistSource: 'domains.json', // Default
      dnsQueries: 0,
      dnsBlocked: 0,
      dnsAllowed: 0,
      blockingMethod: 'dns-proxy'
    };

    // Legacy hosts file paths
    this.hostsPath = this.getHostsPath();
    this.backupPath = path.join(__dirname, 'hosts.backup'); // Used for hosts file, not DNS backup
    this.arseaMarker = '# === ARSEA CONTENT BLOCKER ===';
    this.arseaEndMarker = '# === END ARSEA SECTION ===';

    // Enhanced blocklist paths
    // Assuming this path is correct relative to where ArseaDaemon.js is located (e.g., if it's in a 'daemon' subdir)
    this.blocklistJsonPath = options.blocklistJsonPath || path.join(__dirname, '../blocklist/blocklist/domains.json');
    // this.blocklistJsPath = path.join(__dirname, '../blocklist/blocklist.js'); // Not currently used in provided code

    this.setupDNSEventListeners();

    if (this.dryRun) {
      console.log('🧪 DRY RUN MODE - No system changes will be made');
    }
  }

  // 🔧 ENHANCED: Updated initialize method
  async initialize() {
    console.log('🚀 Starting Enhanced Arsea Daemon (DNS-based)...');

    try {
      // 🚨 NEW: Initialize DNSConfigManager first to use its methods
      await this.dnsConfig.initialize(); // Detects interface, loads existing backup etc.

      // 🚨 NEW: Check if DNS is already corrupted before starting
      await this.checkDNSIntegrity();

      // System permission checks
      await this.checkSystemPermissions();

      // Load blocklist with validation
      await this.loadBlocklist();

      // Create emergency backup (includes DNS backup via this.dnsConfig.backup())
      // This ensures a fresh backup attempt IF no valid one was loaded during dnsConfig.initialize()
      // or if we want to ensure it's up-to-date before any potential blocking.
      // The enhanced dnsConfig.backup() will handle not overwriting good backups with localhost.
      await this.createEmergencyBackup();

      this.isRunning = true;
      console.log(`✅ Enhanced Arsea Daemon initialized`);

      this.emit('started');
      return true;

    } catch (error) {
      console.error('❌ Failed to initialize enhanced daemon:', error.message);
      this.emit('error', error);
      // Attempt graceful shutdown, which includes DNS restoration
      console.log('Attempting shutdown due to initialization error...');
      await this.shutdown(); // This will call the daemon's shutdown method
      return false;
    }
  }

  // 🔧 NEW: DNS integrity check
  async checkDNSIntegrity() {
    console.log('🔍 Checking DNS integrity before initialization...');

    try {
      // Check if current DNS is pointing to localhost
      const currentDNS = await this.dnsConfig.getCurrentDNS();

      if (this.dnsConfig.isDNSPointingToLocalhost(currentDNS)) {
        console.warn('⚠️ DNS is currently pointing to localhost!');
        console.warn('This suggests a previous session didn\'t restore properly or another local proxy is active.');

        // Attempt to restore DNS to DHCP/automatic
        console.log('Attempting to restore DNS to automatic/DHCP settings...');
        const restoreAttempt = await this.dnsConfig.restoreToAutomatic(); // Uses the method from dns-config.js
        if (!restoreAttempt.success) {
            console.error('Automatic DNS restoration attempt failed during integrity check. Manual intervention may be needed.');
            // Decide if this is a fatal error for initialization
            throw new Error('DNS integrity check: Automatic DNS restoration failed.');
        }

        // Wait a moment for DNS to settle
        console.log('Waiting for DNS settings to apply...');
        await new Promise(resolve => setTimeout(resolve, 3000)); // Increased wait time

        // Verify DNS is working by trying to resolve an external domain
        const dnsWorking = await this.testDNSResolution();
        if (!dnsWorking) {
          console.error('❌ DNS resolution test failed after attempting to restore from localhost.');
          console.error('Your internet connectivity might be affected. Please check your system DNS settings manually.');
          throw new Error('DNS integrity check: DNS restoration failed or DNS is not resolving correctly. Manual intervention required.');
        }

        console.log('✅ DNS integrity: DNS restored to a working state from localhost.');
      } else {
        console.log('✅ DNS integrity check passed (DNS not pointing to localhost).');
      }

    } catch (error) {
      console.error('❌ DNS integrity check encountered an error:', error.message);
      // Depending on severity, you might re-throw or allow continuation with a warning
      throw error; // Re-throw to halt initialization if integrity check fails critically
    }
  }

  // 🔧 NEW: Test DNS resolution
  async testDNSResolution() {
    // const dnsPromises = require('dns').promises; // Moved to top-level import
    const testDomain = 'google.com'; // A commonly available domain for testing
    try {
      console.log(`Testing DNS resolution by looking up "${testDomain}"...`);
      // Set a timeout for the DNS lookup
      const lookupPromise = dnsPromises.lookup(testDomain);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`DNS lookup for ${testDomain} timed out after 5 seconds`)), 5000)
      );

      await Promise.race([lookupPromise, timeoutPromise]);
      console.log(`✅ DNS resolution test for "${testDomain}" passed.`);
      return true;
    } catch (error) {
      console.error(`❌ DNS resolution test for "${testDomain}" failed:`, error.message);
      return false;
    }
  }

  setupDNSEventListeners() {
    this.dnsProxy.on('query', (domain, blocked) => {
      this.stats.dnsQueries++;
      if (blocked) {
        this.stats.dnsBlocked++;
        this.stats.totalBlocked++; // This might be redundant if totalBlocked is purely for DNS blocks
      } else {
        this.stats.dnsAllowed++;
      }
      this.emit('dns-query', { domain, blocked, stats: this.getDNSStats() });
    });

    this.dnsProxy.on('started', ({ port }) => { // Assuming 'started' event emits port
      console.log(`✅ DNS proxy started successfully on port ${port}`);
      this.emit('dns-proxy-started', { port });
    });

    this.dnsProxy.on('stopped', () => {
      console.log('✅ DNS proxy stopped successfully');
      this.emit('dns-proxy-stopped');
    });

    this.dnsProxy.on('error', (error) => {
      console.error('❌ DNS proxy error:', error);
      this.emit('dns-proxy-error', error);
    });
  }

  getHostsPath() {
    switch (os.platform()) {
      case 'win32':
        return 'C:\\Windows\\System32\\drivers\\etc\\hosts';
      case 'darwin':
      case 'linux':
      default:
        return '/etc/hosts';
    }
  }

  async checkSystemPermissions() {
    const checks = [];
    try {
      if (!this.dryRun) {
        // Check DNS proxy port binding (port 53 usually needs elevation)
        const preferredPortAvailable = await this.checkPortAvailability(this.dnsProxy.preferredPort || 53);
        checks.push({
          check: `DNS Port ${this.dnsProxy.preferredPort || 53}`,
          status: preferredPortAvailable,
          note: preferredPortAvailable ? 'Likely available' : 'May require elevated privileges or is in use'
        });
        if (!preferredPortAvailable && this.dnsProxy.fallbackPort) {
            const fallbackPortAvailable = await this.checkPortAvailability(this.dnsProxy.fallbackPort);
            checks.push({
              check: `DNS Fallback Port ${this.dnsProxy.fallbackPort}`,
              status: fallbackPortAvailable,
              note: fallbackPortAvailable ? 'Likely available' : 'May require elevated privileges or is in use'
            });
        }
      }

      try { // Hosts file access (legacy, but check remains)
        await fs.access(this.hostsPath, fs.constants.R_OK | fs.constants.W_OK);
        checks.push({ check: 'Hosts File Access', status: true, note: 'R/W Available (for emergency fallback)' });
      } catch {
        checks.push({ check: 'Hosts File Access', status: false, note: 'R/W Not Available' });
      }

      // DNS configuration permissions (from DNSConfigManager)
      const dnsConfigCheck = await this.dnsConfig.checkPermissions();
      checks.push({
        check: 'System DNS Modification',
        status: dnsConfigCheck.canModify,
        note: dnsConfigCheck.method
      });

      console.log('🔐 System Permission Check Results:');
      checks.forEach(check => {
        const icon = check.status ? '✅' : (check.note.includes('Requires') || check.note.includes('May require') ? '⚠️' : '❌');
        console.log(`   ${icon} ${check.check}: ${check.note}`);
      });

      if (!dnsConfigCheck.canModify && !this.dryRun) {
          console.warn('⚠️  This application may not be able to modify system DNS settings without elevated privileges.');
      }
      return checks;

    } catch (error) {
      console.error('❌ Error during system permission check:', error.message);
      throw error; // Re-throw to halt initialization if critical
    }
  }

  async checkPortAvailability(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', (err) => {
        // console.warn(`Port ${port} check error: ${err.code}`);
        resolve(false); // Port is likely in use or requires permissions
      });
      server.once('listening', () => {
        server.close(() => resolve(true)); // Port is available
      });
      server.listen(port, '127.0.0.1'); // Bind to localhost for local proxy
    });
  }

  async loadBlocklist() {
    console.log('📋 Loading blocklist...');
    try {
      const loadResult = await this.loadFromJsonWithValidation(); // Assumes this is the primary method now

      if (loadResult.success) {
        await this.dnsProxy.loadBlocklist(Array.from(this.blockedDomains));
        this.stats.blocklistSource = loadResult.source;
        this.stats.domainsInList = this.blockedDomains.size; // Or use loadResult.domains
        this.stats.lastUpdate = new Date();
        console.log(`✅ Successfully loaded ${this.stats.domainsInList} domains from ${this.stats.blocklistSource}.`);
        this.emit('blocklist-loaded', { domains: this.stats.domainsInList, source: this.stats.blocklistSource });
      } else {
        throw new Error(loadResult.error || 'Blocklist loading failed without specific error.');
      }
    } catch (error) {
      console.error('❌ Critical error loading blocklist:', error.message);
      console.log('🆘 Using emergency fallback blocklist.');
      this.createEmergencyBlocklist(); // Populates this.blockedDomains
      await this.dnsProxy.loadBlocklist(Array.from(this.blockedDomains)); // Load emergency list into proxy
      // Update stats for emergency list
      this.stats.blocklistSource = 'emergency';
      this.stats.domainsInList = this.blockedDomains.size;
      this.stats.lastUpdate = new Date();
      this.emit('blocklist-loaded', { domains: this.stats.domainsInList, source: 'emergency', error: error.message });
    }
  }

  async loadFromJsonWithValidation() {
    try {
      console.log(`📖 Attempting to load blocklist from: ${this.blocklistJsonPath}`);
      const fileStats = await fs.stat(this.blocklistJsonPath);
      const maxSize = 100 * 1024 * 1024; // 100MB
      if (fileStats.size > maxSize) throw new Error(`Blocklist file too large: ${Math.round(fileStats.size / 1024 / 1024)}MB`);
      if (fileStats.size === 0) throw new Error('Blocklist file is empty.');

      const data = await fs.readFile(this.blocklistJsonPath, 'utf8');
      let domains;
      try { domains = JSON.parse(data); } catch (e) { throw new Error(`Invalid JSON: ${e.message}`); }
      if (!Array.isArray(domains)) throw new Error('Blocklist must be an array.');
      if (domains.length === 0) throw new Error('Blocklist array is empty.');

      const validDomains = new Set();
      let invalidCount = 0;
      domains.forEach(domain => {
        if (typeof domain === 'string' && domain.trim().length > 0) {
          const sanitized = domain.toLowerCase().trim();
          if (this.isValidDomain(sanitized)) validDomains.add(sanitized);
          else invalidCount++;
        } else invalidCount++;
      });

      if (validDomains.size === 0) throw new Error('No valid domains found in blocklist.');
      this.blockedDomains = validDomains;

      console.log(`📊 Blocklist Validation: Total ${domains.length}, Valid ${validDomains.size}, Invalid/Skipped ${invalidCount}.`);
      if (invalidCount > 0) console.log(`⚠️ Skipped ${invalidCount} invalid entries.`);
      return { success: true, source: 'domains.json', domains: validDomains.size, fileSize: fileStats.size, invalidCount };
    } catch (error) {
      console.log(`❌ JSON blocklist loading failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  isValidDomain(domain) {
    const domainRegex = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i;
    return domainRegex.test(domain) && domain.length > 0 && domain.length < 255;
  }

  createEmergencyBlocklist() {
    console.log('🆘 Creating and using emergency blocklist (minimal set).');
    this.blockedDomains = new Set(['example-blocked.com', 'test-emergency.net']);
    // Stats will be updated by loadBlocklist after this is called
  }

  async applyBlocking() {
    // This method assumes this.isBlocking has been set to true before calling
    if (!this.isBlocking) {
      console.log('⏭️ Blocking is not currently enabled. Skipping applyBlocking.');
      return { success: true, reason: 'disabled_state' };
    }
    if (this.blockedDomains.size === 0 && !this.dryRun) { // Allow dry run with no domains for testing flow
      console.warn('⚠️ No domains loaded in blocklist. DNS blocking will not be effective.');
      // return { success: false, reason: 'no_domains_loaded' }; // Or proceed and let proxy run empty
    }

    try {
      console.log(`🔒 Applying DNS-based blocking for ${this.blockedDomains.size} domains...`);
      if (this.dryRun) {
        console.log('🧪 DRY RUN: Would start DNS proxy and configure system DNS.');
        this.showDryRunDNSPreview();
        return { success: true, reason: 'dry_run' };
      }

      // Ensure DNS is backed up using the enhanced backup method (should have been done in init)
      // If createEmergencyBackup wasn't called or failed, this is another chance.
      if (!this.dnsConfig.originalDNS && !await fs.access(this.dnsConfig.backupFile).then(() => true).catch(() => false)) {
          console.log('Performing DNS backup before applying blocking (as it was not found)...');
          await this.dnsConfig.backup();
      }

      const proxyResult = await this.dnsProxy.start(); // ArseaDNSProxy start
      if (!proxyResult.success) {
        throw new Error(`DNS proxy failed to start: ${proxyResult.error || 'Unknown proxy start error'}`);
      }

      // Pass the actual port the proxy started on to configureDNSWithGuidance
      await this.configureDNSWithGuidance(this.dnsProxy.getPort());

      console.log(`✅ DNS blocking applied. System DNS configured to use proxy on 127.0.0.1:${this.dnsProxy.getPort()}.`);
      this.emit('blocking-applied', { method: 'dns-proxy', domains: this.blockedDomains.size, port: this.dnsProxy.getPort() });
      return { success: true, method: 'dns-proxy', domains: this.blockedDomains.size };
    } catch (error) {
      console.error('❌ Failed to apply DNS blocking:', error.message);
      this.isBlocking = false; // Revert state
      console.log('Attempting to restore system DNS due to applyBlocking failure...');
      await this.dnsConfig.restore(); // Attempt to restore to original/DHCP
      this.emit('blocking-failed', { error: error.message });
      throw error; // Re-throw for CLI to handle
    }
  }

  async configureDNSWithGuidance(proxyPort) { // proxyPort is passed from applyBlocking
    console.log(`⚙️ Configuring system DNS to use local proxy at 127.0.0.1 (proxy on port ${proxyPort})...`);
    try {
      // Pass the actual proxy port to dnsConfig.configure for the testDNSServer call within it
      const configResult = await this.dnsConfig.configure('127.0.0.1', proxyPort);

      if (configResult.success) {
        console.log(`✅ System DNS configured successfully via: ${configResult.method || 'unknown method'}`);
      } else {
        console.warn('⚠️ Automatic DNS configuration failed or not fully supported.');
        console.log('📋 Manual DNS Configuration Required:');
        // (User guidance messages as before - ensure they mention the correct proxyPort if it's not 53)
        const platform = os.platform();
        const primaryDns = '127.0.0.1'; // System DNS points to 127.0.0.1 regardless of proxy's listening port
        const secondaryDns = '8.8.8.8'; // Example secondary
        if (platform === 'win32') {
            console.log(`  Windows: Set Primary DNS to ${primaryDns}, Secondary to ${secondaryDns} (e.g., in Network Adapter settings).`);
        } else if (platform === 'darwin') {
            console.log(`  macOS: In Network Preferences, add ${primaryDns} and ${secondaryDns} to DNS Servers list.`);
        } else {
            console.log(`  Linux: Edit /etc/resolv.conf or use NetworkManager/systemd-resolved. Add "nameserver ${primaryDns}" (top) and "nameserver ${secondaryDns}".`);
        }
        console.log(`  Ensure your DNS queries for the system are directed to ${primaryDns}. The proxy itself is listening on port ${proxyPort}.`);
        if(configResult.requiresElevation) {
            console.error('This operation likely requires administrator/sudo privileges.');
        }
      }
    } catch (error) {
      console.error('⚠️ Error during DNS configuration attempt:', error.message);
      // No throw here, guidance is best effort
    }
  }

  async emergencyHostsFileBackup() { // This is a legacy/fallback, not primary
    console.log('🆘 Emergency: Attempting to apply blocking via hosts file (limited)...');
    try {
      await this.checkHostsPermissions(); // May throw if no permission
      await this.createHostsBackup(); // Backup original hosts file

      const limitedDomains = Array.from(this.blockedDomains).slice(0, 1000); // Limit for hosts file
      if (limitedDomains.length === 0) {
          console.log('No domains to block in hosts file.');
          return;
      }
      const arseaSection = this.generateLimitedArseaSection(limitedDomains);
      const currentContent = await this.safeReadHosts();
      const cleanedContent = this.removeArseaEntries(currentContent); // Remove old Arsea section
      const newContent = cleanedContent.trim() + '\n\n' + arseaSection; // Add new section

      await this.safeWriteHosts(newContent);
      console.log(`✅ Emergency hosts file blocking applied for ${limitedDomains.length} domains.`);
    } catch (error) {
        console.error(`❌ Emergency hosts file fallback FAILED: ${error.message}. This usually requires admin privileges.`);
    }
  }

  async removeBlocking() {
    console.log('🔓 Removing DNS-based blocking and restoring system DNS...');
    try {
      if (this.dryRun) {
        console.log('🧪 DRY RUN: Would stop DNS proxy and restore original system DNS.');
        this.emit('blocking-removed'); // For listeners
        return { success: true, reason: 'dry_run' };
      }

      await this.dnsProxy.stop(); // Stop the local DNS proxy server
      const restoreResult = await this.dnsConfig.restore(); // Restore original system DNS settings

      if (restoreResult.success) {
        console.log('✅ System DNS restored successfully.');
      } else {
        console.error('❌ Failed to restore system DNS automatically. Manual check required.');
        // Provide guidance based on restoreResult.error if available
      }

      // Optional: Clean up hosts file if emergency fallback was used
      // if (this.stats.blockingMethod === 'hosts-fallback' || some_other_condition) {
      //    await this.removeHostsEntries();
      // }

      this.isBlocking = false; // Update state
      this.emit('blocking-removed');
      return { success: true };
    } catch (error) {
      console.error('❌ Error during removeBlocking:', error.message);
      // Even if restore failed, proxy is stopped. User needs to manually fix DNS.
      this.isBlocking = true; // Set back to true if removal failed, to reflect potential state
      throw error; // Re-throw for CLI to handle
    }
  }

  async createEmergencyBackup() {
    // This method now primarily focuses on ensuring DNSConfigManager has a backup.
    // Hosts file backup is secondary.
    try {
      // Ensure DNS is backed up (this calls the enhanced dnsConfig.backup)
      if (!this.dnsConfig.originalDNS || !await fs.access(this.dnsConfig.backupFile).then(() => true).catch(() => false) ) {
        console.log('Performing DNS configuration backup as part of emergency backup routine...');
        await this.dnsConfig.backup();
      } else {
        console.log('DNS configuration backup already exists or loaded in memory.');
      }

      // Legacy hosts file backup (optional)
      // await this.createHostsBackup();

      console.log('✅ Emergency backup routine (DNS primarily) completed.');
    } catch (error) {
      console.warn('⚠️ Error during emergency backup creation:', error.message);
      // Don't let this error stop the main flow if DNS backup succeeded but hosts failed
    }
  }

  getDNSStats() { // For more granular DNS stats
    return {
      queries: this.stats.dnsQueries,
      blocked: this.stats.dnsBlocked,
      allowed: this.stats.dnsAllowed,
      blockRate: this.stats.dnsQueries > 0 ? parseFloat((this.stats.dnsBlocked / this.stats.dnsQueries * 100).toFixed(1)) : 0
    };
  }

  getStats() { // Comprehensive stats
    const dnsProxyRuntimeStats = this.dnsProxy.getStats(); // From ArseaDNSProxy instance
    const uptimeMs = new Date() - this.stats.startTime;

    return {
      isRunning: this.isRunning,
      isBlocking: this.isBlocking,
      uptime: `${Math.floor(uptimeMs / 3600000)}h ${Math.floor((uptimeMs % 3600000) / 60000)}m ${Math.floor((uptimeMs % 60000) / 1000)}s`,
      startTime: this.stats.startTime.toISOString(),
      blockingMethod: this.stats.blockingMethod,
      blocklist: {
        source: this.stats.blocklistSource,
        domainsInList: this.stats.domainsInList,
        lastUpdate: this.stats.lastUpdate ? this.stats.lastUpdate.toISOString() : null,
        jsonPath: this.blocklistJsonPath,
      },
      dnsProxy: {
        status: dnsProxyRuntimeStats.isRunning ? 'Running' : 'Stopped',
        port: dnsProxyRuntimeStats.port || this.dnsProxy.actualPort, // Get actual port
        upstreamDNS: dnsProxyRuntimeStats.upstreamDNS,
        queriesHandledByProxy: dnsProxyRuntimeStats.queries,
        blockedByProxy: dnsProxyRuntimeStats.blocked,
        allowedByProxy: dnsProxyRuntimeStats.allowed,
        proxyErrors: dnsProxyRuntimeStats.errors,
        proxyBlockRate: dnsProxyRuntimeStats.blockRate + '%'
      },
      systemDns: this.dnsConfig.getStatus(), // Get status from DNSConfigManager
      legacyHostsFile: { // Info about legacy hosts file (if used)
          path: this.hostsPath,
          backupPath: this.backupPath
      }
    };
  }

  async shutdown() {
    console.log('🛑 Shutting down Enhanced Arsea Daemon...');
    try {
      if (this.dnsProxy && this.dnsProxy.isRunning) { // Check if proxy is actually running
        console.log('Stopping DNS proxy server...');
        await this.dnsProxy.stop();
      } else {
        console.log('DNS proxy was not running or already stopped.');
      }

      // Restore system DNS settings using DNSConfigManager
      // This will use the (hopefully correct) backup.
      if (this.dnsConfig) {
        console.log('Attempting to restore original system DNS settings...');
        const restoreResult = await this.dnsConfig.restore();
        if (restoreResult.success) {
            console.log('✅ System DNS settings restored.');
        } else {
            console.error(`❌ Failed to restore system DNS settings: ${restoreResult.error}. Manual check may be required.`);
        }
      }

      // Optional: Clean up hosts file entries if they were used
      // await this.removeHostsEntries();

      this.isRunning = false;
      this.isBlocking = false;
      this.emit('shutdown');
      console.log('👋 Enhanced Arsea Daemon stopped.');
    } catch (error) {
      console.error('❌ Error during graceful shutdown:', error.message);
      // Even with error, try to ensure isRunning is false
      this.isRunning = false;
    }
  }

  showDryRunDNSPreview() {
    console.log('\n📋 DRY RUN DNS PREVIEW:');
    console.log('======================');
    console.log(`🌐 DNS Proxy: Would attempt to start on port ${this.dnsProxy.preferredPort || 53} (fallback ${this.dnsProxy.fallbackPort || 5353})`);
    console.log(`📊 Blocked Domains Loaded: ${this.blockedDomains.size}`);
    console.log(`🔒 Blocking Method: DNS queries for blocked domains resolved to 127.0.0.1 by local proxy.`);
    console.log(`⚙️ System DNS: Would be configured to point to 127.0.0.1 (with a secondary like 8.8.8.8).`);
    console.log(`💾 Memory for Blocklist: ~${Math.round(this.blockedDomains.size * 60 / 1024)}KB (approx estimate)`);
    console.log('✨ Features: Handles A & AAAA, forwards other types, uses upstream DNS for allowed queries.');
    if (this.blockedDomains.size > 0) {
        console.log('🧪 Sample Blocked Domains (first 5):');
        Array.from(this.blockedDomains).slice(0, 5).forEach(domain => console.log(`  - ${domain} -> Would resolve to 127.0.0.1`));
    }
    console.log('======================\n');
  }

  // --- Legacy Hosts File Methods (kept for potential emergency fallback) ---
  async createHostsBackup() {
    try {
      const originalContent = await fs.readFile(this.hostsPath, 'utf8');
      // Avoid creating multiple backups if one identical to current hosts file exists
      // This logic can be more sophisticated, e.g., timestamped backups or checking content
      if (!await fs.access(this.backupPath).then(() => true).catch(() => false)) {
          await fs.writeFile(this.backupPath, originalContent, 'utf8');
          console.log(`✅ Hosts file backup created at: ${this.backupPath}`);
      } else {
          // console.log('Hosts file backup already exists.');
      }
    } catch (error) {
      console.warn(`⚠️ Could not create hosts file backup: ${error.message} (Requires admin for C:/Windows/... or /etc/hosts)`);
    }
  }

  async checkHostsPermissions() { // Simple check, might not be enough for all OS and security contexts
    await fs.access(this.hostsPath, fs.constants.R_OK | fs.constants.W_OK);
  }

  async safeReadHosts() {
    return await fs.readFile(this.hostsPath, 'utf8');
  }

  async safeWriteHosts(content) { // Basic safe write using a temp file
    const tempPath = this.hostsPath + `.tmp-${Date.now()}`;
    try {
        await fs.writeFile(tempPath, content, 'utf8');
        await fs.rename(tempPath, this.hostsPath); // Atomic on POSIX, not always on Windows
    } catch (error) {
        try { await fs.unlink(tempPath); } catch (e) { /* ignore unlink error */ }
        throw error; // Re-throw original error
    }
  }

  removeArseaEntries(content) {
    const lines = content.split('\n');
    const filteredLines = [];
    let inArseaSection = false;
    for (const line of lines) {
      if (line.includes(this.arseaMarker)) {
        inArseaSection = true;
        continue;
      }
      if (line.includes(this.arseaEndMarker)) {
        inArseaSection = false;
        continue;
      }
      if (!inArseaSection) {
        filteredLines.push(line);
      }
    }
    return filteredLines.join('\n').replace(/\n\n+/g, '\n\n').trim(); // Clean up multiple blank lines
  }

  generateLimitedArseaSection(domains) {
    const header = [
      this.arseaMarker,
      `# Modified by Arsea - ${new Date().toISOString()}`,
      `# ${domains.length} domains for emergency blocking via hosts file.`,
      ''
    ];
    const entries = domains.map(domain => `127.0.0.1 ${domain}`);
    return header.join('\n') + '\n' + entries.join('\n') + '\n' + this.arseaEndMarker;
  }

  async removeHostsEntries() { // For cleaning hosts file
    try {
      const currentContent = await this.safeReadHosts();
      const cleanedContent = this.removeArseaEntries(currentContent);
      if (currentContent !== cleanedContent) {
        await this.safeWriteHosts(cleanedContent);
        console.log('✅ Arsea entries removed from hosts file.');
      } else {
        console.log('No Arsea entries found in hosts file to remove.');
      }
    } catch (error) {
      console.warn(`⚠️ Could not clean Arsea entries from hosts file: ${error.message}`);
    }
  }
}

// INTEGRATED: Function to start the API server
async function startAPIServer(daemonInstance) {
  try {
      apiServer = new DaemonAPIServer(daemonInstance); // apiServer is module-level
      await apiServer.start();
      // Assuming default port 3847 if not dynamically retrieved from apiServer instance
      console.log(`✅ API server started successfully on http://127.0.0.1:${apiServer.getPort ? apiServer.getPort() : 3847}`);
      return apiServer;
  } catch (error) {
      console.error('❌ Failed to start API server:', error);
      // Don't exit here - let the daemon continue without API if needed
      return null;
  }
}


// --- Enhanced CLI Interface ---
if (require.main === module) {
  const args = process.argv.slice(2);

  // Helper to parse named arguments like --blocklist-path=/path/to/list.json
  const parseArgValue = (argName) => {
    const arg = args.find(a => a.startsWith(`--${argName}=`));
    if (arg) return arg.split('=')[1];
    const argIndex = args.indexOf(`--${argName}`);
    if (argIndex > -1 && args[argIndex + 1] && !args[argIndex + 1].startsWith('--')) {
        return args[argIndex + 1];
    }
    return null;
  };

  const options = {
      dryRun: args.includes('--dry-run') || args.includes('-d'),
      blocklistJsonPath: parseArgValue('blocklist-path'), // Allow custom blocklist path
      // Add other CLI configurable options for dnsOptions or dnsConfigOptions if needed
  };

  const showStatus = args.includes('--status') || args.includes('-s');
  const enableBlockingCli = args.includes('--enable'); // Renamed to avoid conflict
  const disableBlockingCli = args.includes('--disable'); // Renamed to avoid conflict
  // const toggleBlocking = args.includes('--toggle'); // No toggleBlocking method implemented yet
  // const verbose = args.includes('--verbose') || args.includes('-v'); // Verbosity not deeply implemented yet
  const testDnsResolutionCli = args.includes('--test-dns-resolution'); // More specific test
  const forceRestoreDns = args.includes('--force-restore-dns');

  const daemon = new ArseaDaemon(options);

  // INTEGRATED & UPDATED: Graceful shutdown for daemon and API server
  const gracefulShutdown = async (signal) => {
    await processManager.gracefulShutdown(signal);
  };

  async function cliRunner() {
    // ...other CLI actions...

    console.log('Initializing Arsea Daemon for operation...');

    // 1. CHECK FOR EXISTING INSTANCE FIRST (before writing our own PID)
    const existingInstance = await processManager.checkExistingInstance();
    if (existingInstance.running) {
      console.log(`⚠️ Another Arsea daemon is already running (PID: ${existingInstance.pid})`);
      console.log('Use --force to override or stop the existing instance first.');
      process.exit(1);
    }

    // 2. NOW INITIALIZE DAEMON
    const initialized = await daemon.initialize();
    if (!initialized) {
      console.error('Arsea Daemon failed to initialize. Exiting.');
      await gracefulShutdown('INITIALIZATION_FAILURE');
      return;
    }

    // 3. INITIALIZE PROCESS MANAGER (writes PID file)
    await processManager.initialize(daemon, apiServer);

    // --- Add this block: Show current DNS status after instance check ---
    try {
        await daemon.dnsConfig.initialize(); // Ensure DNS config is ready
        const currentDNS = await daemon.dnsConfig.getCurrentDNS();
        console.log('\n🔎 Current system DNS servers:', Array.isArray(currentDNS) ? currentDNS.join(', ') : currentDNS);
    } catch (e) {
        console.warn('⚠️ Could not retrieve current DNS servers:', e.message);
    }

    // Rest of your existing code continues...
    if (!options.dryRun || enableBlockingCli || disableBlockingCli) {
        apiServer = await startAPIServer(daemon);
    }

    // Continue with the rest of your existing cliRunner logic...
    // ...existing code...
  }

  // Setup signal handlers for graceful shutdown
  processManager.setupSignalHandlers();

  cliRunner().catch(async (error) => { // Make catch async
    console.error("❌ An error occurred in the CLI runner:", error);
    await gracefulShutdown('CLI_RUNNER_ERROR'); // This will call process.exit(1)
  });
}