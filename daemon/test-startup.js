const StartupManager = require('./startup-manager');

async function testStartupManager() {
    console.log('🧪 Testing Startup Manager...\n');
    
    const startupManager = new StartupManager();
    
    // 1. Validate paths
    console.log('1️⃣ Validating paths...');
    const validation = startupManager.validatePaths();
    if (validation.valid) {
        console.log('✅ All paths are valid');
    } else {
        console.log('❌ Path validation failed:');
        validation.issues.forEach(issue => console.log(`   - ${issue}`));
        return;
    }
    
    // 2. Check current status
    console.log('\n2️⃣ Checking current status...');
    const status = startupManager.getStatus();
    console.log(`   Installed: ${status.installed ? '✅ Yes' : '❌ No'}`);
    console.log(`   Batch file: ${status.batchFilePath}`);
    console.log(`   Daemon path: ${status.daemonPath}`);
    
    // 3. Install auto-start
    console.log('\n3️⃣ Installing auto-start...');
    const installResult = await startupManager.install();
    if (installResult) {
        console.log('✅ Installation test passed');
    } else {
        console.log('❌ Installation test failed');
        return;
    }
    
    // 4. Check status after install
    console.log('\n4️⃣ Verifying installation...');
    const newStatus = startupManager.getStatus();
    console.log(`   Installed: ${newStatus.installed ? '✅ Yes' : '❌ No'}`);
    
    // 5. Ask user if they want to keep it or uninstall for testing
    console.log('\n5️⃣ Auto-start is now installed!');
    console.log('⚠️ The daemon will start automatically on next Windows boot');
    console.log('💡 To uninstall later, you can run startupManager.uninstall()');
    
    console.log('\n🎉 Startup Manager test completed successfully!');
}

// Run the test
testStartupManager().catch(console.error);