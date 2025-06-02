const ArseaDaemon = require('./index.js');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

async function testEnhancedDNSDaemon() {
  console.log('🧪 Testing Enhanced Arsea Daemon (DNS Proxy) in DRY RUN mode...\n');
  console.log('=' .repeat(60));
  
  // Create daemon in dry-run mode
  const daemon = new ArseaDaemon({ 
    dryRun: true,
    dnsOptions: {
      port: 5353, // Use non-privileged port for testing
      upstreamDNS: ['8.8.8.8', '8.8.4.4']
    }
  });
  
  // Set up comprehensive event listeners
  setupEventListeners(daemon);
  
  try {
    console.log('🔍 PHASE 1: INITIALIZATION TESTING');
    console.log('=' .repeat(40));
    
    // 1. System permission check
    console.log('1️⃣ Checking system permissions...');
    const permissions = await daemon.checkSystemPermissions();
    console.log(`   ✅ Permission checks completed (${permissions.length} checks)`);
    
    // 2. Initialize daemon
    console.log('\n2️⃣ Initializing daemon...');
    const initResult = await daemon.initialize();
    console.log(`   ✅ Daemon initialized: ${initResult}`);
    
    // 3. Check if blocklist loaded properly
    console.log('\n3️⃣ Verifying blocklist loading...');
    const stats = daemon.getStats();
    console.log(`   📊 Domains loaded: ${stats.domainsInList.toLocaleString()}`);
    console.log(`   📋 Blocklist source: ${stats.blocklist.source}`);
    console.log(`   🔧 Blocking method: ${stats.blockingMethod}`);
    console.log(`   📍 JSON path: ${stats.blocklist.jsonPath}`);
    
    if (stats.domainsInList === 0) {
      console.log('   ⚠️  WARNING: No domains loaded - check blocklist file');
    }
    
    console.log('\n🔍 PHASE 2: DNS PROXY TESTING');
    console.log('=' .repeat(40));
    
    // 4. Test domain checking (if method exists)
    console.log('4️⃣ Testing domain classification...');
    await testDomainClassification(daemon);
    
    // 5. Test DNS proxy functionality
    console.log('\n5️⃣ Testing DNS proxy operations...');
    await testDNSProxyOperations(daemon);
    
    console.log('\n🔍 PHASE 3: BLOCKING CONTROL TESTING');
    console.log('=' .repeat(40));
    
    // 6. Test blocking enable/disable
    console.log('6️⃣ Testing blocking control...');
    await testBlockingControl(daemon);
    
    // 7. Test toggle functionality
    console.log('\n7️⃣ Testing toggle functionality...');
    await testToggleFunctionality(daemon);
    
    console.log('\n🔍 PHASE 4: STATISTICS & MONITORING');
    console.log('=' .repeat(40));
    
    // 8. Display comprehensive stats
    console.log('8️⃣ Displaying comprehensive statistics...');
    displayComprehensiveStats(daemon);
    
    // 9. Test DNS statistics
    console.log('\n9️⃣ Testing DNS statistics...');
    const dnsStats = daemon.getDNSStats();
    console.log('   📊 DNS Statistics:');
    console.log(`      Queries: ${dnsStats.queries}`);
    console.log(`      Blocked: ${dnsStats.blocked}`);
    console.log(`      Allowed: ${dnsStats.allowed}`);
    console.log(`      Block Rate: ${dnsStats.blockRate}%`);
    
    console.log('\n🔍 PHASE 5: CLEANUP & SHUTDOWN');
    console.log('=' .repeat(40));
    
    // 10. Test graceful shutdown
    console.log('🔟 Testing graceful shutdown...');
    await daemon.shutdown();
    console.log('   ✅ Shutdown completed successfully');
    
    console.log('\n' + '=' .repeat(60));
    console.log('✅ ALL TESTS COMPLETED SUCCESSFULLY!');
    console.log('=' .repeat(60));
    
    // Show next steps
    showNextSteps(stats);
    
  } catch (error) {
    console.error('\n❌ TEST FAILED:', error);
    console.error('Stack trace:', error.stack);
    
    // Try to shutdown gracefully even on error
    try {
      await daemon.shutdown();
    } catch (shutdownError) {
      console.error('❌ Shutdown also failed:', shutdownError.message);
    }
  }
}

