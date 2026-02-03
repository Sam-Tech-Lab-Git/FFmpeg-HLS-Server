const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const os = require('os');

const app = express();
const PORT = 8080;

const ROOT_DIR = __dirname;
const STREAMS_DIR = path.join(ROOT_DIR, 'streams');
const PLAYLISTS_DIR = path.join(ROOT_DIR, 'playlists');

const INACTIVITY_LIMIT = 120_000;
const CLEANUP_INTERVAL = 15_000;

if (!fs.existsSync(STREAMS_DIR)) fs.mkdirSync(STREAMS_DIR, { recursive: true });
if (!fs.existsSync(PLAYLISTS_DIR)) fs.mkdirSync(PLAYLISTS_DIR, { recursive: true });

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

app.use('/hls', express.static(STREAMS_DIR, {
  setHeaders: res => res.set('Cache-Control', 'no-cache')
}));

const active = new Map();
const stats = { startTime: Date.now(), totalStarted: 0, totalStopped: 0, totalErrors: 0, bandwidth: 0 };
const history = []; 
const logClients = new Set();

function collectSystemStats() {
  const mem = process.memoryUsage();
  const load = os.loadavg();
  return {
    timestamp: Date.now(),
    uptime: Math.round((Date.now() - stats.startTime) / 1000),
    memory: Math.round(mem.heapUsed / 1024 / 1024),
    cpuCount: os.cpus().length,
    load: load[0],
    active: active.size
  };
}

function broadcastLog(line) {
  const data = `data: ${line.replace(/\n/g,' ')}\n\n`;
  for (const res of logClients) res.write(data);
}

