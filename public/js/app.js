// ============================================
// Bot Hosting Panel - Frontend JavaScript
// ============================================

let socket = null;
let currentBot = null;
let consoleInterval = null;

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

function initializeApp() {
    // Check if we're on login page
    if (window.location.pathname === '/login') {
        initializeLogin();
        return;
    }

    // Initialize socket connection
    initializeSocket();

    // Load bots if on dashboard
    if (window.location.pathname === '/' || window.location.pathname === '') {
        loadBots();
        initializeUploadModal();
    }

    // Initialize file manager if on filemanager page
    if (window.location.pathname.startsWith('/filemanager')) {
        initializeFileManager();
    }

    // Update bots status periodically
    setInterval(() => {
        if (window.location.pathname === '/' || window.location.pathname === '') {
            loadBots();
        }
    }, 5000);
}

// ============================================
// Login Functions
// ============================================
function initializeLogin() {
    const form = document.getElementById('loginForm');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        const errorDiv = document.getElementById('errorMessage');
        const btnText = form.querySelector('.btn-text');
        const btnLoading = form.querySelector('.btn-loading');
        
        // Show loading state
        btnText.style.display = 'none';
        btnLoading.style.display = 'inline';
        errorDiv.textContent = '';

        try {
            const response = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });

            const data = await response.json();

            if (response.ok && data.success) {
                window.location.href = data.redirect || '/';
            } else {
                errorDiv.textContent = data.error || 'Login failed';
                btnText.style.display = 'inline';
                btnLoading.style.display = 'none';
            }
        } catch (error) {
            errorDiv.textContent = 'Network error. Please try again.';
            btnText.style.display = 'inline';
            btnLoading.style.display = 'none';
        }
    });
}

function logout() {
    fetch('/api/logout')
        .then(() => {
            window.location.href = '/login';
        })
        .catch(() => {
            window.location.href = '/login';
        });
}

