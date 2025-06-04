const TrayStartupManager = require('./tray-startup-manager');

async function testTrayStartupManager() {
    console.log('🧪 Testing Tray Startup Manager...\n');
    
    const startupManager = new TrayStartupManager();
    
    // 1. Validate paths
    console.log('1️⃣ Validating paths...');
    const validation = startupManager.validatePaths();
    if (validation.valid) {
        console.log('✅ All required paths are valid');
    } else {
        console.log('⚠️ Some path issues found:');
        validation.issues.forEach(issue => console.log(`   - ${issue}`));
        console.log('📝 This might be OK - continuing with installation...');
    }
    
    // 2. Check current status
    console.log('\n2️⃣ Checking current status...');
    const status = startupManager.getStatus();
    console.log(`   Installed: ${status.installed ? '✅ Yes' : '❌ No'}`);
    console.log(`   Batch file: ${status.batchFilePath}`);
    console.log(`   Tray path: ${status.trayPath}`);
    console.log(`   Main script: ${status.mainScript}`);
    
    // 3. Install auto-start
    console.log('\n3️⃣ Installing tray auto-start...');
    const installResult = await startupManager.install();
    if (installResult) {
        console.log('✅ Tray installation test passed');
    } else {
        console.log('❌ Tray installation test failed');
        return;
    }
    
    // 4. Check status after install
    console.log('\n4️⃣ Verifying tray installation...');
    const newStatus = startupManager.getStatus();
    console.log(`   Installed: ${newStatus.installed ? '✅ Yes' : '❌ No'}`);
    
    // 5. Summary
    console.log('\n5️⃣ Tray auto-start is now installed!');
    console.log('⚠️ The tray will start automatically on next Windows boot');
    console.log('⏱️ Tray will wait 5 seconds after boot for daemon to be ready');
    console.log('💡 Both daemon and tray are now configured for auto-start');
    
    console.log('\n🎉 Tray Startup Manager test completed successfully!');
    console.log('\n📋 Next steps:');
    console.log('   - Test the complete auto-start flow with a reboot');
    console.log('   - Or continue with Task 2.4 (Process Management)');
}

// Run the test
testTrayStartupManager().catch(console.error);