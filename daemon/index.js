const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const EventEmitter = require('events');

class ArseaDaemon extends EventEmitter {
  constructor(options = {}) {
    super();
    this.isRunning = false;
    this.isBlocking = true;
    this.blockedDomains = new Set();
    this.dryRun = options.dryRun || false; // 🧪 DRY RUN MODE
    this.stats = {
      totalBlocked: 0,
      domainsInList: 0,
      lastUpdate: null,
      startTime: new Date()
    };
    
    // Platform-specific hosts file path
    this.hostsPath = this.getHostsPath();
    this.backupPath = path.join(__dirname, 'hosts.backup');
    this.arseaMarker = '# === ARSEA CONTENT BLOCKER ===';
    
    if (this.dryRun) {
      console.log('🧪 DRY RUN MODE - No files will be modified');
    }
  }

  // Get system hosts file path based on OS
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

  // Initialize daemon
  async initialize() {
    console.log('🚀 Starting Arsea Daemon...');
    
    try {
      // Load existing blocklist
      await this.loadBlocklist();
      
      // Create backup of original hosts file
      await this.createHostsBackup();
      
      // Apply blocking if enabled
      if (this.isBlocking) {
        await this.applyBlocking();
      }
      
      this.isRunning = true;
      console.log(`✅ Arsea Daemon started - Protecting ${this.stats.domainsInList} domains`);
      
      this.emit('started');
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize daemon:', error);
      this.emit('error', error);
      return false;
    }
  }

  // Load blocklist from existing cache or create new
  async loadBlocklist() {
    const blocklistPath = path.join(__dirname, '../blocklist/blocklist/domains.json');
    
    try {
      const data = await fs.readFile(blocklistPath, 'utf8');
      const domains = JSON.parse(data);
      
      this.blockedDomains = new Set(domains);
      this.stats.domainsInList = this.blockedDomains.size;
      this.stats.lastUpdate = new Date();
      
      console.log(`📋 Loaded ${this.blockedDomains.size} domains from cache`);
    } catch (error) {
      console.log('⚠️  No existing blocklist found, will need to download');
      // TODO: Integrate with existing blocklist download logic
      this.blockedDomains = new Set();
    }
  }

  // Create backup of original hosts file
  async createHostsBackup() {
    if (this.dryRun) {
      console.log('🧪 DRY RUN: Would create backup of hosts file');
      console.log(`   Source: ${this.hostsPath}`);
      console.log(`   Backup: ${this.backupPath}`);
      return;
    }

    try {
      // Check if backup already exists
      try {
        await fs.access(this.backupPath);
        console.log('📁 Using existing hosts backup');
        return;
      } catch {
        // Backup doesn't exist, create it
      }

      const originalHosts = await fs.readFile(this.hostsPath, 'utf8');
      await fs.writeFile(this.backupPath, originalHosts);
      console.log('💾 Created hosts file backup');
    } catch (error) {
      console.error('❌ Failed to backup hosts file:', error);
      throw error;
    }
  }

  // Apply blocking by modifying hosts file
  async applyBlocking() {
    if (!this.isBlocking || this.blockedDomains.size === 0) {
      return;
    }

    try {
      console.log('🔒 Applying domain blocking...');
      
      if (this.dryRun) {
        console.log('🧪 DRY RUN: Would modify hosts file with blocking');
        console.log(`   File: ${this.hostsPath}`);
        console.log(`   Domains to block: ${this.blockedDomains.size}`);
        
        // Show first 10 domains as sample
        const sampleDomains = Array.from(this.blockedDomains).slice(0, 10);
        console.log('   Sample domains that would be blocked:');
        sampleDomains.forEach(domain => {
          console.log(`     127.0.0.1 ${domain}`);
          console.log(`     127.0.0.1 www.${domain}`);
        });
        
        if (this.blockedDomains.size > 10) {
          console.log(`     ... and ${this.blockedDomains.size - 10} more domains`);
        }
        
        this.emit('blocking-applied');
        return;
      }
      
      // Read current hosts file
      let hostsContent = await fs.readFile(this.hostsPath, 'utf8');
      
      // Remove any existing Arsea entries
      hostsContent = this.removeArseaEntries(hostsContent);
      
      // Add Arsea blocking section
      const arseaSection = this.generateArseaSection();
      hostsContent += '\n' + arseaSection;
      
      // Write back to hosts file
      await fs.writeFile(this.hostsPath, hostsContent);
      
      console.log(`✅ Applied blocking for ${this.blockedDomains.size} domains`);
      this.emit('blocking-applied');
    } catch (error) {
      console.error('❌ Failed to apply blocking:', error);
      throw error;
    }
  }