function parseM3U(file) {
  try {
    const line = fs.readFileSync(file, 'utf-8')
      .split('\n').map(l => l.trim())
      .find(l => l && !l.startsWith('#'));
    if (!line) throw new Error('No URL found');
    return line;
  } catch (err) {
    throw new Error(`Erreur lecture M3U: ${err.message}`);
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

function startStream(ch, retryCount = 0) {
  if (active.has(ch)) return;

  const m3u = path.join(PLAYLISTS_DIR, `${ch}.m3u`);
  if (!fs.existsSync(m3u)) {
    console.error(`❌ Fichier playlist manquant: ${m3u}`);
    return;
  }
  
  let url;
  try {
    url = parseM3U(m3u);
  } catch (e) {
    console.error(e.message);
    return;
  }

  const { dir, playlist, segments } = getPaths(ch);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Note: Arguments optimisés pour VAAPI (Hardware Intel/AMD)
  const args = [
    '-hide_banner','-loglevel','error',
    '-hwaccel','vaapi',
    '-hwaccel_output_format','vaapi',
    '-vaapi_device','/dev/dri/renderD128',
    '-fflags','+genpts',
    '-rw_timeout', '30000000',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '10',
    '-probesize','5M','-analyzeduration','3M',
    '-user_agent','Mozilla/5.0',
    '-i', url,
    '-c:v','h264_vaapi',
    '-b:v','4000k',
    '-maxrate', '4000k',
    '-bufsize', '8000k',
    '-force_key_frames', 'expr:gte(t,n_forced*2)', // Force une keyframe toutes les 2s
    '-sc_threshold','0', // Désactive la détection de changement de scène pour respecter strictement le GOP
    '-c:a','aac','-b:a','128k','-ac','2','-ar','48000',
    '-flags','+global_header','-f','hls',
    '-hls_time','6', // Augmenté à 6s pour réduire les coupures
    '-hls_list_size','10',
    '-hls_flags','+independent_segments+program_date_time+delete_segments+temp_file', // temp_file évite de servir des fichiers partiels
    '-hls_segment_type','mpegts',
    '-hls_segment_filename',segments,
    '-hls_base_url',`/hls/${ch}/`,
    playlist
  ];

  const proc = spawn('ffmpeg', args);
  const start = Date.now();

  // Objet d'état pour ce flux
  const streamState = { 
    proc, 
    lastAccess: Date.now(), 
    start, 
    inputUrl: url,
    intentionalStop: false // Flag pour empêcher le restart si on stop manuellement
  };

  proc.stderr.on('data', d => {
    const line = `[${ch}] ${d.toString().trim()}`;
    console.error(line);
    broadcastLog(line);
  });

  proc.on('error', (err) => {
    console.error(`❌ Erreur spawn FFmpeg sur ${ch}:`, err);
  });

  proc.on('exit', async (code, signal) => {
    // Si c'est un arrêt intentionnel, on ne fait rien de spécial (pas de retry)
    if (streamState.intentionalStop) {
      console.log(`🛑 ${ch} arrêté manuellement (nettoyage).`);
    } else {
      console.log(`⚠️ ${ch} s'est arrêté inopinément (code ${code}, signal ${signal})`);
    }

    broadcastLog(`🛑 ${ch} stopped`);
    active.delete(ch);
    stats.totalStopped++;
    
    // On nettoie le dossier quoi qu'il arrive
    await safeDeleteFolder(dir);

    // On relance SEULEMENT si ce n'était pas un arrêt intentionnel
    if (!streamState.intentionalStop && retryCount < 3) {
      console.log(`🔄 Tentative de redémarrage ${ch} (${retryCount + 1}/3)...`);
      setTimeout(() => startStream(ch, retryCount + 1), 5000);
    } else if (!streamState.intentionalStop) {
      console.error(`❌ ${ch} a échoué après 3 tentatives.`);
    }
  });

  active.set(ch, streamState);
  stats.totalStarted++;
  console.log(`▶️ ${ch} started`);
  broadcastLog(`▶️ ${ch} started`);
}

async function stopStream(ch) {
  const s = active.get(ch);
  if (!s) return false;
  
  // IMPORTANT: On marque l'arrêt comme intentionnel
  s.intentionalStop = true;
  
  s.proc.kill('SIGTERM');
  
  // Force kill si ça traine
  setTimeout(() => {
    if (s.proc && !s.proc.killed) s.proc.kill('SIGKILL');
  }, 5000);
  
  return true;
}

async function safeDeleteFolder(dir) {
  try {
    // Vérification asynchrone
    try {
        await fsp.access(dir);
    } catch {
        return; // Le dossier n'existe pas
    }
    await fsp.rm(dir, { recursive: true, force: true });
    console.log(`🗑️ Deleted folder: ${dir}`);
  } catch (e) {
    console.error(`❌ Failed to delete folder ${dir}:`, e.message);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [ch, s] of active) {
    if (now - s.lastAccess > INACTIVITY_LIMIT) {
      console.log(`💤 ${ch} inactif depuis trop longtemps → arrêt`);
      broadcastLog(`💤 ${ch} inactive`);
      stopStream(ch);
    }
  }
}, CLEANUP_INTERVAL);

setInterval(() => {
  history.push(collectSystemStats());
  if (history.length > 100) history.shift();
}, 5000);

app.get('/hls/:ch.m3u8', async (req, res) => {
  const ch = req.params.ch;
  if (!/^[\w-]+$/.test(ch)) return res.status(400).send('Invalid channel');
  const { playlist } = getPaths(ch);

  if (!active.has(ch)) {
    console.log(`⚡ Demande ${ch} → démarrage...`);
    try {
      startStream(ch);
    } catch (e) {
      console.error(e.message);
      stats.totalErrors++;
      return res.status(500).send(e.message);
    }
  } else {
    // Si le flux existe, on met à jour le lastAccess
    const s = active.get(ch);
    if (s) s.lastAccess = Date.now();
  }

  res.set('Cache-Control', 'no-cache');

  let waited = 0;
  let delay = 1000;
  let clientConnected = true;

  // Arrêter la boucle si le client se déconnecte
  req.on('close', () => {
    clientConnected = false;
  });

  while (waited < 15000 && clientConnected) {
    try {
      // Utilisation de stat asynchrone (non-bloquant)
      const st = await fsp.stat(playlist);
      if (st.size > 0) {
        stats.bandwidth += st.size;
        return res.sendFile(playlist);
      }
    } catch (e) {
      // Le fichier n'existe pas encore, on attend
    }

    await new Promise(r => setTimeout(r, delay));
    waited += delay;
    if (delay < 3000) delay += 500;
  }

  if (clientConnected) {
    return res.status(503).send('Flux pas encore prêt');
  }
});

app.listen(PORT, () => {
  console.log(`🚀 HLS server on http://localhost:${PORT}`);
});