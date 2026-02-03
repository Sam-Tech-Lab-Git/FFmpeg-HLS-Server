const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');

const app = express();
const PORT = 8080;

// --- CONFIGURATION DES RÉPERTOIRES ---
const ROOT_DIR = __dirname;
const STREAMS_DIR = path.join(ROOT_DIR, 'streams');
const PLAYLISTS_DIR = path.join(ROOT_DIR, 'playlists');
const ASSETS_DIR = path.join(ROOT_DIR, 'assets');

const INACTIVITY_LIMIT = 120_000; // 2 minutes
const CLEANUP_INTERVAL = 15_000;  // 15 secondes

// --- ÉTAT GLOBAL ---
const active = new Map();
const stats = { startTime: Date.now(), totalStarted: 0, totalStopped: 0, totalErrors: 0, bandwidth: 0 };
const history = []; 
const logClients = new Set();

// Initialisation des dossiers
[STREAMS_DIR, PLAYLISTS_DIR, ASSETS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --- 1. GÉNÉRATION DU PLACEHOLDER ---
async function generatePlaceholder() {
    const placeholderTS = path.join(ASSETS_DIR, 'loading.ts');
    const placeholderM3U8 = path.join(ASSETS_DIR, 'loading.m3u8');
    
    if (fs.existsSync(placeholderM3U8)) return;

    console.log("🎬 Génération du clip universel (H.264 + AAC)...");
    
    const args = [
        '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:r=25',
        '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-vf', "drawtext=text='Veuillez patienter...':fontcolor=white:fontsize=40:x=(w-text_w)/2:y=(h-text_h)/2",
        '-c:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-t', '5', '-y', placeholderTS
    ];

    const gen = spawn('ffmpeg', args);
    gen.on('close', (code) => {
        if (code === 0) {
            const content = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:5
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:5.0,
/assets/loading.ts`;
            fs.writeFileSync(placeholderM3U8, content);
            console.log("✅ Placeholder prêt.");
        }
    });
}
generatePlaceholder();

// --- 2. FONCTIONS UTILITAIRES ---
function collectSystemStats() {
    const mem = process.memoryUsage();
    return {
        timestamp: Date.now(),
        uptime: Math.round((Date.now() - stats.startTime) / 1000),
        memory: Math.round(mem.heapUsed / 1024 / 1024),
        cpuCount: os.cpus().length,
        load: os.loadavg()[0].toFixed(2),
        activeStreams: active.size
    };
}

function parseM3U(file) {
    try {
        const content = fs.readFileSync(file, 'utf-8');
        const url = content.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'));
        if (!url) throw new Error('URL non trouvée dans le M3U');
        return url;
    } catch (err) {
        throw new Error(`Erreur M3U: ${err.message}`);
    }
}

function getPaths(ch) {
    const dir = path.join(STREAMS_DIR, ch);
    return {
        dir,
        playlist: path.join(dir, `${ch}.m3u8`),
        segments: path.join(dir, `${ch}_%03d.ts`)
    };
}

// --- 3. GESTION DES FLUX FFMPEG ---
function startStream(ch, retryCount = 0) {
    if (active.has(ch)) return;

    const m3uFile = path.join(PLAYLISTS_DIR, `${ch}.m3u`);
    if (!fs.existsSync(m3uFile)) return console.error(`❌ Playlist manquante: ${ch}.m3u`);

    let url;
    try { url = parseM3U(m3uFile); } catch (e) { return console.error(e.message); }

    const { dir, playlist, segments } = getPaths(ch);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // ARGUMENTS OPTIMISÉS VAAPI (AMD/INTEL)
    const args = [
        "-hide_banner", "-loglevel", "error",
        "-init_hw_device", "vaapi=gpu:/dev/dri/renderD128",
        "-filter_hw_device","gpu",
        "-fflags", "+genpts",
        "-rw_timeout", "30000000",
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_delay_max", "10",
        "-reconnect_at_eof", "1",
        "-probesize", "3M", "-analyzeduration", "2M",
        "-user_agent", "Mozilla/5.0",
        "-i", url,
        "-map","0:v:0",
        "-map","0:a:0?",
        "-vf","format=nv12,hwupload,deinterlace_vaapi=rate=frame,scale_vaapi=w=1280:h=720",
        "-c:v", "h264_vaapi",
        "-b:v", "3000k", "-maxrate", "3500k", "-bufsize", "6000k",
        "-g", "150", "-bf", "0", 
        "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000",
        "-f", "hls",
        "-hls_time", "6",
        "-hls_list_size", "6",
        "-hls_flags", "independent_segments+program_date_time+delete_segments+temp_file",
        "-hls_segment_type", "mpegts",
        "-hls_segment_filename", segments,
        "-hls_base_url", `/hls/${ch}/`,
        playlist
    ];

    const proc = spawn('ffmpeg', args);
    const state = { proc, start: Date.now(), lastAccess: Date.now(), intentionalStop: false };

    proc.stderr.on('data', d => console.error(`[${ch}] ${d.toString().trim()}`));

    proc.on('exit', async () => {
        if (!state.intentionalStop && retryCount < 3) {
            console.log(`🔄 Redémarrage de ${ch}...`);
            setTimeout(() => startStream(ch, retryCount + 1), 5000);
        }
        active.delete(ch);
        stats.totalStopped++;
        if(state.intentionalStop) fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    });

    active.set(ch, state);
    stats.totalStarted++;
    console.log(`▶️ Flux actif : ${ch}`);
}

// --- 4. ROUTES EXPRESS ---
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    next();
});

app.use('/hls', express.static(STREAMS_DIR, {
    setHeaders: (res, p) => {
        res.setHeader('Cache-Control', 'no-cache');
    }
}));

app.use('/assets', express.static(ASSETS_DIR, {
    setHeaders: (res, p) => {
        if (p.endsWith('.ts')) res.setHeader('Content-Type', 'video/MP2T');
        res.setHeader('Cache-Control', 'no-cache');
    }
}));

app.get('/hls/:ch.m3u8', async (req, res) => {
    const ch = req.params.ch;
    if (!/^[\w-]+$/.test(ch)) return res.status(400).send('Nom de chaîne invalide');

    const { playlist } = getPaths(ch);

    if (!active.has(ch)) {
        startStream(ch);
    } else {
        const s = active.get(ch);
        if (s) s.lastAccess = Date.now();
    }

    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.type('application/x-mpegURL');

    try {
        await fsp.access(playlist);
        const data = await fsp.readFile(playlist, 'utf8');
        return res.send(data);
    } catch (e) {
        const placeholder = path.join(ASSETS_DIR, 'loading.m3u8');
        if (fs.existsSync(placeholder)) {
            const data = fs.readFileSync(placeholder, 'utf8');
            return res.send(data);
        }
        res.status(202).send('Chargement...');
    }
});

app.get('/stats', (req, res) => {
    const activeStreams = {};
    active.forEach((s, ch) => {
        activeStreams[ch] = {
            uptime: Math.round((Date.now() - s.start) / 1000) + 's',
            lastAccess: Math.round((Date.now() - s.lastAccess) / 1000) + 's'
        };
    });
    res.json({ system: collectSystemStats(), activeStreams, totals: stats });
});

app.get('/dashboard', (req, res) => {
    res.send(`
        <body style="font-family:sans-serif; background:#121212; color:#eee; padding:40px;">
            <h1>📊 HLS Server Dashboard</h1>
            <div id="status"></div>
            <pre id="data" style="background:#1e1e1e; padding:20px; border-radius:8px;"></pre>
            <script>
                setInterval(async () => {
                    const r = await fetch('/stats');
                    const d = await r.json();
                    document.getElementById('data').textContent = JSON.stringify(d, null, 2);
                    document.getElementById('status').innerHTML = '🟢 Serveur Actif - ' + (d.system.activeStreams || 0) + ' flux';
                }, 2000);
            </script>
        </body>
    `);
});

// --- 5. NETTOYAGE ET LANCEMENT ---
setInterval(() => {
    const now = Date.now();
    for (const [ch, s] of active) {
        if (now - s.lastAccess > INACTIVITY_LIMIT) {
            console.log(`💤 Inactivité détectée sur ${ch}, arrêt...`);
            s.intentionalStop = true;
            s.proc.kill('SIGTERM');
        }
    }
}, CLEANUP_INTERVAL);

app.listen(PORT, () => {
    console.log(`🚀 Serveur HLS prêt sur http://localhost:${PORT}`);
    console.log(`📈 Stats : http://localhost:${PORT}/dashboard`);
});