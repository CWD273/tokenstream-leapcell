// server.js (Leapcell - Token Service)
import express from 'express';
import puppeteer from 'puppeteer';
import { executablePath } from 'puppeteer';

const app = express();
const PORT = process.env.PORT || 8080;

// Token cache
const tokenCache = new Map();
const CACHE_DURATION = 120000; // 2 minutes

// Track retry attempts per stream
const retryState = new Map();

app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Health check
app.get('/health', (req, res) => {
  const cacheSize = tokenCache.size;
  res.json({ 
    status: 'ok', 
    uptime: process.uptime(),
    cachedTokens: cacheSize,
    memory: process.memoryUsage()
  });
});

async function extractToken(originalUrl, retryCount = 0) {
  let browser = null;
  
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920x1080',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });

    const page = await browser.newPage();
    
    // Realistic browser headers
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );
    
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': '*/*',
    });

    let tokenizedUrl = null;
    let redirectUrl = null;
    
    await page.setRequestInterception(true);
    
    page.on('request', (request) => {
      const url = request.url();
      
      // Capture tokenized URL
      if (url.includes('token=')) {
        tokenizedUrl = url;
        redirectUrl = url;
        request.abort();
      } else if (request.resourceType() === 'document' || 
                 request.resourceType() === 'xhr' ||
                 url.includes('.m3u8')) {
        request.continue();
      } else {
        request.abort(); // Block unnecessary resources
      }
    });

    // Navigate and capture redirect
    await page.goto(originalUrl, { 
      waitUntil: 'domcontentloaded', 
      timeout: 15000 
    });
    
    if (tokenizedUrl) {
      return { success: true, tokenUrl: tokenizedUrl };
    }
    
    throw new Error('Failed to capture tokenized URL');
    
  } catch (error) {
    console.error(`Token extraction error (attempt ${retryCount + 1}):`, error.message);
    
    if (retryCount < 2) {
      await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
      return extractToken(originalUrl, retryCount + 1);
    }
    
    return { 
      success: false, 
      error: error.message,
      retryCount: retryCount + 1
    };
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Main endpoint: Get token for a stream URL
app.post('/token', async (req, res) => {
  const { url, streamId, forceRefresh } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  const cacheKey = url;
  
  // Check cache (unless force refresh)
  if (!forceRefresh) {
    const cached = tokenCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
      return res.json({
        success: true,
        tokenUrl: cached.tokenUrl,
        cached: true,
        expiresIn: CACHE_DURATION - (Date.now() - cached.timestamp)
      });
    }
  }

  // Extract new token
  const result = await extractToken(url);
  
  if (result.success) {
    // Cache the token
    tokenCache.set(cacheKey, {
      tokenUrl: result.tokenUrl,
      timestamp: Date.now()
    });
    
    // Reset retry state on success
    retryState.delete(streamId || cacheKey);
    
    return res.json({
      success: true,
      tokenUrl: result.tokenUrl,
      cached: false,
      expiresIn: CACHE_DURATION
    });
  } else {
    // Track failures
    const currentState = retryState.get(streamId || cacheKey) || { failures: 0 };
    currentState.failures++;
    currentState.lastFailure = Date.now();
    retryState.set(streamId || cacheKey, currentState);
    
    return res.status(503).json({
      success: false,
      error: result.error,
      failures: currentState.failures,
      retryAfter: Math.min(5000 * currentState.failures, 30000) // Exponential backoff
    });
  }
});

// Batch token endpoint (for multiple streams)
app.post('/tokens/batch', async (req, res) => {
  const { streams } = req.body;
  
  if (!Array.isArray(streams)) {
    return res.status(400).json({ error: 'streams must be an array' });
  }

  const results = await Promise.all(
    streams.map(async ({ url, id }) => {
      const cacheKey = url;
      const cached = tokenCache.get(cacheKey);
      
      if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        return {
          id,
          success: true,
          tokenUrl: cached.tokenUrl,
          cached: true
        };
      }
      
      const result = await extractToken(url);
      
      if (result.success) {
        tokenCache.set(cacheKey, {
          tokenUrl: result.tokenUrl,
          timestamp: Date.now()
        });
      }
      
      return {
        id,
        ...result
      };
    })
  );

  res.json({ results });
});

// Clear cache endpoint (for debugging)
app.post('/cache/clear', (req, res) => {
  const { streamId } = req.body;
  
  if (streamId) {
    // Clear specific stream
    let cleared = 0;
    for (const [key, value] of tokenCache.entries()) {
      if (key.includes(streamId)) {
        tokenCache.delete(key);
        cleared++;
      }
    }
    return res.json({ cleared, remaining: tokenCache.size });
  } else {
    // Clear all
    const size = tokenCache.size;
    tokenCache.clear();
    retryState.clear();
    return res.json({ cleared: size, remaining: 0 });
  }
});

// Stats endpoint
app.get('/stats', (req, res) => {
  const stats = {
    cachedTokens: tokenCache.size,
    failedStreams: retryState.size,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cacheDetails: Array.from(tokenCache.entries()).map(([url, data]) => ({
      url: url.substring(0, 50) + '...',
      age: Date.now() - data.timestamp,
      expiresIn: CACHE_DURATION - (Date.now() - data.timestamp)
    }))
  };
  
  res.json(stats);
});

app.listen(PORT, () => {
  console.log(`🚀 Token Service running on port ${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/health`);
  console.log(`📈 Stats: http://localhost:${PORT}/stats`);
});
