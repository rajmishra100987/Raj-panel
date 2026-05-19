const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const unzipper = require('unzipper');
const pm2 = require('pm2');
const { Server } = require('socket.io');
const http = require('http');
const bcrypt = require('bcryptjs');
const pidusage = require('pidusage');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json({ limit: '100mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/views', express.static(path.join(__dirname, 'views')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'railway-bot-panel-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// Auth middleware
const authMiddleware = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.path === '/health' || req.path === '/') {
    return next();
  }
  res.redirect('/login');
};

// Admin credentials
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD_HASH = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    port: PORT,
    uptime: process.uptime(),
    platform: 'railway'
  });
});

// Routes
app.get('/', (req, res) => {
  if (req.session.authenticated) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
});

app.get('/login', (req, res) => {
  if (req.session.authenticated) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  if (username === ADMIN_USERNAME && bcrypt.compareSync(password, ADMIN_PASSWORD_HASH)) {
    req.session.authenticated = true;
    return res.json({ success: true, redirect: '/' });
  }
  
  res.status(401).json({ error: 'Invalid credentials' });
});

app.get('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/dashboard', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

app.get('/filemanager', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'filemanager.html'));
});

app.get('/filemanager/:botName', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'filemanager.html'));
});

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    fs.ensureDirSync(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/zip' || file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed'));
    }
  }
});

// ============= API ROUTES =============