  // Remove blocking by restoring original hosts file
  async removeBlocking() {
    try {
      console.log('🔓 Removing domain blocking...');
      
      if (this.dryRun) {
        console.log('🧪 DRY RUN: Would remove Arsea entries from hosts file');
        console.log(`   File: ${this.hostsPath}`);
        this.emit('blocking-removed');
        return;
      }
      
      // Read current hosts file
      let hostsContent = await fs.readFile(this.hostsPath, 'utf8');
      
      // Remove Arsea entries
      hostsContent = this.removeArseaEntries(hostsContent);
      
      // Write cleaned hosts file
      await fs.writeFile(this.hostsPath, hostsContent);
      
      console.log('✅ Blocking removed');
      this.emit('blocking-removed');
    } catch (error) {
      console.error('❌ Failed to remove blocking:', error);
      throw error;
    }
  }

  // Generate Arsea section for hosts file
  generateArseaSection() {
    const lines = [
      this.arseaMarker,
      '# Generated by Arsea Content Blocker',
      `# ${new Date().toISOString()} - ${this.blockedDomains.size} domains`,
      ''
    ];

    // Add blocked domains (limit to prevent huge hosts file)
    let count = 0;
    const maxDomains = 50000; // Reasonable limit for hosts file performance
    
    for (const domain of this.blockedDomains) {
      if (count >= maxDomains) break;
      lines.push(`127.0.0.1 ${domain}`);
      lines.push(`127.0.0.1 www.${domain}`);
      count++;
    }

    lines.push('# === END ARSEA SECTION ===');
    return lines.join('\n');
  }

  // Remove existing Arsea entries from hosts content
  removeArseaEntries(hostsContent) {
    const lines = hostsContent.split('\n');
    const filteredLines = [];
    let inArseaSection = false;

    for (const line of lines) {
      if (line.includes(this.arseaMarker)) {
        inArseaSection = true;
        continue;
      }
      if (line.includes('# === END ARSEA SECTION ===')) {
        inArseaSection = false;
        continue;
      }
      if (!inArseaSection) {
        filteredLines.push(line);
      }
    }

    return filteredLines.join('\n').replace(/\n\n\n+/g, '\n\n');
  }

  // Toggle blocking on/off
  async toggleBlocking() {
    this.isBlocking = !this.isBlocking;
    
    if (this.isBlocking) {
      await this.applyBlocking();
    } else {
      await this.removeBlocking();
    }
    
    console.log(`🔄 Blocking ${this.isBlocking ? 'ENABLED' : 'DISABLED'}`);
    this.emit('blocking-toggled', this.isBlocking);
    
    return this.isBlocking;
  }

  // Get current stats
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      isBlocking: this.isBlocking,
      uptime: new Date() - this.stats.startTime
    };
  }

  // Graceful shutdown
  async shutdown() {
    console.log('🛑 Shutting down Arsea Daemon...');
    
    try {
      // Optionally remove blocking on shutdown
      if (this.isBlocking) {
        console.log('🔓 Removing blocking before shutdown...');
        await this.removeBlocking();
      }
      
      this.isRunning = false;
      this.emit('shutdown');
      console.log('👋 Arsea Daemon stopped');
    } catch (error) {
      console.error('❌ Error during shutdown:', error);
    }
  }

  // Check if domain is blocked
  isDomainBlocked(domain) {
    return this.blockedDomains.has(domain.toLowerCase());
  }
}

// Export daemon class
module.exports = ArseaDaemon;

// If run directly, start daemon
if (require.main === module) {
  // Parse command line arguments
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run') || args.includes('-d');
  
  const daemon = new ArseaDaemon({ dryRun });
  
  // Handle process signals
  process.on('SIGINT', async () => {
    await daemon.shutdown();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    await daemon.shutdown();
    process.exit(0);
  });
  
  // Start daemon
  daemon.initialize().catch(console.error);
}