function setupEventListeners(daemon) {
  console.log('📡 Setting up event listeners...');
  
  daemon.on('started', () => {
    console.log('   📡 Event: Daemon started');
  });
  
  daemon.on('blocking-applied', (data) => {
    console.log(`   📡 Event: Blocking applied (${data.method}, ${data.domains} domains)`);
  });
  
  daemon.on('blocking-removed', () => {
    console.log('   📡 Event: Blocking removed');
  });
  
  daemon.on('blocking-failed', (data) => {
    console.log(`   📡 Event: Blocking failed - ${data.error}`);
  });
  
  daemon.on('blocklist-loaded', (data) => {
    console.log(`   📡 Event: Blocklist loaded (${data.domains} domains from ${data.source})`);
  });
  
  daemon.on('dns-query', (data) => {
    // Only log first few queries to avoid spam
    if (data.stats.queries <= 5) {
      console.log(`   📡 Event: DNS Query - ${data.domain} (${data.blocked ? 'BLOCKED' : 'ALLOWED'})`);
    }
  });
  
  daemon.on('dns-proxy-started', () => {
    console.log('   📡 Event: DNS proxy started');
  });
  
  daemon.on('dns-proxy-stopped', () => {
    console.log('   📡 Event: DNS proxy stopped');
  });
  
  daemon.on('dns-proxy-error', (error) => {
    console.log(`   📡 Event: DNS proxy error - ${error.message}`);
  });
  
  daemon.on('shutdown', () => {
    console.log('   📡 Event: Daemon shutdown');
  });
  
  daemon.on('error', (error) => {
    console.log(`   📡 Event: Error - ${error.message}`);
  });
}

async function testDomainClassification(daemon) {
  const testDomains = [
    'google.com',           // Should be allowed
    'facebook.com',         // Should be allowed
    'github.com',           // Should be allowed
    'pornhub.com',          // Should be blocked
    'xvideos.com',          // Should be blocked
    'redtube.com',          // Should be blocked
    'example.com',          // Should be allowed
    'nonexistent-test.xyz'  // Should be allowed (not in blocklist)
  ];
  
  console.log('   🔍 Testing domain classification:');
  
  // Check if daemon has domain checking method
  if (typeof daemon.isDomainBlocked === 'function') {
    testDomains.forEach(domain => {
      const blocked = daemon.isDomainBlocked(domain);
      const status = blocked ? '🚫 BLOCKED' : '✅ ALLOWED';
      console.log(`      ${domain}: ${status}`);
    });
  } else {
    console.log('   ⚠️  isDomainBlocked method not available (DNS proxy handles this internally)');
    console.log('   ℹ️  Domain blocking will be tested through DNS resolution');
  }
}

async function testDNSProxyOperations(daemon) {
  // Test if DNS proxy component is accessible
  if (daemon.dnsProxy) {
    console.log('   🌐 DNS Proxy component detected');
    console.log(`   📡 DNS Proxy port: ${daemon.dnsProxy.getPort ? daemon.dnsProxy.getPort() : 'Unknown'}`);
    
    // Test proxy stats if available
    if (typeof daemon.dnsProxy.getStats === 'function') {
      const proxyStats = daemon.dnsProxy.getStats();
      console.log('   📊 DNS Proxy Stats:');
      console.log(`      Running: ${proxyStats.isRunning ? 'Yes' : 'No'}`);
      console.log(`      Upstream DNS: ${proxyStats.upstreamDNS ? proxyStats.upstreamDNS.join(', ') : 'Unknown'}`);
    }
  } else {
    console.log('   ⚠️  DNS Proxy component not accessible for direct testing');
  }
  
  console.log('   ✅ DNS proxy operations check completed');
}

async function testBlockingControl(daemon) {
  console.log('   🔒 Testing blocking enable...');
  
  // Test enabling blocking
  daemon.isBlocking = true;
  const enableResult = await daemon.applyBlocking();
  console.log(`   ✅ Enable result: ${enableResult.success ? 'SUCCESS' : 'FAILED'} (${enableResult.reason || enableResult.method})`);
  
  // Wait a moment
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  console.log('   🔓 Testing blocking disable...');
  
  // Test disabling blocking
  daemon.isBlocking = false;
  await daemon.removeBlocking();
  console.log('   ✅ Disable completed');
}

async function testToggleFunctionality(daemon) {
  // Check if toggle method exists
  if (typeof daemon.toggleBlocking === 'function') {
    console.log('   🔄 Testing toggle method...');
    
    const initialState = daemon.isBlocking;
    console.log(`   📊 Initial state: ${initialState ? 'ENABLED' : 'DISABLED'}`);
    
    // Toggle once
    await daemon.toggleBlocking();
    console.log(`   📊 After first toggle: ${daemon.isBlocking ? 'ENABLED' : 'DISABLED'}`);
    
    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Toggle back
    await daemon.toggleBlocking();
    console.log(`   📊 After second toggle: ${daemon.isBlocking ? 'ENABLED' : 'DISABLED'}`);
    
    console.log('   ✅ Toggle functionality tested');
  } else {
    console.log('   ⚠️  Toggle method not available - implementing manual toggle test');
    
    // Manual toggle test
    const initialState = daemon.isBlocking;
    
    daemon.isBlocking = !initialState;
    console.log(`   📊 Manual toggle: ${daemon.isBlocking ? 'ENABLED' : 'DISABLED'}`);
    
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    daemon.isBlocking = initialState;
    console.log(`   📊 Restored to: ${daemon.isBlocking ? 'ENABLED' : 'DISABLED'}`);
  }
}

