import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const app = express();
const PORT = process.env.PORT || 3000;

// Track active videos with cleanup timers
const activeVideos = new Map();
const CLEANUP_DELAY = 5 * 60 * 1000; // 5 minutes after playback starts

// Free proxy sources
const PROXY_SOURCES = [
    'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
    'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
    'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt'
];

let proxyList = [];
let currentProxyIndex = 0;

// Fetch proxies on startup
async function fetchProxies() {
    console.log('Fetching proxies...');
    
    for (const source of PROXY_SOURCES) {
        try {
            const response = await fetch(source);
            const data = await response.text();
            
            const proxies = data.split('\n')
                .map(line => line.trim())
                .filter(line => line.match(/^(\d{1,3}\.){3}\d{1,3}:\d+$/))
                .map(proxy => `http://${proxy}`);
            
            if (proxies.length > 0) {
                proxyList = proxies;
                console.log(`Loaded ${proxyList.length} proxies`);
                return proxyList;
            }
        } catch (error) {
            console.error('Failed to fetch proxies:', error.message);
        }
    }
    
    console.log('No proxies loaded, using direct connection');
    return [];
}

// Get next proxy
function getNextProxy() {
    if (proxyList.length === 0) return null;
    const proxy = proxyList[currentProxyIndex];
    currentProxyIndex = (currentProxyIndex + 1) % proxyList.length;
    return proxy;
}

// Cleanup video file
function scheduleCleanup(filename) {
    const videoPath = path.join(process.cwd(), 'videos', filename);
    
    const timer = setTimeout(() => {
        if (fs.existsSync(videoPath)) {
            fs.unlinkSync(videoPath);
            console.log(`Cleaned up: ${filename}`);
        }
        activeVideos.delete(filename);
    }, CLEANUP_DELAY);
    
    activeVideos.set(filename, timer);
    console.log(`Cleanup scheduled for ${filename} in ${CLEANUP_DELAY / 1000}s`);
}

// Cancel cleanup if needed
function cancelCleanup(filename) {
    const timer = activeVideos.get(filename);
    if (timer) {
        clearTimeout(timer);
        activeVideos.delete(filename);
        console.log(`Cleanup canceled for ${filename}`);
    }
}

