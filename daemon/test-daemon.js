const ArseaDaemon = require('./index.js');

async function testDaemon() {
  console.log('🧪 Testing Arsea Daemon in DRY RUN mode...\n');
  
  // Create daemon in dry-run mode
  const daemon = new ArseaDaemon({ dryRun: true });
  
  // Listen for events
  daemon.on('started', () => {
    console.log('📡 Event: Daemon started');
  });
  
  daemon.on('blocking-applied', () => {
    console.log('📡 Event: Blocking applied');
  });
  
  daemon.on('blocking-removed', () => {
    console.log('📡 Event: Blocking removed');
  });
  
  daemon.on('blocking-toggled', (isEnabled) => {
    console.log(`📡 Event: Blocking toggled - ${isEnabled ? 'ON' : 'OFF'}`);
  });
  
  try {
    // Initialize daemon
    console.log('1️⃣ Initializing daemon...');
    await daemon.initialize();
    
    // Show stats
    console.log('\n2️⃣ Current stats:');
    const stats = daemon.getStats();
    console.log(`   📊 Domains in blocklist: ${stats.domainsInList}`);
    console.log(`   🔒 Blocking enabled: ${stats.isBlocking}`);
    console.log(`   ⏱️  Running: ${stats.isRunning}`);
    console.log(`   🖥️  Hosts file: ${daemon.hostsPath}`);
    
    // Test domain checking
    console.log('\n3️⃣ Testing domain checking:');
    const testDomains = ['google.com', 'facebook.com', 'xvideos.com', 'pornhub.com'];
    testDomains.forEach(domain => {
      const blocked = daemon.isDomainBlocked(domain);
      console.log(`   ${domain}: ${blocked ? '🚫 BLOCKED' : '✅ ALLOWED'}`);
    });
    
    // Test toggle functionality
    console.log('\n4️⃣ Testing toggle functionality...');
    await daemon.toggleBlocking(); // Should disable
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
    await daemon.toggleBlocking(); // Should enable again
    
    // Final stats
    console.log('\n5️⃣ Final stats:');
    const finalStats = daemon.getStats();
    console.log(`   🔒 Blocking enabled: ${finalStats.isBlocking}`);
    console.log(`   ⏱️  Uptime: ${Math.round(finalStats.uptime / 1000)}s`);
    
    // Shutdown
    console.log('\n6️⃣ Shutting down...');
    await daemon.shutdown();
    
    console.log('\n✅ Test completed successfully!');
    console.log('\n🎯 Next steps:');
    console.log('   - If everything looks good, remove --dry-run to test for real');
    console.log('   - Make sure to run with sudo/admin privileges for real testing');
    console.log('   - Consider testing on a VM first');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error);
  }
}

// Run test
testDaemon();