// Get all bots
app.get('/api/bots', authMiddleware, async (req, res) => {
  try {
    const botsDir = path.join(__dirname, 'bots');
    await fs.ensureDir(botsDir);
    
    const botFolders = await fs.readdir(botsDir);
    const bots = [];
    
    for (const folder of botFolders) {
      const botPath = path.join(botsDir, folder);
      const stat = await fs.stat(botPath);
      
      if (stat.isDirectory()) {
        const configPath = path.join(botPath, 'bot-config.json');
        let config = {};
        if (await fs.pathExists(configPath)) {
          config = await fs.readJson(configPath);
        }
        
        const processName = `bot-${folder}`;
        let status = 'offline';
        let pid = null;
        
        try {
          const processInfo = await new Promise((resolve, reject) => {
            pm2.connect((err) => {
              if (err) return reject(err);
              pm2.describe(processName, (err, desc) => {
                pm2.disconnect();
                if (err) return reject(err);
                resolve(desc);
              });
            });
          });
          
          if (processInfo && processInfo.length > 0) {
            status = processInfo[0].pm2_env.status === 'online' ? 'online' : 'offline';
            pid = processInfo[0].pid;
          }
        } catch (err) {
          // Process doesn't exist
        }
        
        let cpuUsage = 0, memoryUsage = 0;
        if (pid) {
          try {
            const stats = await pidusage(pid);
            cpuUsage = parseFloat(stats.cpu).toFixed(2);
            memoryUsage = parseFloat(stats.memory / 1024 / 1024).toFixed(2);
          } catch (err) {}
        }
        
        bots.push({
          name: folder,
          type: config.type || 'unknown',
          mainFile: config.mainFile || 'unknown',
          status: status,
          pid: pid,
          cpu: cpuUsage,
          memory: memoryUsage,
          uptime: processInfo && processInfo.length > 0 ? processInfo[0].pm2_env.pm_uptime : null,
          restartCount: processInfo && processInfo.length > 0 ? processInfo[0].pm2_env.restart_time : 0,
          createdAt: stat.birthtime
        });
      }
    }
    
    res.json({ bots });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Upload bot
app.post('/api/bots/upload', authMiddleware, upload.single('bot'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const zipPath = req.file.path;
    const botName = req.body.name || path.basename(req.file.originalname, '.zip');
    
    if (!/^[a-zA-Z0-9_-]+$/.test(botName)) {
      await fs.remove(zipPath);
      return res.status(400).json({ error: 'Invalid bot name. Use only letters, numbers, hyphens, and underscores.' });
    }
    
    const botDir = path.join(__dirname, 'bots', botName);
    
    if (await fs.pathExists(botDir)) {
      await fs.remove(zipPath);
      return res.status(400).json({ error: 'Bot with this name already exists' });
    }
    
    await fs.ensureDir(botDir);
    
    await new Promise((resolve, reject) => {
      fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: botDir }))
        .on('close', resolve)
        .on('error', reject);
    });
    
    await fs.remove(zipPath);
    
    const files = await fs.readdir(botDir);
    let botType = 'unknown';
    let mainFile = null;
    
    if (files.includes('package.json')) {
      botType = 'nodejs';
      const packageJson = await fs.readJson(path.join(botDir, 'package.json'));
      mainFile = packageJson.main || 'index.js';
      
      // Install dependencies
      const { exec } = require('child_process');
      exec('npm install --production', { cwd: botDir }, (err, stdout, stderr) => {
        if (err) console.error(`npm install error for ${botName}:`, stderr);
        else console.log(`npm install completed for ${botName}`);
      });
    }
    else if (files.includes('requirements.txt') || files.includes('main.py')) {
      botType = 'python';
      mainFile = files.includes('main.py') ? 'main.py' : files.find(f => f.endsWith('.py'));
      
      const { exec } = require('child_process');
      exec('pip install -r requirements.txt', { cwd: botDir }, (err, stdout, stderr) => {
        if (err) console.error(`pip install error for ${botName}:`, stderr);
        else console.log(`pip install completed for ${botName}`);
      });
    }
    else {
      mainFile = files.find(f => f.endsWith('.js') || f.endsWith('.py'));
      if (mainFile && mainFile.endsWith('.js')) botType = 'nodejs';
      else if (mainFile && mainFile.endsWith('.py')) botType = 'python';
    }
    
    const config = {
      name: botName,
      type: botType,
      mainFile: mainFile,
      createdAt: new Date().toISOString()
    };
    
    await fs.writeJson(path.join(botDir, 'bot-config.json'), config);
    res.json({ success: true, bot: { name: botName, type: botType, mainFile: mainFile } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start bot
app.post('/api/bots/:name/start', authMiddleware, async (req, res) => {
  try {
    const botName = req.params.name;
    const botDir = path.join(__dirname, 'bots', botName);
    
    if (!await fs.pathExists(botDir)) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    const config = await fs.readJson(path.join(botDir, 'bot-config.json'));
    const processName = `bot-${botName}`;
    
    let script = '', interpreter = '';
    if (config.type === 'nodejs') {
      script = path.join(botDir, config.mainFile || 'index.js');
      interpreter = 'node';
    } else if (config.type === 'python') {
      script = path.join(botDir, config.mainFile || 'main.py');
      interpreter = 'python3';
    } else {
      return res.status(400).json({ error: 'Unsupported bot type' });
    }
    
    await new Promise((resolve, reject) => {
      pm2.connect((err) => {
        if (err) return reject(err);
        
        pm2.start({
          name: processName,
          script: script,
          interpreter: interpreter,
          cwd: botDir,
          autorestart: true,
          max_restarts: 10,
          watch: false,
          env: {
            NODE_ENV: 'production',
            BOT_NAME: botName
          }
        }, (err) => {
          if (err) {
            pm2.disconnect();
            return reject(err);
          }
          pm2.save((err) => {
            pm2.disconnect();
            if (err) return reject(err);
            resolve();
          });
        });
      });
    });
    
    io.emit('botStatusChanged', { name: botName, status: 'online' });
    res.json({ success: true, message: 'Bot started successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Stop bot
app.post('/api/bots/:name/stop', authMiddleware, async (req, res) => {
  try {
    const botName = req.params.name;
    const processName = `bot-${botName}`;
    
    await new Promise((resolve, reject) => {
      pm2.connect((err) => {
        if (err) return reject(err);
        pm2.stop(processName, (err) => {
          if (err) {
            pm2.disconnect();
            return reject(err);
          }
          pm2.save((err) => {
            pm2.disconnect();
            if (err) return reject(err);
            resolve();
          });
        });
      });
    });
    
    io.emit('botStatusChanged', { name: botName, status: 'offline' });
    res.json({ success: true, message: 'Bot stopped successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Restart bot
app.post('/api/bots/:name/restart', authMiddleware, async (req, res) => {
  try {
    const botName = req.params.name;
    const processName = `bot-${botName}`;
    
    await new Promise((resolve, reject) => {
      pm2.connect((err) => {
        if (err) return reject(err);
        pm2.restart(processName, (err) => {
          if (err) {
            pm2.disconnect();
            return reject(err);
          }
          pm2.save((err) => {
            pm2.disconnect();
            if (err) return reject(err);
            resolve();
          });
        });
      });
    });
    
    io.emit('botStatusChanged', { name: botName, status: 'online' });
    res.json({ success: true, message: 'Bot restarted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete bot
app.delete('/api/bots/:name', authMiddleware, async (req, res) => {
  try {
    const botName = req.params.name;
    const botDir = path.join(__dirname, 'bots', botName);
    const processName = `bot-${botName}`;
    
    await new Promise((resolve) => {
      pm2.connect((err) => {
        if (err) return resolve();
        pm2.delete(processName, (err) => {
          pm2.save((err) => {
            pm2.disconnect();
            resolve();
          });
        });
      });
    });
    
    await fs.remove(botDir);
    io.emit('botDeleted', { name: botName });
    res.json({ success: true, message: 'Bot deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get bot logs
app.get('/api/bots/:name/logs', authMiddleware, async (req, res) => {
  try {
    const processName = `bot-${req.params.name}`;
    
    const logs = await new Promise((resolve) => {
      pm2.connect((err) => {
        if (err) return resolve('');
        pm2.describe(processName, (err, desc) => {
          pm2.disconnect();
          if (err || !desc || desc.length === 0) return resolve('');
          
          const logPath = desc[0].pm2_env.pm_out_log_path;
          if (logPath && fs.existsSync(logPath)) {
            const content = fs.readFileSync(logPath, 'utf8');
            resolve(content.split('\n').slice(-1000).join('\n'));
          } else {
            resolve('');
          }
        });
      });
    });
    
    res.json({ logs: logs || '' });
  } catch (error) {
    res.json({ logs: '' });
  }
});

// File management routes
app.get('/api/bots/:name/files', authMiddleware, async (req, res) => {
  try {
    const botDir = path.join(__dirname, 'bots', req.params.name);
    if (!await fs.pathExists(botDir)) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    async function listFiles(dir, baseDir) {
      const items = await fs.readdir(dir);
      const result = [];
      for (const item of items) {
        if (item === 'node_modules' || item === '__pycache__' || item.startsWith('.')) {
          continue;
        }
        const fullPath = path.join(dir, item);
        const stat = await fs.stat(fullPath);
        result.push({
          name: item,
          path: path.relative(baseDir, fullPath),
          type: stat.isDirectory() ? 'directory' : 'file',
          size: stat.size,
          modifiedAt: stat.mtime
        });
      }
      return result;
    }
    
    const files = await listFiles(botDir, botDir);
    res.json({ files });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/bots/:name/files/read', authMiddleware, async (req, res) => {
  try {
    const botDir = path.join(__dirname, 'bots', req.params.name);
    const filePath = req.query.path;
    
    if (!filePath) {
      return res.status(400).json({ error: 'File path required' });
    }
    
    const fullPath = path.join(botDir, filePath);
    
    if (!fullPath.startsWith(botDir)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    if (!await fs.pathExists(fullPath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      async function listFiles(dir, baseDir) {
        const items = await fs.readdir(dir);
        const result = [];
        for (const item of items) {
          if (item === 'node_modules' || item === '__pycache__') continue;
          const full = path.join(dir, item);
          const s = await fs.stat(full);
          result.push({
            name: item,
            path: path.relative(baseDir, full),
            type: s.isDirectory() ? 'directory' : 'file',
            size: s.size,
            modifiedAt: s.mtime
          });
        }
        return result;
      }
      const files = await listFiles(fullPath, botDir);
      return res.json({ type: 'directory', files });
    }
    
    const content = await fs.readFile(fullPath, 'utf8');
    res.json({ type: 'file', content, size: stat.size });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bots/:name/files/save', authMiddleware, async (req, res) => {
  try {
    const botDir = path.join(__dirname, 'bots', req.params.name);
    const { path: filePath, content } = req.body;
    
    if (!filePath) {
      return res.status(400).json({ error: 'File path required' });
    }
    
    const fullPath = path.join(botDir, filePath);
    
    if (!fullPath.startsWith(botDir)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    await fs.writeFile(fullPath, content);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/bots/:name/files/delete', authMiddleware, async (req, res) => {
  try {
    const botDir = path.join(__dirname, 'bots', req.params.name);
    const filePath = req.query.path;
    
    if (!filePath) {
      return res.status(400).json({ error: 'File path required' });
    }
    
    const fullPath = path.join(botDir, filePath);
    
    if (!fullPath.startsWith(botDir)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    await fs.remove(fullPath);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bots/:name/files/mkdir', authMiddleware, async (req, res) => {
  try {
    const botDir = path.join(__dirname, 'bots', req.params.name);
    const { path: dirPath, name } = req.body;
    
    const fullPath = path.join(botDir, dirPath || '', name);
    
    if (!fullPath.startsWith(botDir)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    await fs.ensureDir(fullPath);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/bots/:name/files/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const botDir = path.join(__dirname, 'bots', req.params.name);
    const uploadPath = req.body.path || '';
    const destDir = path.join(botDir, uploadPath);
    const destPath = path.join(destDir, req.file.originalname);
    
    if (!destPath.startsWith(botDir)) {
      await fs.remove(req.file.path);
      return res.status(403).json({ error: 'Access denied' });
    }
    
    await fs.ensureDir(destDir);
    await fs.move(req.file.path, destPath, { overwrite: true });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// System info
app.get('/api/system/info', authMiddleware, (req, res) => {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  
  res.json({
    platform: os.platform(),
    arch: os.arch(),
    cpus: os.cpus().length,
    totalMemory: (totalMem / 1024 / 1024 / 1024).toFixed(2),
    usedMemory: ((totalMem - freeMem) / 1024 / 1024 / 1024).toFixed(2),
    freeMemory: (freeMem / 1024 / 1024 / 1024).toFixed(2),
    uptime: os.uptime(),
    nodeVersion: process.version
  });
});

// Socket.io
io.on('connection', (socket) => {
  console.log('Client connected');
  
  socket.on('subscribe-logs', async (botName) => {
    const processName = `bot-${botName}`;
    
    const sendLogs = async () => {
      try {
        const logs = await new Promise((resolve) => {
          pm2.connect((err) => {
            if (err) return resolve('');
            pm2.describe(processName, (err, desc) => {
              pm2.disconnect();
              if (err || !desc || desc.length === 0) return resolve('');
              
              const logPath = desc[0].pm2_env.pm_out_log_path;
              if (logPath && fs.existsSync(logPath)) {
                const content = fs.readFileSync(logPath, 'utf8');
                resolve(content.split('\n').slice(-100).join('\n'));
              } else {
                resolve('');
              }
            });
          });
        });
        
        socket.emit('logs-update', { botName, logs });
      } catch (err) {
        console.error('Error fetching logs:', err);
      }
    };
    
    await sendLogs();
    const interval = setInterval(sendLogs, 3000);
    socket.on('disconnect', () => clearInterval(interval));
  });
});

// Initialize and start
async function startServer() {
  try {
    // Create necessary directories
    await fs.ensureDir(path.join(__dirname, 'bots'));
    await fs.ensureDir(path.join(__dirname, 'uploads'));
    
    // Initialize PM2
    await new Promise((resolve) => {
      pm2.connect((err) => {
        if (err) {
          console.log('PM2 connection warning:', err.message);
          return resolve();
        }
        console.log('PM2 connected successfully');
        
        pm2.resurrect((err) => {
          if (err) console.log('No previous processes to restore');
          else console.log('Restored previous processes');
          
          pm2.save((err) => {
            if (err) console.log('Error saving PM2 list');
            pm2.disconnect();
            resolve();
          });
        });
      });
    });
    
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`\n🚀 Bot Hosting Panel Started on Railway!`);
      console.log(`📡 Port: ${PORT}`);
      console.log(`🌐 URL: http://localhost:${PORT}`);
      console.log(`💚 Health: http://localhost:${PORT}/health`);
      console.log(`🔐 Login: ${ADMIN_USERNAME} / ${process.env.ADMIN_PASSWORD || 'admin123'}\n`);
    });
    
  } catch (error) {
    console.error('Failed to start server:', error);
  }
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  server.close(() => process.exit(0));
});

startServer();