// ============================================
// Socket.io
// ============================================
function initializeSocket() {
    socket = io();

    socket.on('connect', () => {
        console.log('Socket connected');
    });

    socket.on('botStatusChanged', (data) => {
        console.log('Bot status changed:', data);
        loadBots(); // Refresh bot list
    });

    socket.on('botDeleted', (data) => {
        console.log('Bot deleted:', data);
        loadBots(); // Refresh bot list
    });

    socket.on('logs-update', (data) => {
        if (data.botName === currentBot) {
            const consoleOutput = document.getElementById('consoleOutput');
            if (consoleOutput) {
                consoleOutput.textContent = data.logs || 'No logs available';
                consoleOutput.scrollTop = consoleOutput.scrollHeight;
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('Socket disconnected');
    });
}

// ============================================
// Bot Management
// ============================================
async function loadBots() {
    const container = document.getElementById('botsContainer');
    if (!container) return;

    try {
        const response = await fetch('/api/bots');
        const data = await response.json();

        if (!data.bots || data.bots.length === 0) {
            container.innerHTML = `
                <div class="loading" style="grid-column: 1/-1; text-align: center; padding: 60px;">
                    <h3>No bots found</h3>
                    <p style="margin-top: 8px; color: var(--text-muted);">Click "New Bot" to upload your first bot</p>
                </div>
            `;
            return;
        }

        container.innerHTML = data.bots.map(bot => createBotCard(bot)).join('');
    } catch (error) {
        container.innerHTML = '<div class="loading">Error loading bots</div>';
        console.error('Error loading bots:', error);
    }
}

function createBotCard(bot) {
    const isOnline = bot.status === 'online';
    const uptime = bot.uptime ? formatUptime(Date.now() - bot.uptime) : 'N/A';
    
    return `
        <div class="bot-card">
            <div class="bot-card-header">
                <div class="bot-name">${escapeHtml(bot.name)}</div>
                <span class="bot-type ${bot.type}">${bot.type}</span>
            </div>
            <div class="status-indicator">
                <span class="status-dot ${isOnline ? 'online' : 'offline'}"></span>
                <span>${isOnline ? 'Running' : 'Offline'}</span>
            </div>
            <div class="bot-stats">
                <div class="stat-item">
                    <div class="stat-label">CPU</div>
                    <div class="stat-value">${bot.cpu || '0'}%</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Memory</div>
                    <div class="stat-value">${bot.memory || '0'} MB</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Uptime</div>
                    <div class="stat-value">${uptime}</div>
                </div>
                <div class="stat-item">
                    <div class="stat-label">Restarts</div>
                    <div class="stat-value">${bot.restartCount || 0}</div>
                </div>
            </div>
            <div class="bot-actions">
                ${isOnline ? `
                    <button class="btn btn-small btn-danger" onclick="stopBot('${escapeHtml(bot.name)}')">Stop</button>
                    <button class="btn btn-small" onclick="restartBot('${escapeHtml(bot.name)}')">Restart</button>
                ` : `
                    <button class="btn btn-small btn-success" onclick="startBot('${escapeHtml(bot.name)}')">Start</button>
                `}
                <button class="btn btn-small" onclick="showConsole('${escapeHtml(bot.name)}')">Console</button>
                <button class="btn btn-small" onclick="viewFiles('${escapeHtml(bot.name)}')">Files</button>
                <button class="btn btn-small btn-danger" onclick="deleteBot('${escapeHtml(bot.name)}')">Delete</button>
            </div>
        </div>
    `;
}

async function startBot(name) {
    try {
        const response = await fetch(`/api/bots/${name}/start`, { method: 'POST' });
        const data = await response.json();
        
        if (response.ok) {
            loadBots();
        } else {
            alert('Error: ' + data.error);
        }
    } catch (error) {
        alert('Error starting bot');
    }
}

async function stopBot(name) {
    if (!confirm(`Are you sure you want to stop "${name}"?`)) return;
    
    try {
        const response = await fetch(`/api/bots/${name}/stop`, { method: 'POST' });
        const data = await response.json();
        
        if (response.ok) {
            loadBots();
        } else {
            alert('Error: ' + data.error);
        }
    } catch (error) {
        alert('Error stopping bot');
    }
}

async function restartBot(name) {
    try {
        const response = await fetch(`/api/bots/${name}/restart`, { method: 'POST' });
        const data = await response.json();
        
        if (response.ok) {
            loadBots();
        } else {
            alert('Error: ' + data.error);
        }
    } catch (error) {
        alert('Error restarting bot');
    }
}

async function deleteBot(name) {
    if (!confirm(`Are you sure you want to delete "${name}"? This cannot be undone!`)) return;
    
    try {
        const response = await fetch(`/api/bots/${name}`, { method: 'DELETE' });
        const data = await response.json();
        
        if (response.ok) {
            loadBots();
        } else {
            alert('Error: ' + data.error);
        }
    } catch (error) {
        alert('Error deleting bot');
    }
}

// ============================================
// Console Functions
// ============================================
function showConsole(botName) {
    currentBot = botName;
    
    const modal = document.getElementById('consoleModal');
    const title = document.getElementById('consoleTitle');
    
    if (!modal || !title) return;
    
    title.textContent = `Console - ${botName}`;
    modal.classList.add('active');
    
    // Subscribe to logs via socket
    if (socket) {
        socket.emit('subscribe-logs', botName);
    }
}

function closeConsoleModal() {
    const modal = document.getElementById('consoleModal');
    if (modal) {
        modal.classList.remove('active');
    }
    
    if (socket) {
        socket.emit('unsubscribe-logs');
    }
    
    currentBot = null;
}

function clearConsole() {
    const output = document.getElementById('consoleOutput');
    if (output) {
        output.textContent = '';
    }
}

// ============================================
// Upload Modal
// ============================================
function initializeUploadModal() {
    const form = document.getElementById('uploadForm');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const botName = document.getElementById('botName').value;
        const fileInput = document.getElementById('botFile');
        const file = fileInput.files[0];
        const progressDiv = document.getElementById('uploadProgress');
        
        if (!file) {
            alert('Please select a ZIP file');
            return;
        }
        
        if (!botName) {
            alert('Please enter a bot name');
            return;
        }
        
        // Show progress
        progressDiv.style.display = 'block';
        
        const formData = new FormData();
        formData.append('name', botName);
        formData.append('bot', file);
        
        try {
            const response = await fetch('/api/bots/upload', {
                method: 'POST',
                body: formData
            });
            
            const data = await response.json();
            
            if (response.ok) {
                closeUploadModal();
                loadBots();
                alert('Bot uploaded successfully!');
            } else {
                alert('Error: ' + data.error);
            }
        } catch (error) {
            alert('Error uploading bot');
        } finally {
            progressDiv.style.display = 'none';
        }
    });

    // Drag and drop
    const dropZone = document.getElementById('dropZone');
    if (dropZone) {
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--accent-primary)';
        });
        
        dropZone.addEventListener('dragleave', () => {
            dropZone.style.borderColor = 'var(--border-color)';
        });
        
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.style.borderColor = 'var(--border-color)';
            
            const files = e.dataTransfer.files;
            if (files.length > 0) {
                document.getElementById('botFile').files = files;
            }
        });
    }
}

function showUploadModal() {
    const modal = document.getElementById('uploadModal');
    if (modal) {
        modal.classList.add('active');
        document.getElementById('uploadForm').reset();
        document.getElementById('uploadProgress').style.display = 'none';
    }
}

function closeUploadModal() {
    const modal = document.getElementById('uploadModal');
    if (modal) {
        modal.classList.remove('active');
    }
}

// ============================================
// File Manager
// ============================================
function initializeFileManager() {
    loadBotList();
}