// Main video endpoint
// URL: /video?url=YOUTUBE_URL&quality=1080p (optional)
// Quality options: 2160p, 1440p, 1080p, 720p, 480p, 360p, best, worst
app.get('/video', async (req, res) => {
    const videoUrl = req.query.url;
    const quality = req.query.quality || 'best';

    console.log('\n=== NEW REQUEST ===');
    console.log('URL:', videoUrl);
    console.log('Quality:', quality);
    console.log('IP:', req.ip);

    if (!videoUrl) {
        return res.status(400).send('Missing URL parameter. Use: /video?url=YOUTUBE_URL&quality=1080p');
    }

    const videoId = Date.now();
    const tempFile = `video_${videoId}.mp4`;
    const finalPath = path.join(process.cwd(), 'videos', tempFile);

    // Create videos directory
    if (!fs.existsSync('videos')) {
        fs.mkdirSync('videos');
    }

    let attempts = 0;
    const maxAttempts = 5;

    async function attemptDownload(proxy = null) {
        attempts++;
        console.log(`Attempt ${attempts}/${maxAttempts}`, proxy ? `with proxy ${proxy}` : 'direct');

        // Build quality format string
        let formatString;
        if (quality === 'best') {
            formatString = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
        } else if (quality === 'worst') {
            formatString = 'worst[ext=mp4]/worst';
        } else {
            // Specific quality like 1080p, 720p, etc.
            const height = quality.replace('p', '');
            formatString = `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${height}][ext=mp4]/best`;
        }

        const ytdlpArgs = [
            '--no-check-certificates',
            '--extractor-args', 'youtube:player_client=android,web',
            '-f', formatString,
            '--merge-output-format', 'mp4',
            '-o', finalPath,
            videoUrl
        ];

        if (proxy) {
            ytdlpArgs.unshift('--proxy', proxy);
        }

        return new Promise((resolve) => {
            const ytdlp = spawn('yt-dlp', ytdlpArgs);

            ytdlp.stdout.on('data', (data) => {
                const line = data.toString();
                if (line.includes('[download]') && line.includes('%')) {
                    process.stdout.write('\r' + line.trim());
                }
            });

            ytdlp.on('close', (code) => {
                console.log(`\nProcess exited: ${code}`);
                resolve(code === 0);
            });

            req.on('close', () => {
                ytdlp.kill();
            });
        });
    }

    async function downloadWithRetry() {
        // Try with proxies
        for (let i = 0; i < maxAttempts; i++) {
            const proxy = getNextProxy();
            const success = await attemptDownload(proxy);
            
            if (success) {
                console.log('Download succeeded');
                return true;
            }
        }

        // Final attempt without proxy
        console.log('Trying direct connection...');
        return await attemptDownload(null);
    }

    try {
        const success = await downloadWithRetry();

        if (!success || !fs.existsSync(finalPath)) {
            return res.status(500).send('Download failed after all attempts');
        }

        const stats = fs.statSync(finalPath);
        console.log(`Downloaded: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

        // Schedule cleanup
        scheduleCleanup(tempFile);

        // Redirect to player
        res.redirect(`/play/${tempFile}`);

    } catch (error) {
        console.error('Error:', error.message);
        res.status(500).send('Internal error: ' + error.message);
    }
});

// Minimal player page
app.get('/play/:filename', (req, res) => {
    const filename = req.params.filename;
    const videoPath = path.join(process.cwd(), 'videos', filename);
    
    if (!fs.existsSync(videoPath)) {
        return res.status(404).send('Video not found');
    }
    
    res.send(`<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Video</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { background: #000; }
        video {
            width: 100vw;
            height: 100vh;
            object-fit: contain;
        }
    </style>
</head>
<body>
    <video controls autoplay>
        <source src="/videos/${filename}" type="video/mp4">
    </video>
    <script>
        // Delete video when user leaves or unfocuses the page
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                fetch('/cleanup/${filename}', { method: 'POST' });
            }
        });
        
        // Also delete on page unload
        window.addEventListener('beforeunload', () => {
            navigator.sendBeacon('/cleanup/${filename}');
        });
    </script>
</body>
</html>`);
});

// Serve video files with proper streaming support
app.get('/videos/:filename', (req, res) => {
    const filename = req.params.filename;
    const videoPath = path.join(process.cwd(), 'videos', filename);
    
    if (!fs.existsSync(videoPath)) {
        return res.status(404).send('Video not found');
    }
    
    // Reset cleanup timer
    if (activeVideos.has(filename)) {
        cancelCleanup(filename);
        scheduleCleanup(filename);
    }
    
    const stat = fs.statSync(videoPath);
    const fileSize = stat.size;
    const range = req.headers.range;
    
    if (range) {
        // Handle range requests for seeking/buffering
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunksize = (end - start) + 1;
        const file = fs.createReadStream(videoPath, { start, end });
        
        const head = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': 'video/mp4',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Connection': 'keep-alive'
        };
        
        res.writeHead(206, head);
        file.pipe(res);
    } else {
        // Full file request
        const head = {
            'Content-Length': fileSize,
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Connection': 'keep-alive'
        };
        
        res.writeHead(200, head);
        fs.createReadStream(videoPath).pipe(res);
    }
});

// Immediate cleanup endpoint
app.post('/cleanup/:filename', (req, res) => {
    const filename = req.params.filename;
    const videoPath = path.join(process.cwd(), 'videos', filename);
    
    // Cancel scheduled cleanup
    cancelCleanup(filename);
    
    // Delete immediately
    if (fs.existsSync(videoPath)) {
        fs.unlinkSync(videoPath);
        console.log(`Immediately cleaned up: ${filename} (user left page)`);
    }
    
    res.sendStatus(200);
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        proxies: proxyList.length,
        activeVideos: activeVideos.size
    });
});

// Cleanup old videos on startup
function cleanupOldVideos() {
    const videosDir = path.join(process.cwd(), 'videos');
    if (fs.existsSync(videosDir)) {
        const files = fs.readdirSync(videosDir);
        files.forEach(file => {
            const filePath = path.join(videosDir, file);
            fs.unlinkSync(filePath);
            console.log(`Removed old video: ${file}`);
        });
    }
}

// Start server
async function startServer() {
    console.log('Starting server...');
    
    cleanupOldVideos();
    await fetchProxies();
    
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
        console.log(`Usage: /video?url=YOUTUBE_URL&quality=1080p`);
        console.log(`Quality options: 2160p, 1440p, 1080p, 720p, 480p, 360p, best, worst`);
    });
}

startServer();

// Cleanup on exit
process.on('SIGINT', () => {
    console.log('\nShutting down...');
    activeVideos.forEach((timer) => clearTimeout(timer));
    process.exit(0);
});
