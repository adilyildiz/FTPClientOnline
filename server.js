const express = require('express');
const cors = require('cors');
const multer = require('multer');
const ftp = require('basic-ftp');
const path = require('path');
const stream = require('stream');
const crypto = require('crypto');
const mime = require('mime-types');
const { ZipArchive } = require('archiver');

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
  const ts = Date.now();
  const timestamp = new Date(ts).toLocaleTimeString('tr-TR');
  session.logs.push({ ts, timestamp, type, message });
  if (session.logs.length > 200) {
    session.logs.shift();
  }
}

function normalizePosixPath(p) {
  if (!p) return '/';
  let normalized = String(p).replace(/\\/g, '/');
  if (!normalized.startsWith('/')) normalized = '/' + normalized;
  normalized = path.posix.normalize(normalized);
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function sanitizeRelativePath(relPath) {
  const parts = String(relPath || '').replace(/\\/g, '/').split('/');
  const resolved = [];
  for (const seg of parts) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      resolved.pop();
    } else {
      resolved.push(seg);
    }
  }
  return resolved.join('/');
}

// Serialize FTP client commands per session to prevent concurrent basic-ftp task errors
async function withSessionLock(sessionId, taskFn) {
  const session = sessions.get(sessionId);
  if (!session) {
    throw new Error('Oturum bulunamadı veya süresi doldu. Lütfen yeniden bağlanın.');
  }
  const prev = session.lockPromise || Promise.resolve();
  let release;
  const next = new Promise(resolve => { release = resolve; });
  session.lockPromise = prev.then(() => next, () => next);
  await prev;
  try {
    const activeSession = await getFtpClient(sessionId);
    return await taskFn(activeSession);
  } finally {
    release();
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
    logs: [],
    lockPromise: Promise.resolve()
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
    const result = await withSessionLock(sessionId, async (session) => {
      const { client } = session;

      if (targetPath) {
        await client.cd(targetPath);
        session.currentDir = await client.pwd();
      }

      addLog(session, 'command', `LIST ${session.currentDir}`);
      const list = await client.list();
      addLog(session, 'info', `${list.length} adet dosya/dizin listelendi.`);

      const formattedList = list
        .filter(item => item.name !== '.' && item.name !== '..')
        .map(item => ({
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

      return {
        success: true,
        currentDir: session.currentDir,
        files: formattedList
      };
    });

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Recursively List Remote Directory Tree (for Folder Sync / Compare)
app.post('/api/list-tree', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { basePath, maxDepth = 10, exclude = [] } = req.body || {};

  const excludeSet = new Set(
    Array.isArray(exclude)
      ? exclude.map(s => String(s).trim()).filter(Boolean)
      : []
  );

  try {
    const result = await withSessionLock(sessionId, async (session) => {
      const { client } = session;
      const savedCwd = session.currentDir;
      const rootPath = basePath ? normalizePosixPath(basePath) : normalizePosixPath(savedCwd);
      const entries = [];
      const MAX_ENTRIES = 5000;
      let truncated = false;

      async function walk(remoteDir, relPrefix, depth) {
        if (entries.length >= MAX_ENTRIES) {
          truncated = true;
          return;
        }
        await client.cd(remoteDir);
        const list = await client.list();

        for (const item of list) {
          if (item.name === '.' || item.name === '..') continue;
          if (item.isSymbolicLink) continue;
          if (excludeSet.has(item.name)) continue;

          if (entries.length >= MAX_ENTRIES) {
            truncated = true;
            break;
          }

          const relPath = relPrefix ? `${relPrefix}/${item.name}` : item.name;
          entries.push({
            relativePath: relPath,
            name: item.name,
            type: item.isDirectory ? 'directory' : 'file',
            size: item.size || 0,
            rawModifiedAt: item.rawModifiedAt || null,
            modifiedAt: item.modifiedAt ? item.modifiedAt.toISOString() : null,
            isDirectory: item.isDirectory
          });

          if (item.isDirectory && depth < maxDepth) {
            const subDir = rootPath === '/' ? `/${relPath}` : `${rootPath}/${relPath}`;
            await walk(subDir, relPath, depth + 1);
          }
        }
      }

      try {
        addLog(session, 'command', `TREE ${rootPath} (senkronizasyon taraması)`);
        await walk(rootPath, '', 0);
        addLog(session, 'info', `${entries.length} uzak öğe tarandı${truncated ? ' (sınıra ulaşıldı)' : ''}.`);
      } finally {
        try {
          await client.cd(savedCwd);
        } catch (e) {
          // ignore restore error
        }
      }

      return {
        success: true,
        basePath: rootPath,
        entries,
        truncated
      };
    });

    return res.json(result);
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
    const result = await withSessionLock(sessionId, async (session) => {
      addLog(session, 'command', `CWD ${newPath}`);
      await session.client.cd(newPath);
      session.currentDir = await session.client.pwd();
      addLog(session, 'info', `Yeni dizin: ${session.currentDir}`);
      return { success: true, currentDir: session.currentDir };
    });

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Create Directory (MKDIR)
app.post('/api/mkdir', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { name, baseDir } = req.body;

  if (!name || name.trim() === '') {
    return res.status(400).json({ success: false, error: 'Klasör adı belirtilmedi.' });
  }

  try {
    const result = await withSessionLock(sessionId, async (session) => {
      const safeName = name.trim();
      const targetDir = safeName.startsWith('/')
        ? normalizePosixPath(safeName)
        : (baseDir ? path.posix.join(normalizePosixPath(baseDir), sanitizeRelativePath(safeName)) : safeName);

      addLog(session, 'command', `MKDIR ${targetDir}`);
      await session.client.ensureDir(targetDir);
      // return back to working dir if ensureDir changed it
      await session.client.cd(session.currentDir);
      addLog(session, 'success', `"${targetDir}" klasörü oluşturuldu.`);

      return { success: true, message: 'Klasör başarıyla oluşturuldu.' };
    });

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Batch Create Directories (for folder sync)
app.post('/api/mkdir-batch', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { baseDir, paths } = req.body;

  if (!paths || !Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ success: false, error: 'Oluşturulacak klasör listesi boş.' });
  }

  try {
    const result = await withSessionLock(sessionId, async (session) => {
      const rootDir = baseDir ? normalizePosixPath(baseDir) : session.currentDir;
      let createdCount = 0;

      try {
        for (const relPath of paths) {
          const safeRel = sanitizeRelativePath(relPath);
          if (!safeRel) continue;
          const fullDir = path.posix.join(rootDir, safeRel);
          addLog(session, 'command', `MKDIR ${fullDir} (senkronizasyon)`);
          await session.client.ensureDir(fullDir);
          createdCount++;
        }
      } finally {
        try {
          await session.client.cd(session.currentDir);
        } catch (e) {}
      }

      return { success: true, createdCount };
    });

    return res.json(result);
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
    const result = await withSessionLock(sessionId, async (session) => {
      addLog(session, 'command', `RNFR ${oldPath} -> RNTO ${newPath}`);
      await session.client.rename(oldPath, newPath);
      addLog(session, 'success', `Yeniden adlandırıldı: ${oldPath} -> ${newPath}`);
      return { success: true, message: 'Başarıyla yeniden adlandırıldı.' };
    });

    return res.json(result);
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
    const result = await withSessionLock(sessionId, async (session) => {
      if (isDirectory) {
        addLog(session, 'command', `RMD ${targetPath} (ve alt öğeleri)`);
        await session.client.removeDir(targetPath);
        addLog(session, 'success', `"${targetPath}" dizini silindi.`);
      } else {
        addLog(session, 'command', `DELE ${targetPath}`);
        await session.client.remove(targetPath);
        addLog(session, 'success', `"${targetPath}" dosyası silindi.`);
      }
      return { success: true, message: 'Öğe başarıyla silindi.' };
    });

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Batch Delete Files and Directories
app.post('/api/delete-batch', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { items, baseDir } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, error: 'Silinecek öğe seçilmedi.' });
  }

  try {
    const result = await withSessionLock(sessionId, async (session) => {
      let deletedCount = 0;
      const rootDir = baseDir ? normalizePosixPath(baseDir) : null;

      try {
        for (const item of items) {
          const target = rootDir
            ? path.posix.join(rootDir, sanitizeRelativePath(item.path))
            : item.path;

          if (item.isDirectory) {
            addLog(session, 'command', `RMD ${target} (toplu silme)`);
            await session.client.removeDir(target);
          } else {
            addLog(session, 'command', `DELE ${target} (toplu silme)`);
            await session.client.remove(target);
          }
          deletedCount++;
        }
      } finally {
        try {
          await session.client.cd(session.currentDir);
        } catch (e) {}
      }

      addLog(session, 'success', `Toplam ${deletedCount} öğe silindi.`);
      return { success: true, message: `${deletedCount} öğe başarıyla silindi.` };
    });

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Download Folder as ZIP archive
app.get('/api/download-zip', async (req, res) => {
  const sessionId = req.headers['x-session-id'] || req.query.sessionId;
  const folderPath = req.query.path || '/';

  let transferClient = null;
  let usingTempClient = false;
  let archive = null;
  let session = null;

  async function streamZip(clientForTransfer, activeSession) {
    const folderName = path.posix.basename(folderPath) || 'ftp-archive';
    const zipFilename = `${folderName}.zip`;

    // Verify target folder exists and is readable before sending response headers
    await clientForTransfer.cd(folderPath);

    addLog(activeSession, 'command', `ZIP ${folderPath} (arşiv oluşturuluyor...)`);

    archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on('error', err => {
      console.error('ZipArchive stream error:', err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: err.message });
      } else {
        res.end();
      }
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(zipFilename)}"`);
    archive.pipe(res);

    async function addFolderToZip(remoteDir, zipPrefix = '') {
      await clientForTransfer.cd(remoteDir);
      const list = await clientForTransfer.list();

      // Append files inside remoteDir first
      for (const item of list) {
        if (item.name === '.' || item.name === '..') continue;
        if (!item.isDirectory && !item.isSymbolicLink) {
          const itemZipPath = zipPrefix ? `${zipPrefix}/${item.name}` : item.name;
          const chunks = [];
          const writable = new stream.Writable({
            write(chunk, encoding, callback) {
              chunks.push(chunk);
              callback();
            }
          });
          await clientForTransfer.downloadTo(writable, item.name);
          archive.append(Buffer.concat(chunks), { name: itemZipPath });
        }
      }

      // Recurse into subdirectories
      for (const item of list) {
        if (item.name === '.' || item.name === '..') continue;
        if (item.isDirectory) {
          const itemRemotePath = path.posix.join(remoteDir, item.name);
          const itemZipPath = zipPrefix ? `${zipPrefix}/${item.name}` : item.name;
          archive.append(null, { name: itemZipPath + '/' });
          await addFolderToZip(itemRemotePath, itemZipPath);
        }
      }
    }

    await addFolderToZip(folderPath);
    await archive.finalize();

    addLog(activeSession, 'success', `"${zipFilename}" ZIP arşivi indirildi.`);
  }

  try {
    session = sessions.get(sessionId);
    if (!session) {
      throw new Error('Oturum bulunamadı veya süresi doldu. Lütfen yeniden bağlanın.');
    }
    session.lastActive = Date.now();

    // Open a dedicated FTP connection so browsing doesn't collide; fall back to locked session client if limited
    const tempClient = new ftp.Client(30000);
    tempClient.ftp.verbose = false;
    try {
      await tempClient.access({
        host: session.config.host,
        port: session.config.port || 21,
        user: session.config.user || 'anonymous',
        password: session.config.password || '',
        secure: session.config.secure || false,
        secureOptions: { rejectUnauthorized: false }
      });
      transferClient = tempClient;
      usingTempClient = true;
    } catch (connErr) {
      try { tempClient.close(); } catch (e) {}
    }

    if (usingTempClient) {
      await streamZip(transferClient, session);
    } else {
      await withSessionLock(sessionId, async (lockedSession) => {
        try {
          await streamZip(lockedSession.client, lockedSession);
        } finally {
          if (!lockedSession.client.closed) {
            try { await lockedSession.client.cd(lockedSession.currentDir); } catch (e) {}
          }
        }
      });
    }
  } catch (err) {
    console.error('Download ZIP error:', err);
    if (session) {
      addLog(session, 'error', `ZIP indirme hatası: ${err.message}`);
    }
    if (!res.headersSent) {
      res.removeHeader('Content-Disposition');
      res.removeHeader('Content-Type');
      return res.status(500).json({ success: false, error: err.message });
    } else {
      if (archive) {
        try { archive.abort(); } catch (e) {}
      }
      res.end();
    }
  } finally {
    if (usingTempClient && transferClient) {
      try { transferClient.close(); } catch (e) {}
    }
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
    await withSessionLock(sessionId, async (session) => {
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
    });
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
    const result = await withSessionLock(sessionId, async (session) => {
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

      return { filename, contentType, buffer };
    });

    if (isInline) {
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(result.filename)}"`);
      return res.send(result.buffer);
    }

    // Return as text for code editor
    const textContent = result.buffer.toString('utf8');
    return res.json({
      success: true,
      filename: result.filename,
      contentType: result.contentType,
      size: result.buffer.length,
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
    const result = await withSessionLock(sessionId, async (session) => {
      const buffer = Buffer.from(content, 'utf8');
      const readStream = stream.Readable.from(buffer);

      addLog(session, 'command', `STOR ${filePath} (kaydetme)`);
      await session.client.uploadFrom(readStream, filePath);
      addLog(session, 'success', `"${filePath}" başarıyla kaydedildi (${buffer.length} bayt).`);

      return { success: true, message: 'Dosya başarıyla kaydedildi.' };
    });

    return res.json(result);
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Check if target files already exist (FileZilla-style overwrite detection)
app.post('/api/check-exists', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { paths, baseDir } = req.body;

  if (!paths || !Array.isArray(paths)) {
    return res.status(400).json({ success: false, error: 'Dosya listesi (paths) gereklidir.' });
  }

  try {
    const result = await withSessionLock(sessionId, async (session) => {
      const rootDir = baseDir ? normalizePosixPath(baseDir) : session.currentDir;
      const conflicts = [];

      // Group files by parent directory to optimize FTP LIST calls
      const dirsToCheck = new Map();

      for (const relPath of paths) {
        const normalized = sanitizeRelativePath(relPath);
        if (!normalized) continue;
        const dir = path.posix.dirname(normalized);
        const filename = path.posix.basename(normalized);
        const fullDir = (dir && dir !== '.' && dir !== '/')
          ? path.posix.join(rootDir, dir)
          : rootDir;

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

      return { success: true, conflicts };
    });

    return res.json(result);
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
    const result = await withSessionLock(sessionId, async (session) => {
      const rootDir = req.body.baseDir ? normalizePosixPath(req.body.baseDir) : session.currentDir;
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

      try {
        for (let i = 0; i < req.files.length; i++) {
          const file = req.files[i];
          const relPath = (relativePaths && relativePaths[i]) ? relativePaths[i] : file.originalname;
          const readStream = stream.Readable.from(file.buffer);

          // Handle nested folder directories
          const normalizedRelPath = sanitizeRelativePath(relPath) || file.originalname;
          const dirName = path.posix.dirname(normalizedRelPath);

          if (dirName && dirName !== '.' && dirName !== '/') {
            const fullDir = path.posix.join(rootDir, dirName);
            addLog(session, 'command', `MKDIR ${fullDir} (klasör yapısı)`);
            await session.client.ensureDir(fullDir);
            await session.client.cd(session.currentDir);
          }

          const targetPath = path.posix.join(rootDir, normalizedRelPath);
          addLog(session, 'command', `STOR ${targetPath} (${file.size} bayt)`);
          await session.client.uploadFrom(readStream, targetPath);
          addLog(session, 'success', `"${normalizedRelPath}" yüklendi.`);
          uploadedFiles.push(normalizedRelPath);
        }
      } finally {
        // Ensure we are back in currentDir
        try {
          await session.client.cd(session.currentDir);
        } catch (e) {}
      }

      return {
        success: true,
        message: `${uploadedFiles.length} dosya başarıyla yüklendi.`,
        files: uploadedFiles
      };
    });

    return res.json(result);
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
    const result = await withSessionLock(sessionId, async (session) => {
      addLog(session, 'command', `SITE CHMOD ${mode} ${targetPath}`);
      await session.client.send(`SITE CHMOD ${mode} ${targetPath}`);
      addLog(session, 'success', `İzinler güncellendi: ${mode} (${targetPath})`);
      return { success: true, message: 'İzinler başarıyla güncellendi.' };
    });

    return res.json(result);
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