async function loadBotList() {
    const botList = document.getElementById('botList');
    if (!botList) return;

    try {
        const response = await fetch('/api/bots');
        const data = await response.json();
        
        if (data.bots && data.bots.length > 0) {
            botList.innerHTML = data.bots.map(bot => 
                `<li onclick="selectBot('${escapeHtml(bot.name)}')" data-bot="${escapeHtml(bot.name)}">${escapeHtml(bot.name)}</li>`
            ).join('');
        } else {
            botList.innerHTML = '<li>No bots found</li>';
        }
    } catch (error) {
        botList.innerHTML = '<li>Error loading bots</li>';
    }
}

function viewFiles(botName) {
    window.location.href = `/filemanager?bot=${botName}`;
}

function selectBot(botName) {
    // Highlight selected bot
    document.querySelectorAll('.bot-file-list li').forEach(li => li.classList.remove('active'));
    const selectedLi = document.querySelector(`.bot-file-list li[data-bot="${botName}"]`);
    if (selectedLi) selectedLi.classList.add('active');
    
    loadFiles(botName, '');
}

async function loadFiles(botName, dirPath = '') {
    const fileList = document.getElementById('fileList');
    const breadcrumb = document.getElementById('breadcrumb');
    
    if (!fileList) return;
    
    try {
        const url = dirPath 
            ? `/api/bots/${botName}/files/read?path=${encodeURIComponent(dirPath)}`
            : `/api/bots/${botName}/files`;
        
        const response = await fetch(url);
        const data = await response.json();
        
        if (data.files) {
            // Update breadcrumb
            if (breadcrumb) {
                const parts = dirPath ? dirPath.split('/') : [];
                breadcrumb.innerHTML = `<span onclick="loadFiles('${botName}', '')" style="cursor:pointer; color: var(--accent-secondary);">/</span>` +
                    parts.map((part, i) => {
                        const path = parts.slice(0, i + 1).join('/');
                        return `<span onclick="loadFiles('${botName}', '${path}')" style="cursor:pointer; color: var(--accent-secondary);">${part}/</span>`;
                    }).join('');
            }
            
            fileList.innerHTML = data.files.map(file => createFileItem(botName, file, dirPath)).join('');
            
            if (data.files.length === 0) {
                fileList.innerHTML = '<p style="padding: 20px; color: var(--text-muted);">Empty directory</p>';
            }
        }
    } catch (error) {
        fileList.innerHTML = '<p style="padding: 20px; color: var(--danger);">Error loading files</p>';
    }
}

function createFileItem(botName, file, currentPath) {
    const icon = file.type === 'directory' ? '📁' : '📄';
    const size = file.type === 'directory' ? '' : formatFileSize(file.size);
    const fullPath = currentPath ? `${currentPath}/${file.name}` : file.name;
    
    return `
        <div class="file-item" onclick="${file.type === 'directory' ? `loadFiles('${botName}', '${fullPath}')` : `openFile('${botName}', '${fullPath}')`}">
            <div class="file-item-icon">${icon}</div>
            <div class="file-item-info">
                <div class="file-item-name">${escapeHtml(file.name)}</div>
                <div class="file-item-meta">${size} • ${new Date(file.modifiedAt).toLocaleString()}</div>
            </div>
        </div>
    `;
}

async function openFile(botName, filePath) {
    try {
        const response = await fetch(`/api/bots/${botName}/files/read?path=${encodeURIComponent(filePath)}`);
        const data = await response.json();
        
        if (data.content) {
            // For simplicity, show in an alert - in production you'd use a proper editor
            const editorContent = data.content.substring(0, 5000);
            const newContent = prompt(`Editing: ${filePath}`, editorContent);
            
            if (newContent !== null && newContent !== editorContent) {
                await saveFile(botName, filePath, newContent);
            }
        }
    } catch (error) {
        alert('Error opening file');
    }
}

async function saveFile(botName, filePath, content) {
    try {
        const response = await fetch(`/api/bots/${botName}/files/save`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: filePath, content })
        });
        
        const data = await response.json();
        if (data.success) {
            alert('File saved successfully');
        } else {
            alert('Error saving file');
        }
    } catch (error) {
        alert('Error saving file');
    }
}

function uploadFile() {
    document.getElementById('fileUploadInput').click();
}

function createDirectory() {
    const dirName = prompt('Enter directory name:');
    if (dirName && currentBot) {
        // Implementation for creating directory
        fetch(`/api/bots/${currentBot}/files/mkdir`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: dirName, path: '' })
        }).then(() => loadFiles(currentBot));
    }
}

// ============================================
// Utility Functions
// ============================================
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatUptime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Close modals on escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeUploadModal();
        closeConsoleModal();
    }
});

// Close modals on outside click
document.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal')) {
        closeUploadModal();
        closeConsoleModal();
    }
});
