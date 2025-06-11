// Electron main process - Arsea Tray with daemon auto-start

const { app } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const TrayController = require('./tray-controller');

let daemonProcess = null;

class ArseaTrayApp {
  constructor() {
    this.trayController = null;
    this.isDev = process.argv.includes('--dev');
    
    // Fix daemon path construction
    if (this.isDev) {
      // In development, use the actual daemon directory
      this.daemonPath = path.join(__dirname, '..', 'daemon', 'index.js');
    } else {
      // In production, use the resources directory
      this.daemonPath = path.join(process.resourcesPath, 'daemon', 'index.js');
    }
    
    console.log('Development mode:', this.isDev);
    console.log('Daemon path:', this.daemonPath);
    this.setupSingleInstance();
  }

  setupSingleInstance() {
    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
      app.quit();
    } else {
      app.on('second-instance', () => {
        // Optionally show a tray balloon or notification
        if (this.trayController && this.trayController.tray) {
          this.trayController.tray.displayBalloon?.({
            title: 'Arsea Content Blocker',
            content: 'Arsea is already running in system tray'
          });
        }
      });
      this.initializeApp();
    }
  }

  initializeApp() {
    // Hide dock icon on macOS - we only want system tray
    if (process.platform === 'darwin') {
      app.dock.hide();
    }

    // Prevent default window creation
    app.on('window-all-closed', () => {
      // Don't quit on window close - we're a tray app
    });

    app.on('ready', () => {
      this.onAppReady();
    });

    // Handle app activation (macOS specific)
    app.on('activate', () => {
      // No windows to restore - we're tray only
      if (!this.trayController) {
        this.trayController = new TrayController();
        this.trayController.initialize();
      }
    });

    // Handle before quit
    app.on('before-quit', () => {
      this.onBeforeQuit();
    });
  }

  startDaemon() {
    console.log('Starting daemon from:', this.daemonPath);

    // Get the path to the Node.js executable
    const nodePath = process.platform === 'win32' 
      ? path.join(process.execPath, '..', 'node.exe')
      : path.join(process.execPath, '..', 'node');
    
    console.log('Using Node.js from:', nodePath);

    // Ensure the daemon directory exists
    const daemonDir = path.dirname(this.daemonPath);
    if (!require('fs').existsSync(daemonDir)) {
      console.error('Daemon directory does not exist:', daemonDir);
      return;
    }

    // Ensure the daemon file exists
    if (!require('fs').existsSync(this.daemonPath)) {
      console.error('Daemon file does not exist:', this.daemonPath);
      return;
    }

    // Copy daemon files to the correct location in development mode
    if (this.isDev) {
      try {
        const daemonSourceDir = path.join(__dirname, '..', 'daemon');
        const daemonDestDir = path.join(__dirname, 'node_modules', 'electron', 'dist', 'resources', 'daemon');
        
        // Create the destination directory if it doesn't exist
        if (!require('fs').existsSync(daemonDestDir)) {
          require('fs').mkdirSync(daemonDestDir, { recursive: true });
        }

        // Copy all files from daemon directory
        const files = require('fs').readdirSync(daemonSourceDir);
        files.forEach(file => {
          const sourcePath = path.join(daemonSourceDir, file);
          const destPath = path.join(daemonDestDir, file);
          if (require('fs').statSync(sourcePath).isFile()) {
            require('fs').copyFileSync(sourcePath, destPath);
          }
        });

        // Update daemon path to use the copied files
        this.daemonPath = path.join(daemonDestDir, 'index.js');
        console.log('Updated daemon path to:', this.daemonPath);
      } catch (error) {
        console.error('Failed to copy daemon files:', error);
        return;
      }
    }

    daemonProcess = spawn(nodePath, [this.daemonPath], {
      cwd: daemonDir,
      stdio: 'pipe',
      detached: false,
      env: {
        ...process.env,
        NODE_ENV: this.isDev ? 'development' : 'production'
      }
    });

    daemonProcess.stdout.on('data', (data) => {
      console.log(`Daemon stdout: ${data}`);
    });

    daemonProcess.stderr.on('data', (data) => {
      console.error(`Daemon stderr: ${data}`);
    });

    daemonProcess.on('close', (code) => {
      console.log(`Daemon process exited with code ${code}`);
      if (code !== 0 && !app.isQuitting) {
        setTimeout(() => this.startDaemon(), 2000);
      }
    });

    daemonProcess.on('error', (err) => {
      console.error('Failed to start daemon:', err);
    });
  }

  stopDaemon() {
    if (daemonProcess) {
      console.log('Stopping daemon...');
      daemonProcess.kill('SIGTERM');
      daemonProcess = null;
    }
  }

  async onAppReady() {
    try {
      this.startDaemon();

      console.log('Arsea Tray starting...');
      this.trayController = new TrayController();
      await this.trayController.initialize();

      console.log('Arsea Tray ready!');

      if (this.isDev) {
        console.log('Running in development mode');
      }
    } catch (error) {
      console.error('Failed to initialize tray:', error);
      app.quit();
    }
  }

  onBeforeQuit() {
    app.isQuitting = true;
    this.stopDaemon();
    if (this.trayController) {
      this.trayController.destroy();
    }
  }
}

// Create app instance
const trayApp = new ArseaTrayApp();

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  if (trayApp) trayApp.stopDaemon();
  app.quit();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  if (trayApp) trayApp.stopDaemon();
  app.quit();
});

// Handle system shutdown
process.on('SIGINT', () => {
  if (trayApp) trayApp.stopDaemon();
  app.quit();
});

process.on('SIGTERM', () => {
  if (trayApp) trayApp.stopDaemon();
  app.quit();
});