function displayComprehensiveStats(daemon) {
  const stats = daemon.getStats();
  
  console.log('   📊 COMPREHENSIVE STATISTICS:');
  console.log('   ' + '-'.repeat(30));
  
  // Core stats
  console.log(`   🔧 Daemon Status:`);
  console.log(`      Running: ${stats.isRunning ? 'Yes' : 'No'}`);
  console.log(`      Blocking: ${stats.isBlocking ? 'Enabled' : 'Disabled'}`);
  console.log(`      Method: ${stats.blockingMethod}`);
  console.log(`      Uptime: ${Math.round(stats.uptime / 1000)}s`);
  
  // Blocklist stats
  console.log(`   📋 Blocklist:`);
  console.log(`      Domains: ${stats.domainsInList.toLocaleString()}`);
  console.log(`      Source: ${stats.blocklist.source}`);
  console.log(`      Last Update: ${stats.blocklist.lastUpdate ? new Date(stats.blocklist.lastUpdate).toLocaleString() : 'Never'}`);
  
  // DNS stats
  if (stats.dns) {
    console.log(`   🌐 DNS Statistics:`);
    console.log(`      Queries: ${stats.dns.queries}`);
    console.log(`      Blocked: ${stats.dns.blocked}`);
    console.log(`      Allowed: ${stats.dns.allowed}`);
    console.log(`      Block Rate: ${stats.dns.blockRate}`);
    console.log(`      Proxy Status: ${stats.dns.proxyStatus}`);
    console.log(`      Proxy Port: ${stats.dns.proxyPort}`);
    console.log(`      Upstream DNS: ${stats.dns.upstreamDNS ? stats.dns.upstreamDNS.join(', ') : 'Not available'}`);
  }
  
  // Performance stats
  console.log(`   ⚡ Performance:`);
  console.log(`      Total Blocked: ${stats.totalBlocked}`);
  console.log(`      Memory Usage: ~${Math.round(stats.domainsInList * 50 / 1024)}KB (estimated)`);
}

function showNextSteps(stats) {
  console.log('\n🎯 NEXT STEPS:');
  console.log('=' .repeat(30));
  
  if (stats.domainsInList > 0) {
    console.log('✅ Blocklist loaded successfully');
    console.log('✅ DNS proxy architecture ready');
    console.log('');
    console.log('🚀 Ready for real testing:');
    console.log('   1. Remove --dry-run flag to test for real');
    console.log('   2. Run with elevated privileges if needed');
    console.log('   3. Test DNS resolution: nslookup pornhub.com');
    console.log('   4. Monitor system performance');
    console.log('');
    console.log('💡 Commands to try:');
    console.log('   node index.js --enable    # Enable blocking');
    console.log('   node index.js --disable   # Disable blocking');
    console.log('   node index.js --status    # Show status');
    console.log('   node index.js --test-dns  # Test DNS resolution');
  } else {
    console.log('⚠️  BLOCKLIST ISSUE DETECTED:');
    console.log('   - No domains loaded from blocklist');
    console.log('   - Check if domains.json exists and is valid');
    console.log('   - Verify file path in daemon configuration');
    console.log('');
    console.log('🔧 Troubleshooting:');
    console.log('   1. Check if blocklist/domains.json exists');
    console.log('   2. Verify JSON format is valid');
    console.log('   3. Check file permissions');
    console.log('   4. Review daemon logs for errors');
  }
  
  console.log('');
  console.log('📚 Documentation:');
  console.log('   - Review session log for implementation details');
  console.log('   - Check DNS proxy architecture notes');
  console.log('   - Monitor system performance during testing');
}

// Enhanced error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

// Run the comprehensive test
console.log('🚀 Starting Enhanced Arsea DNS Proxy Test Suite...');
console.log('🕐 ' + new Date().toLocaleString());
console.log('');

testEnhancedDNSDaemon().then(() => {
  console.log('\n🏁 Test suite completed');
  process.exit(0);
}).catch((error) => {
  console.error('\n💥 Test suite failed:', error);
  process.exit(1);
});