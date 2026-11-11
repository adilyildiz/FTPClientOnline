const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ftp = require('basic-ftp');
const path = require('path');
const stream = require('stream');
const crypto = require('crypto');
const mime = require('mime-types');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer in-memory storage for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB per file
});

// In-memory FTP connection pool
// sessionId -> { client, config, currentDir, lastActive, logs }
const sessions = new Map();

// Periodic cleanup of stale sessions (inactive > 15 mins)
setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.lastActive > 15 * 60 * 1000) {
      try {
        session.client.close();
      } catch (err) {
        // ignore close error on cleanup
      }
      sessions.delete(id);
    }
  }
}, 60 * 1000);

function addLog(session, type, message) {
  if (!session) return;
  const timestamp = new Date().toLocaleTimeString();
  session.logs.push({ timestamp, type, message });
  if (session.logs.length > 200) {
    session.logs.shift();
  }
}

// Get or re-establish FTP client connection
async function getFtpClient(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('Oturum bulunamadı veya süresi doldu. Lütfen yeniden bağlanın.');
  }

  session.lastActive = Date.now();

  // If client is closed or socket destroyed, reconnect
  if (session.client.closed) {
    addLog(session, 'info', 'Bağlantı koptu, yeniden bağlanılıyor...');
    const client = new ftp.Client(30000);
    client.ftp.verbose = false;

    // Attach custom logger to basic-ftp internal events
    client.trackProgress(info => {
      // track progress if needed
    });

    await client.access({
      host: session.config.host,
      port: session.config.port || 21,
      user: session.config.user || 'anonymous',
      password: session.config.password || '',
      secure: session.config.secure || false,
      secureOptions: {
        rejectUnauthorized: false // Allow self-signed FTPS certs
      }
    });

    if (session.currentDir && session.currentDir !== '/') {
      try {
        await client.cd(session.currentDir);
      } catch (cdErr) {
        session.currentDir = await client.pwd();
      }
    } else {
      session.currentDir = await client.pwd();
    }

    session.client = client;
    addLog(session, 'success', 'Yeniden bağlantı başarılı.');
  }

  return session;
}

// Health check endpoint for Cloud Run
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Connect to FTP server
app.post('/api/connect', async (req, res) => {
  const { host, port, user, password, secure } = req.body;

  if (!host) {
    return res.status(400).json({ success: false, error: 'Sunucu adresi (Host) zorunludur.' });
  }

  const sessionId = crypto.randomUUID();
  const client = new ftp.Client(30000);
  client.ftp.verbose = false;

  const sessionData = {
    client,
    config: {
      host: host.trim(),
      port: parseInt(port, 10) || 21,
      user: (user || 'anonymous').trim(),
      password: password || '',
      secure: secure === true || secure === 'true'
    },
    currentDir: '/',
    lastActive: Date.now(),
    logs: []
  };

  try {
    addLog(sessionData, 'info', `${sessionData.config.host}:${sessionData.config.port} adresine bağlanılıyor...`);

    await client.access({
      host: sessionData.config.host,
      port: sessionData.config.port,
      user: sessionData.config.user,
      password: sessionData.config.password,
      secure: sessionData.config.secure,
      secureOptions: {
        rejectUnauthorized: false
      }
    });

    addLog(sessionData, 'success', `Giriş başarılı: ${sessionData.config.user}@${sessionData.config.host}`);

    const currentDir = await client.pwd();
    sessionData.currentDir = currentDir;
    addLog(sessionData, 'info', `Çalışma dizini: ${currentDir}`);

    sessions.set(sessionId, sessionData);

    return res.json({
      success: true,
      sessionId,
      currentDir,
      host: sessionData.config.host,
      user: sessionData.config.user,
      port: sessionData.config.port
    });
  } catch (err) {
    try {
      client.close();
    } catch (cErr) {
      // ignore
    }
    return res.status(500).json({
      success: false,
      error: `Bağlantı hatası: ${err.message || 'Sunucuya ulaşılamadı'}`
    });
  }
});

