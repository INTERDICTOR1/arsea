const { app, BrowserWindow, session, ipcMain } = require('electron');
const path = require('path');
const blocklist = require('./blocklist/blocklist.js');

let mainWindow;
let isBlockingEnabled = true;

// Initialize blocklist on startup
async function initializeBlocklist() {
  try {
    await blocklist.initialize();
    const stats = blocklist.getStats();
    console.log(`🔒 Blocklist ready: ${stats.totalDomains} domains from ${stats.sources} sources`);
  } catch (error) {
    console.error('❌ Failed to initialize blocklist:', error);
  }
}

// Check if URL should be blocked
function shouldBlockURL(url) {
  if (!isBlockingEnabled) return false;
  
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return blocklist.isBlocked(hostname);
  } catch (error) {
    console.error('Error checking URL:', error);
    return false;
  }
}

// Create main application window
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    title: 'Arsea - Content Blocker'
  });

  mainWindow.loadFile('index.html');
  
  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

// Create blocked page window
function createBlockedWindow(blockedUrl) {
  const blockedWindow = new BrowserWindow({
    width: 600,
    height: 400,
    title: 'Site Blocked - Arsea'
  });

  const blockedHTML = `
    <!DOCTYPE html>
    <html>
    <head>
      <title>Site Blocked</title>
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: white;
          display: flex;
          align-items: center;
          justify-content: center;
          height: 100vh;
          margin: 0;
          text-align: center;
        }
        .container {
          background: rgba(255,255,255,0.1);
          backdrop-filter: blur(10px);
          border-radius: 20px;
          padding: 40px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        }
        h1 { margin: 0 0 20px 0; font-size: 2em; }
        .url { 
          background: rgba(255,255,255,0.2); 
          padding: 10px; 
          border-radius: 10px; 
          font-family: monospace;
          word-break: break-all;
          margin: 20px 0;
        }
        .message { font-size: 1.1em; opacity: 0.9; line-height: 1.5; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🚫 Access Blocked</h1>
        <div class="url">${blockedUrl}</div>
        <div class="message">
          This site has been blocked by Arsea content filter.<br>
          Contact your administrator for access.
        </div>
      </div>
    </body>
    </html>
  `;

  blockedWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(blockedHTML)}`);
}

// Test function to verify blocking works
function testBlocking() {
  const testDomains = [
    'google.com',      // Should be allowed
    'facebook.com',    // Might be blocked depending on blocklist
    'porncomics.com',     // Should be blocked
    'xvideos.com',     // Should be blocked
  ];

  console.log('\n🧪 Testing blocking functionality:');
  testDomains.forEach(domain => {
    const blocked = blocklist.isBlocked(domain);
    console.log(`  ${domain}: ${blocked ? '🚫 BLOCKED' : '✅ ALLOWED'}`);
  });
}

// IPC handlers for renderer process communication
ipcMain.handle('get-blocklist-stats', () => {
  return blocklist.getStats();
});

ipcMain.handle('toggle-blocking', () => {
  isBlockingEnabled = !isBlockingEnabled;
  console.log(`🔄 Blocking ${isBlockingEnabled ? 'ENABLED' : 'DISABLED'}`);
  return isBlockingEnabled;
});

ipcMain.handle('test-domain', (event, domain) => {
  return blocklist.isBlocked(domain);
});

// App initialization
app.whenReady().then(async () => {
  // Initialize blocklist first
  await initializeBlocklist();

  // Setup web request interceptor
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const { url, resourceType } = details;
    
    // Only block main frame requests (page navigation)
    if (resourceType === 'mainFrame' && shouldBlockURL(url)) {
      console.log('⛔ Blocked navigation to:', url);
      
      // Create blocked page instead of just canceling
      setTimeout(() => createBlockedWindow(url), 100);
      
      return callback({ cancel: true });
    }
    
    return callback({ cancel: false });
  });

  // Create main window
  createMainWindow();

  // Test blocking functionality
  setTimeout(testBlocking, 2000);
});

// App event handlers
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('👋 Shutting down Arsea...');
  app.quit();
});