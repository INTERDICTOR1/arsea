const https = require('https');
const fs = require('fs');
const path = require('path');


const BLOCKLIST_URLS = [
  'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts',
  'https://someonewhocares.org/hosts/zero/hosts',
  'https://raw.githubusercontent.com/blocklistproject/Lists/master/porn.txt'
];

let blockedDomains = new Set();

/**
 * Downloads blocklist from URL with timeout and error handling
 */
function downloadBlocklist(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error(`Timeout downloading ${url}`));
    });
    
    req.on('error', reject);
  });
}

/**
 * Parses different blocklist formats
 */
function parseBlocklist(rawData, format = 'hosts') {
  const domains = new Set();
  const lines = rawData.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
    
    let domain = null;
    
    if (format === 'hosts') {
      // Hosts file format: 0.0.0.0 domain.com or 127.0.0.1 domain.com
      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2 && (parts[0] === '0.0.0.0' || parts[0] === '127.0.0.1')) {
        domain = parts[1].toLowerCase();
      }
    } else if (format === 'domain') {
      // Plain domain list format
      domain = trimmed.toLowerCase();
    } else if (format === 'adblock') {
      // AdBlock format: ||domain.com^
      const match = trimmed.match(/\|\|([^\/\^]+)/);
      if (match) {
        domain = match[1].toLowerCase();
      }
    }
    
    // Validate and add domain
    if (domain && isValidDomain(domain) && !isWhitelisted(domain)) {
      domains.add(domain);
    }
  }
  
  return domains;
}

/**
 * Validates if string is a proper domain
 */
function isValidDomain(domain) {
  // Basic domain validation
  const domainRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
  return domainRegex.test(domain) && 
         domain.length > 0 && 
         domain.length < 255 &&
         !domain.includes('..') &&
         domain.includes('.');
}

/**
 * Check if domain should be whitelisted (not blocked)
 */
function isWhitelisted(domain) {
  const whitelist = [
    'localhost',
    'local',
    '0.0.0.0',
    '127.0.0.1',
    'broadcasthost'
  ];
  return whitelist.some(w => domain.includes(w));
}

/**
 * Downloads and merges multiple blocklists
 */
async function loadBlocklists() {
  console.log('🔄 Starting blocklist download...');
  const allDomains = new Set();
  
  // Add some hardcoded adult sites to ensure blocking works
  const hardcodedAdultSites = [
    'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 
    'redtube.com', 'tube8.com', 'spankbang.com', 'eporner.com',
    'tnaflix.com', 'youporn.com', 'porn.com', 'sex.com'
  ];
  
  hardcodedAdultSites.forEach(domain => allDomains.add(domain));
  console.log(`✅ Added ${hardcodedAdultSites.length} hardcoded adult sites`);
  
  for (const url of BLOCKLIST_URLS) {
    try {
      console.log(`📥 Downloading: ${url}`);
      const rawData = await downloadBlocklist(url);
      
      // Determine format based on URL
      let format = 'hosts';
      if (url.includes('adguard')) format = 'adblock';
      if (url.includes('domain') || url.includes('porn.txt')) format = 'domain';
      
      const domains = parseBlocklist(rawData, format);
      console.log(`✅ Parsed ${domains.size} domains from ${url}`);
      
      // Merge into main set
      domains.forEach(domain => allDomains.add(domain));
      
    } catch (error) {
      console.error(`❌ Failed to load ${url}:`, error.message);
    }
  }
  
  blockedDomains = allDomains;
  console.log(`🔒 Total blocklist loaded: ${blockedDomains.size} domains`);
  
  // Save to file for faster loading next time
  await saveBlocklistToFile();
  
  return blockedDomains;
}

/**
 * Save processed blocklist to file
 */
async function saveBlocklistToFile() {
  try {
    const blocklistDir = path.join(__dirname, 'blocklist');
    if (!fs.existsSync(blocklistDir)) {
      fs.mkdirSync(blocklistDir, { recursive: true });
    }
    
    const filePath = path.join(blocklistDir, 'domains.json');
    const domainsArray = Array.from(blockedDomains);
    
    await fs.promises.writeFile(filePath, JSON.stringify(domainsArray, null, 2));
    console.log(`💾 Saved ${domainsArray.length} domains to ${filePath}`);
  } catch (error) {
    console.error('❌ Failed to save blocklist:', error);
  }
}

/**
 * Load blocklist from saved file (faster startup)
 */
async function loadFromFile() {
  try {
    const filePath = path.join(__dirname, 'blocklist', 'domains.json');
    if (fs.existsSync(filePath)) {
      const data = await fs.promises.readFile(filePath, 'utf8');
      const domains = JSON.parse(data);
      blockedDomains = new Set(domains);
      console.log(`📂 Loaded ${blockedDomains.size} domains from cache`);
      return true;
    }
  } catch (error) {
    console.error('❌ Failed to load from cache:', error);
  }
  return false;
}

/**
 * Check if domain is blocked (supports subdomains)
 */
function isBlocked(domain) {
  if (!domain) return false;
  
  domain = domain.toLowerCase().replace(/^www\./, '');
  
  // Direct match
  if (blockedDomains.has(domain)) return true;
  
  // Check parent domains (subdomain blocking)
  const parts = domain.split('.');
  for (let i = 1; i < parts.length; i++) {
    const parentDomain = parts.slice(i).join('.');
    if (blockedDomains.has(parentDomain)) {
      return true;
    }
  }
  
  return false;
}

/**
 * Initialize blocklist (try cache first, then download)
 */
async function initialize() {
  const loadedFromCache = await loadFromFile();
  
  if (!loadedFromCache || blockedDomains.size === 0) {
    console.log('📡 No cache found, downloading fresh blocklists...');
    await loadBlocklists();
  } else {
    // Optionally refresh in background
    setTimeout(() => {
      console.log('🔄 Refreshing blocklist in background...');
      loadBlocklists().catch(console.error);
    }, 5000);
  }
}

/**
 * Get blocklist stats
 */
function getStats() {
  return {
    totalDomains: blockedDomains.size,
    sources: BLOCKLIST_URLS.length
  };
}

module.exports = {
  initialize,
  isBlocked,
  getStats,
  loadBlocklists,
  getDomains: () => Array.from(blockedDomains)
};