// Disconnect from FTP
app.post('/api/disconnect', async (req, res) => {
  const sessionId = req.headers['x-session-id'] || req.body.sessionId;
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    try {
      addLog(session, 'info', 'Bağlantı kapatıldı.');
      session.client.close();
    } catch (e) {
      // ignore
    }
    sessions.delete(sessionId);
  }
  return res.json({ success: true, message: 'Bağlantı sonlandırıldı.' });
});

// Check Session Status
app.get('/api/session', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(401).json({ success: false, error: 'Aktif oturum bulunamadı.' });
  }
  const session = sessions.get(sessionId);
  return res.json({
    success: true,
    currentDir: session.currentDir,
    host: session.config.host,
    user: session.config.user,
    port: session.config.port
  });
});

// List Files in Directory
app.get('/api/list', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const targetPath = req.query.path;

  try {
    const session = await getFtpClient(sessionId);
    const { client } = session;

    if (targetPath) {
      await client.cd(targetPath);
      session.currentDir = await client.pwd();
    }

    addLog(session, 'command', `LIST ${session.currentDir}`);
    const list = await client.list();
    addLog(session, 'info', `${list.length} adet dosya/dizin listelendi.`);

    const formattedList = list.map(item => ({
      name: item.name,
      type: item.isDirectory ? 'directory' : item.isSymbolicLink ? 'symlink' : 'file',
      size: item.size,
      rawModifiedAt: item.rawModifiedAt,
      modifiedAt: item.modifiedAt ? item.modifiedAt.toISOString() : null,
      permissions: item.permissions ? {
        user: item.permissions.user,
        group: item.permissions.group,
        world: item.permissions.world
      } : null,
      isDirectory: item.isDirectory,
      isSymbolicLink: item.isSymbolicLink
    }));

    // Sort: directories first, then alphabetical
    formattedList.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    return res.json({
      success: true,
      currentDir: session.currentDir,
      files: formattedList
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Change Directory (CWD)
app.post('/api/cwd', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { path: newPath } = req.body;

  if (!newPath) {
    return res.status(400).json({ success: false, error: 'Hedef dizin belirtilmedi.' });
  }

  try {
    const session = await getFtpClient(sessionId);
    addLog(session, 'command', `CWD ${newPath}`);
    await session.client.cd(newPath);
    session.currentDir = await session.client.pwd();
    addLog(session, 'info', `Yeni dizin: ${session.currentDir}`);

    return res.json({ success: true, currentDir: session.currentDir });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Create Directory (MKDIR)
app.post('/api/mkdir', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { name } = req.body;

  if (!name || name.trim() === '') {
    return res.status(400).json({ success: false, error: 'Klasör adı belirtilmedi.' });
  }

  try {
    const session = await getFtpClient(sessionId);
    const safeName = name.trim();
    addLog(session, 'command', `MKDIR ${safeName}`);
    await session.client.ensureDir(safeName);
    // return back to working dir if ensureDir changed it
    await session.client.cd(session.currentDir);
    addLog(session, 'success', `"${safeName}" klasörü oluşturuldu.`);

    return res.json({ success: true, message: 'Klasör başarıyla oluşturuldu.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Rename File or Directory
app.post('/api/rename', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { oldPath, newPath } = req.body;

  if (!oldPath || !newPath) {
    return res.status(400).json({ success: false, error: 'Eski ve yeni isimler gereklidir.' });
  }

  try {
    const session = await getFtpClient(sessionId);
    addLog(session, 'command', `RNFR ${oldPath} -> RNTO ${newPath}`);
    await session.client.rename(oldPath, newPath);
    addLog(session, 'success', `Yeniden adlandırıldı: ${oldPath} -> ${newPath}`);

    return res.json({ success: true, message: 'Başarıyla yeniden adlandırıldı.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Delete File or Directory
app.post('/api/delete', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { path: targetPath, isDirectory } = req.body;

  if (!targetPath) {
    return res.status(400).json({ success: false, error: 'Silinecek öğe belirtilmedi.' });
  }

  try {
    const session = await getFtpClient(sessionId);
    if (isDirectory) {
      addLog(session, 'command', `RMD ${targetPath} (ve alt öğeleri)`);
      await session.client.removeDir(targetPath);
      addLog(session, 'success', `"${targetPath}" dizini silindi.`);
    } else {
      addLog(session, 'command', `DELE ${targetPath}`);
      await session.client.remove(targetPath);
      addLog(session, 'success', `"${targetPath}" dosyası silindi.`);
    }

    return res.json({ success: true, message: 'Öğe başarıyla silindi.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Download File Stream
app.get('/api/download', async (req, res) => {
  const sessionId = req.headers['x-session-id'] || req.query.sessionId;
  const filePath = req.query.path;

  if (!filePath) {
    return res.status(400).json({ success: false, error: 'Dosya yolu belirtilmedi.' });
  }

  try {
    const session = await getFtpClient(sessionId);
    const filename = path.basename(filePath);
    const contentType = mime.lookup(filename) || 'application/octet-stream';

    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', contentType);

    addLog(session, 'command', `RETR ${filePath} (indirme)`);

    // Download stream from FTP client directly to HTTP response
    const passThrough = new stream.PassThrough();
    passThrough.pipe(res);

    await session.client.downloadTo(passThrough, filePath);
    addLog(session, 'success', `"${filename}" indirmesi tamamlandı.`);
  } catch (err) {
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
});

// View / Preview File (for Editor or Image)
app.get('/api/view', async (req, res) => {
  const sessionId = req.headers['x-session-id'] || req.query.sessionId;
  const filePath = req.query.path;
  const isInline = req.query.inline === 'true';

  if (!filePath) {
    return res.status(400).json({ success: false, error: 'Dosya yolu belirtilmedi.' });
  }

  try {
    const session = await getFtpClient(sessionId);
    const filename = path.basename(filePath);
    const contentType = mime.lookup(filename) || 'text/plain';

    // Buffer download (max 15MB for in-memory view/edit)
    const chunks = [];
    const writable = new stream.Writable({
      write(chunk, encoding, callback) {
        chunks.push(chunk);
        callback();
      }
    });

    addLog(session, 'command', `RETR ${filePath} (önizleme)`);
    await session.client.downloadTo(writable, filePath);
    const buffer = Buffer.concat(chunks);

    if (isInline) {
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
      return res.send(buffer);
    }

    // Return as text for code editor
    const textContent = buffer.toString('utf8');
    return res.json({
      success: true,
      filename,
      contentType,
      size: buffer.length,
      content: textContent
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Save Text/Code File (Editor)
app.post('/api/save', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { path: filePath, content } = req.body;

  if (!filePath || content === undefined) {
    return res.status(400).json({ success: false, error: 'Dosya yolu veya içerik eksik.' });
  }

  try {
    const session = await getFtpClient(sessionId);
    const buffer = Buffer.from(content, 'utf8');
    const readStream = stream.Readable.from(buffer);

    addLog(session, 'command', `STOR ${filePath} (kaydetme)`);
    await session.client.uploadFrom(readStream, filePath);
    addLog(session, 'success', `"${filePath}" başarıyla kaydedildi (${buffer.length} bayt).`);

    return res.json({ success: true, message: 'Dosya başarıyla kaydedildi.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Check if target files already exist (FileZilla-style overwrite detection)
app.post('/api/check-exists', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { paths } = req.body;

  if (!paths || !Array.isArray(paths)) {
    return res.status(400).json({ success: false, error: 'Dosya listesi (paths) gereklidir.' });
  }

  try {
    const session = await getFtpClient(sessionId);
    const conflicts = [];

    // Group files by parent directory to optimize FTP LIST calls
    const dirsToCheck = new Map();

    for (const relPath of paths) {
      const normalized = relPath.replace(/\\/g, '/');
      const dir = path.posix.dirname(normalized);
      const filename = path.posix.basename(normalized);
      const fullDir = (dir && dir !== '.' && dir !== '/')
        ? path.posix.join(session.currentDir, dir)
        : session.currentDir;

      if (!dirsToCheck.has(fullDir)) {
        dirsToCheck.set(fullDir, []);
      }
      dirsToCheck.get(fullDir).push({ relPath: normalized, filename });
    }

    for (const [fullDir, files] of dirsToCheck.entries()) {
      try {
        const list = await session.client.list(fullDir);
        const map = new Map();
        list.forEach(item => map.set(item.name, item));

        for (const { relPath, filename } of files) {
          if (map.has(filename)) {
            const item = map.get(filename);
            conflicts.push({
              relativePath: relPath,
              filename,
              exists: true,
              size: item.size,
              modifiedAt: item.modifiedAt ? item.modifiedAt.toISOString() : (item.rawModifiedAt || null),
              isDirectory: item.isDirectory
            });
          }
        }
      } catch (dirErr) {
        // If directory doesn't exist on FTP yet, no files exist in it
      }
    }

    // Ensure we are back in working dir
    await session.client.cd(session.currentDir);

    return res.json({ success: true, conflicts });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Upload File(s) with folder / relative path support
app.post('/api/upload', upload.array('files'), async (req, res) => {
  const sessionId = req.headers['x-session-id'];

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ success: false, error: 'Yüklenecek dosya seçilmedi.' });
  }

  try {
    const session = await getFtpClient(sessionId);
    const uploadedFiles = [];

    // Parse relative paths if provided (for folders & nested structures)
    let relativePaths = [];
    if (req.body.paths) {
      try {
        relativePaths = typeof req.body.paths === 'string' ? JSON.parse(req.body.paths) : req.body.paths;
      } catch (e) {
        relativePaths = [req.body.paths];
      }
    }

    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const relPath = (relativePaths && relativePaths[i]) ? relativePaths[i] : file.originalname;
      const readStream = stream.Readable.from(file.buffer);

      // Handle nested folder directories
      const normalizedRelPath = relPath.replace(/\\/g, '/');
      const dirName = path.posix.dirname(normalizedRelPath);

      if (dirName && dirName !== '.' && dirName !== '/') {
        const fullDir = path.posix.join(session.currentDir, dirName);
        addLog(session, 'command', `MKDIR ${fullDir} (klasör yapısı)`);
        await session.client.ensureDir(fullDir);
        await session.client.cd(session.currentDir);
      }

      const targetPath = path.posix.join(session.currentDir, normalizedRelPath);
      addLog(session, 'command', `STOR ${targetPath} (${file.size} bayt)`);
      await session.client.uploadFrom(readStream, targetPath);
      addLog(session, 'success', `"${normalizedRelPath}" yüklendi.`);
      uploadedFiles.push(normalizedRelPath);
    }

    // Ensure we are back in currentDir
    await session.client.cd(session.currentDir);

    return res.json({
      success: true,
      message: `${uploadedFiles.length} dosya başarıyla yüklendi.`,
      files: uploadedFiles
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Change Permissions (CHMOD)
app.post('/api/chmod', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { path: targetPath, mode } = req.body;

  if (!targetPath || !mode) {
    return res.status(400).json({ success: false, error: 'Dosya yolu ve izin modu (örn: 755) gereklidir.' });
  }

  try {
    const session = await getFtpClient(sessionId);
    addLog(session, 'command', `SITE CHMOD ${mode} ${targetPath}`);
    await session.client.send(`SITE CHMOD ${mode} ${targetPath}`);
    addLog(session, 'success', `İzinler güncellendi: ${mode} (${targetPath})`);

    return res.json({ success: true, message: 'İzinler başarıyla güncellendi.' });
  } catch (err) {
    return res.status(500).json({ success: false, error: `İzin değiştirilemedi: ${err.message}` });
  }
});

// Session Logs (FileZilla style terminal output)
app.get('/api/logs', (req, res) => {
  const sessionId = req.headers['x-session-id'];
  if (!sessionId || !sessions.has(sessionId)) {
    return res.json({ success: true, logs: [] });
  }
  const session = sessions.get(sessionId);
  return res.json({ success: true, logs: session.logs });
});

// Start listening
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 FTP Client Online sunucusu çalışıyor: http://0.0.0.0:${PORT}`);
});

