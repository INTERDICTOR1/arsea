// Electron main process - to be implemented in 2.1.2
const { app, BrowserWindow } = require('electron');
const path = require('path');
const TrayController = require('./tray-controller');

class ArseaTrayApp {
  constructor() {
    this.trayController = null;
    this.isDev = process.argv.includes('--dev');
    
    this.initializeApp();
  }

  initializeApp() {
    // Hide dock icon on macOS - we only want system tray
    if (process.platform === 'darwin') {
      app.dock.hide();
    }

    // Prevent default window creation
    app.on('window-all-closed', () => {
      // Don't quit on window close - we're a tray app
      // App will quit when tray is explicitly closed
    });

    app.on('ready', () => {
      this.onAppReady();
    });

    // Handle app activation (macOS specific)
    app.on('activate', () => {
      // No windows to restore - we're tray only
    });

    // Handle before quit
    app.on('before-quit', () => {
      this.onBeforeQuit();
    });
  }

  async onAppReady() {
    try {
      console.log('Arsea Tray starting...');
      
      // Initialize system tray
      this.trayController = new TrayController();
      await this.trayController.initialize();
      
      console.log('Arsea Tray ready!');
      
      // Development mode logging
      if (this.isDev) {
        console.log('Running in development mode');
      }
      
    } catch (error) {
      console.error('Failed to initialize tray:', error);
      app.quit();
    }
  }

  onBeforeQuit() {
    console.log('Arsea Tray shutting down...');
    
    if (this.trayController) {
      this.trayController.destroy(); // <-- Use destroy() instead of cleanup()
    }
  }
}

// Create app instance
const trayApp = new ArseaTrayApp();

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  app.quit();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});