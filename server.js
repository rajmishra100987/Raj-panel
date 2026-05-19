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

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/views', express.static(path.join(__dirname, 'views')));
app.use(session({
  secret: 'personal-bot-panel-secret-key-2024',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Simple auth middleware
const authMiddleware = (req, res, next) => {
  if (req.session && req.session.authenticated) {
    return next();
  }
  // If API request, send JSON error
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Otherwise redirect to login
  res.redirect('/login');
};

// Default admin credentials (change these in production)
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = bcrypt.hashSync('admin123', 10);

// Login page route
app.get('/login', (req, res) => {
  if (req.session.authenticated) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Login API
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  
  if (username === ADMIN_USERNAME && bcrypt.compareSync(password, ADMIN_PASSWORD)) {
    req.session.authenticated = true;
    return res.json({ success: true, redirect: '/' });
  }
  
  res.status(401).json({ error: 'Invalid credentials' });
});

// Logout
app.get('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Protect all other routes
app.get('/', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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

// Multer configuration for file uploads
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
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/zip' || 
        file.mimetype === 'application/x-zip-compressed' ||
        file.originalname.endsWith('.zip')) {
      cb(null, true);
    } else {
      cb(new Error('Only ZIP files are allowed'));
    }
  }
});

// API Routes

// Get all bots
app.get('/api/bots', authMiddleware, async (req, res) => {
  try {
    const botsDir = path.join(__dirname, 'bots');
    fs.ensureDirSync(botsDir);
    
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
        
        // Get PM2 process info
        const processName = `bot-${folder}`;
        let status = 'offline';
        let pid = null;
        
        try {
          const processInfo = await new Promise((resolve, reject) => {
            pm2.describe(processName, (err, desc) => {
              if (err) return reject(err);
              resolve(desc);
            });
          });
          
          if (processInfo && processInfo.length > 0) {
            status = processInfo[0].pm2_env.status === 'online' ? 'online' : 'offline';
            pid = processInfo[0].pid;
          }
        } catch (err) {
          // Process doesn't exist, keep offline status
        }
        
        let cpuUsage = 0;
        let memoryUsage = 0;
        
        if (pid) {
          try {
            const stats = await pidusage(pid);
            cpuUsage = stats.cpu.toFixed(2);
            memoryUsage = (stats.memory / 1024 / 1024).toFixed(2); // MB
          } catch (err) {
            // Process may have ended
          }
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
    
    // Validate bot name
    if (!/^[a-zA-Z0-9_-]+$/.test(botName)) {
      await fs.remove(zipPath);
      return res.status(400).json({ error: 'Invalid bot name. Use only letters, numbers, hyphens, and underscores.' });
    }
    
    const botDir = path.join(__dirname, 'bots', botName);
    
    // Check if bot already exists
    if (await fs.pathExists(botDir)) {
      await fs.remove(zipPath);
      return res.status(400).json({ error: 'Bot with this name already exists' });
    }
    
    // Extract ZIP
    await fs.ensureDir(botDir);
    
    await new Promise((resolve, reject) => {
      fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: botDir }))
        .on('close', resolve)
        .on('error', reject);
    });
    
    // Clean up uploaded zip
    await fs.remove(zipPath);
    
    // Detect bot type
    const files = await fs.readdir(botDir);
    let botType = 'unknown';
    let mainFile = null;
    
    // Check for Node.js project
    if (files.includes('package.json')) {
      botType = 'nodejs';
      const packageJson = await fs.readJson(path.join(botDir, 'package.json'));
      mainFile = packageJson.main || 'index.js';
      
      // Install npm dependencies
      const { exec } = require('child_process');
      exec('npm install', { cwd: botDir }, (err, stdout, stderr) => {
        if (err) {
          console.error(`npm install error for ${botName}:`, stderr);
        }
      });
    }
    // Check for Python project
    else if (files.includes('requirements.txt') || files.includes('main.py')) {
      botType = 'python';
      mainFile = files.includes('main.py') ? 'main.py' : files.find(f => f.endsWith('.py'));
      
      // Install pip dependencies
      if (files.includes('requirements.txt')) {
        const { exec } = require('child_process');
        exec('pip install -r requirements.txt', { cwd: botDir }, (err, stdout, stderr) => {
          if (err) {
            console.error(`pip install error for ${botName}:`, stderr);
          }
        });
      }
    }
    // Detect main file
    else {
      mainFile = files.find(f => f.endsWith('.js') || f.endsWith('.py'));
      if (mainFile && mainFile.endsWith('.js')) {
        botType = 'nodejs';
      } else if (mainFile && mainFile.endsWith('.py')) {
        botType = 'python';
      }
    }
    
    // Save bot configuration
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
    
    const configPath = path.join(botDir, 'bot-config.json');
    if (!await fs.pathExists(configPath)) {
      return res.status(400).json({ error: 'Bot configuration not found' });
    }
    
    const config = await fs.readJson(configPath);
    const processName = `bot-${botName}`;
    
    // Build PM2 start command
    let script = '';
    let interpreter = '';
    let args = [];
    
    if (config.type === 'nodejs') {
      script = path.join(botDir, config.mainFile || 'index.js');
      interpreter = 'node';
    } else if (config.type === 'python') {
      script = path.join(botDir, config.mainFile || 'main.py');
      interpreter = 'python3';
    }
    
    // Connect to PM2 and start the process
    await new Promise((resolve, reject) => {
      pm2.connect((err) => {
        if (err) return reject(err);
        
        pm2.start({
          name: processName,
          script: script,
          interpreter: interpreter,
          args: args,
          cwd: botDir,
          autorestart: true,
          max_restarts: 10,
          watch: false,
          env: {
            NODE_ENV: 'production',
            BOT_NAME: botName
          }
        }, (err, apps) => {
          if (err) {
            pm2.disconnect();
            return reject(err);
          }
          
          // Save PM2 process list
          pm2.save((err) => {
            pm2.disconnect();
            if (err) return reject(err);
            resolve(apps);
          });
        });
      });
    });
    
    // Notify via socket
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
    
    // Stop and delete from PM2 first
    await new Promise((resolve, reject) => {
      pm2.connect((err) => {
        if (err) return reject(err);
        
        pm2.delete(processName, (err) => {
          if (err && !err.message.includes('not found')) {
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
    
    // Remove bot directory
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
    const botName = req.params.name;
    const processName = `bot-${botName}`;
    
    const logs = await new Promise((resolve, reject) => {
      pm2.connect((err) => {
        if (err) return reject(err);
        
        pm2.describe(processName, (err, desc) => {
          if (err) {
            pm2.disconnect();
            return reject(err);
          }
          
          if (!desc || desc.length === 0) {
            pm2.disconnect();
            return resolve('');
          }
          
          const logPath = desc[0].pm2_env.pm_out_log_path;
          pm2.disconnect();
          
          if (logPath && fs.existsSync(logPath)) {
            const logContent = fs.readFileSync(logPath, 'utf8');
            // Return last 1000 lines
            const lines = logContent.split('\n');
            const recentLines = lines.slice(-1000);
            resolve(recentLines.join('\n'));
          } else {
            resolve('');
          }
        });
      });
    });
    
    res.json({ logs: logs || '' });
  } catch (error) {
    // If PM2 process doesn't exist, try reading from a potential log file
    try {
      const logPath = path.join(process.env.HOME || '/tmp', '.pm2', 'logs', `bot-${req.params.name}-out.log`);
      if (await fs.pathExists(logPath)) {
        const content = await fs.readFile(logPath, 'utf8');
        return res.json({ logs: content });
      }
    } catch (err) {
      // Ignore
    }
    res.json({ logs: '' });
  }
});

// Get file list for a bot
app.get('/api/bots/:name/files', authMiddleware, async (req, res) => {
  try {
    const botName = req.params.name;
    const botDir = path.join(__dirname, 'bots', botName);
    
    if (!await fs.pathExists(botDir)) {
      return res.status(404).json({ error: 'Bot not found' });
    }
    
    const files = await listFiles(botDir, botDir);
    res.json({ files });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Read file content
app.get('/api/bots/:name/files/read', authMiddleware, async (req, res) => {
  try {
    const botName = req.params.name;
    const filePath = req.query.path;
    
    if (!filePath) {
      return res.status(400).json({ error: 'File path required' });
    }
    
    // Prevent path traversal
    const botDir = path.join(__dirname, 'bots', botName);
    const fullPath = path.join(botDir, filePath);
    
    if (!fullPath.startsWith(botDir)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    if (!await fs.pathExists(fullPath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      const files = await listFiles(fullPath, botDir);
      return res.json({ type: 'directory', files });
    }
    
    const content = await fs.readFile(fullPath, 'utf8');
    res.json({ type: 'file', content, size: stat.size });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Save file content
app.post('/api/bots/:name/files/save', authMiddleware, async (req, res) => {
  try {
    const botName = req.params.name;
    const { path: filePath, content } = req.body;
    
    if (!filePath) {
      return res.status(400).json({ error: 'File path required' });
    }
    
    const botDir = path.join(__dirname, 'bots', botName);
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

// Delete file
app.delete('/api/bots/:name/files/delete', authMiddleware, async (req, res) => {
  try {
    const botName = req.params.name;
    const filePath = req.query.path;
    
    if (!filePath) {
      return res.status(400).json({ error: 'File path required' });
    }
    
    const botDir = path.join(__dirname, 'bots', botName);
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

// Create directory
app.post('/api/bots/:name/files/mkdir', authMiddleware, async (req, res) => {
  try {
    const botName = req.params.name;
    const { path: dirPath, name } = req.body;
    
    const botDir = path.join(__dirname, 'bots', botName);
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

// Upload file to bot
app.post('/api/bots/:name/files/upload', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const botName = req.params.name;
    const uploadPath = req.body.path || '';
    
    const botDir = path.join(__dirname, 'bots', botName);
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

// Get system info
app.get('/api/system/info', authMiddleware, async (req, res) => {
  try {
    const os = require('os');
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    
    res.json({
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      totalMemory: (totalMem / 1024 / 1024 / 1024).toFixed(2),
      usedMemory: (usedMem / 1024 / 1024 / 1024).toFixed(2),
      freeMemory: (freeMem / 1024 / 1024 / 1024).toFixed(2),
      uptime: os.uptime(),
      nodeVersion: process.version
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper function to list files recursively
async function listFiles(dir, baseDir) {
  const files = await fs.readdir(dir);
  const fileList = [];
  
  for (const file of files) {
    if (file === 'node_modules' || file === '__pycache__' || file.startsWith('.')) {
      continue;
    }
    
    const fullPath = path.join(dir, file);
    const relativePath = path.relative(baseDir, fullPath);
    const stat = await fs.stat(fullPath);
    
    fileList.push({
      name: file,
      path: relativePath,
      type: stat.isDirectory() ? 'directory' : 'file',
      size: stat.size,
      modifiedAt: stat.mtime
    });
  }
  
  return fileList;
}

// Socket.io connection for realtime logs
io.on('connection', (socket) => {
  console.log('Client connected');
  
  socket.on('subscribe-logs', async (botName) => {
    const processName = `bot-${botName}`;
    
    // Send initial logs
    try {
      const logs = await new Promise((resolve) => {
        pm2.connect((err) => {
          if (err) {
            resolve('');
            return;
          }
          
          pm2.describe(processName, (err, desc) => {
            pm2.disconnect();
            if (err || !desc || desc.length === 0) {
              resolve('');
              return;
            }
            
            const logPath = desc[0].pm2_env.pm_out_log_path;
            if (logPath && fs.existsSync(logPath)) {
              const content = fs.readFileSync(logPath, 'utf8');
              const lines = content.split('\n').slice(-100);
              resolve(lines.join('\n'));
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
    
    // Set up log watching
    const watcher = setInterval(async () => {
      try {
        const logs = await new Promise((resolve) => {
          pm2.connect((err) => {
            if (err) {
              resolve('');
              return;
            }
            
            pm2.describe(processName, (err, desc) => {
              pm2.disconnect();
              if (err || !desc || desc.length === 0) {
                resolve('');
                return;
              }
              
              const logPath = desc[0].pm2_env.pm_out_log_path;
              if (logPath && fs.existsSync(logPath)) {
                const content = fs.readFileSync(logPath, 'utf8');
                resolve(content);
              } else {
                resolve('');
              }
            });
          });
        });
        
        socket.emit('logs-update', { botName, logs });
      } catch (err) {
        console.error('Error watching logs:', err);
      }
    }, 2000);
    
    socket.on('disconnect', () => {
      clearInterval(watcher);
    });
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Initialize PM2 and restore saved processes
async function initializePM2() {
  return new Promise((resolve, reject) => {
    pm2.connect((err) => {
      if (err) {
        console.error('Error connecting to PM2:', err);
        return reject(err);
      }
      
      // Try to resurrect previously saved processes
      pm2.resurrect((err) => {
        if (err) {
          console.log('No previous processes to restore or error restoring:', err.message);
        } else {
          console.log('Restored previously saved processes');
        }
        
        pm2.save((err) => {
          if (err) {
            console.error('Error saving PM2 process list:', err);
          }
          pm2.disconnect();
          resolve();
        });
      });
    });
  });
}

// Start server
async function startServer() {
  try {
    await initializePM2();
    
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`Bot Hosting Panel running on port ${PORT}`);
      console.log(`Open http://localhost:${PORT} in your browser`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
