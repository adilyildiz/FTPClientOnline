// CloudFTP - Web FTP Client Frontend Logic

let currentSession = null;
let currentPath = '/';
let fileList = [];
let sortField = 'name';
let sortDirection = 'asc';
let logPollInterval = null;
let currentEditingPath = null;

// Initialize on DOM load
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  loadBookmarks();
  checkExistingSession();
});

function setupEventListeners() {
  // Connect form submit
  const connectForm = document.getElementById('connectForm');
  connectForm.addEventListener('submit', handleConnect);

  // Disconnect button
  document.getElementById('disconnectBtn').addEventListener('click', handleDisconnect);

  // Navigation buttons
  document.getElementById('navUpBtn').addEventListener('click', navigateUp);
  document.getElementById('navRootBtn').addEventListener('click', () => changeDirectory('/'));
  document.getElementById('refreshBtn').addEventListener('click', refreshFiles);

  // Search input filter
  document.getElementById('searchInput').addEventListener('input', (e) => {
    renderFileList(e.target.value.trim());
  });

  // Upload buttons and file input
  const fileInput = document.getElementById('fileUploadInput');
  document.getElementById('uploadBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', handleFileUpload);

  // Folder upload button and input
  const folderInput = document.getElementById('folderUploadInput');
  document.getElementById('uploadFolderBtn').addEventListener('click', () => folderInput.click());
  folderInput.addEventListener('change', handleFolderUpload);

  // New folder & file buttons
  document.getElementById('newFolderBtn').addEventListener('click', () => openModal('newFolderModal'));
  document.getElementById('newFileBtn').addEventListener('click', () => openModal('newFileModal'));

  // Bookmarks modal button
  document.getElementById('openBookmarksBtn').addEventListener('click', () => openModal('bookmarksModal'));

  // Drag and Drop support
  setupDragAndDrop();
}

// Check if an existing session is in sessionStorage
async function checkExistingSession() {
  const savedSessionId = sessionStorage.getItem('cloudftp_sessionId');
  if (!savedSessionId) return;

  try {
    const res = await fetch('/api/session', {
      headers: { 'x-session-id': savedSessionId }
    });
    const data = await res.json();
    if (data.success) {
      currentSession = {
        sessionId: savedSessionId,
        host: data.host,
        user: data.user,
        port: data.port
      };
      currentPath = data.currentDir || '/';
      updateConnectionUI(true);
      await loadDirectory(currentPath);
      startLogPolling();
      showToast(`Aktif oturum geri yüklendi: ${data.user}@${data.host}`, 'info');
    } else {
      sessionStorage.removeItem('cloudftp_sessionId');
    }
  } catch (err) {
    sessionStorage.removeItem('cloudftp_sessionId');
  }
}

// Connect Handler
async function handleConnect(e) {
  e.preventDefault();
  const host = document.getElementById('hostInput').value.trim();
  const port = document.getElementById('portInput').value.trim();
  const user = document.getElementById('userInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  const secure = document.getElementById('secureCheck').checked;

  const connectBtn = document.getElementById('connectBtn');
  const originalBtnHtml = connectBtn.innerHTML;
  connectBtn.disabled = true;
  connectBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> <span>Bağlanıyor...</span>';

  updateStatus('connecting', 'Bağlantı kuruluyor...');

  try {
    const response = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ host, port, user, password, secure })
    });

    const data = await response.json();

    if (!data.success) {
      throw new Error(data.error || 'Bağlantı başarısız.');
    }

    currentSession = data;
    sessionStorage.setItem('cloudftp_sessionId', data.sessionId);
    currentPath = data.currentDir || '/';

    updateConnectionUI(true);
    await loadDirectory(currentPath);
    startLogPolling();
    showToast(`Bağlandı: ${data.user}@${data.host}`, 'success');
  } catch (err) {
    updateStatus('disconnected', 'Bağlantı Hatası');
    showToast(err.message, 'error');
  } finally {
    connectBtn.disabled = false;
    connectBtn.innerHTML = originalBtnHtml;
  }
}

// Disconnect Handler
async function handleDisconnect() {
  if (!currentSession) return;

  try {
    await fetch('/api/disconnect', {
      method: 'POST',
      headers: { 'x-session-id': currentSession.sessionId }
    });
  } catch (e) {
    // ignore
  }

  currentSession = null;
  sessionStorage.removeItem('cloudftp_sessionId');
  stopLogPolling();
  updateConnectionUI(false);
  fileList = [];
  renderFileList();
  showToast('Bağlantı kapatıldı.', 'info');
}

// UI State Updates
function updateConnectionUI(connected) {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const disconnectBtn = document.getElementById('disconnectBtn');
  const connectBtn = document.getElementById('connectBtn');
  const navUpBtn = document.getElementById('navUpBtn');
  const navRootBtn = document.getElementById('navRootBtn');
  const refreshBtn = document.getElementById('refreshBtn');
  const uploadBtn = document.getElementById('uploadBtn');
  const uploadFolderBtn = document.getElementById('uploadFolderBtn');
  const newFolderBtn = document.getElementById('newFolderBtn');
  const newFileBtn = document.getElementById('newFileBtn');
  const disconnectedState = document.getElementById('disconnectedState');
  const explorerTableContainer = document.getElementById('explorerTableContainer');

  if (connected) {
    statusDot.className = 'w-2 h-2 rounded-full bg-emerald-400 animate-pulse';
    statusText.innerText = `${currentSession.user}@${currentSession.host}`;
    disconnectBtn.style.display = 'inline-flex';
    connectBtn.style.display = 'none';

    navUpBtn.disabled = false;
    navRootBtn.disabled = false;
    refreshBtn.disabled = false;
    uploadBtn.disabled = false;
    if (uploadFolderBtn) uploadFolderBtn.disabled = false;
    newFolderBtn.disabled = false;
    newFileBtn.disabled = false;

    disconnectedState.classList.add('hidden');
    explorerTableContainer.classList.remove('hidden');
  } else {
    statusDot.className = 'w-2 h-2 rounded-full bg-slate-500';
    statusText.innerText = 'Bağlı Değil';
    disconnectBtn.style.display = 'none';
    connectBtn.style.display = 'inline-flex';

    navUpBtn.disabled = true;
    navRootBtn.disabled = true;
    refreshBtn.disabled = true;
    uploadBtn.disabled = true;
    if (uploadFolderBtn) uploadFolderBtn.disabled = true;
    newFolderBtn.disabled = true;
    newFileBtn.disabled = true;

    disconnectedState.classList.remove('hidden');
    explorerTableContainer.classList.add('hidden');
    renderBreadcrumb('/');
  }
}

function updateStatus(state, message) {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  if (state === 'connecting') {
    statusDot.className = 'w-2 h-2 rounded-full bg-amber-400 animate-ping';
    statusText.innerText = message;
  } else if (state === 'disconnected') {
    statusDot.className = 'w-2 h-2 rounded-full bg-rose-500';
    statusText.innerText = message;
  }
}

// Load Directory Content
async function loadDirectory(path) {
  if (!currentSession) return;

  const refreshIcon = document.getElementById('refreshIcon');
  refreshIcon.classList.add('fa-spin');

  try {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    const res = await fetch(`/api/list${query}`, {
      headers: { 'x-session-id': currentSession.sessionId }
    });

    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || 'Dizin listelenemedi.');
    }

    currentPath = data.currentDir;
    fileList = data.files || [];

    renderBreadcrumb(currentPath);
    renderFileList();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    refreshIcon.classList.remove('fa-spin');
  }
}

// Refresh Directory
async function refreshFiles() {
  await loadDirectory(currentPath);
}

// Change Directory
async function changeDirectory(targetPath) {
  if (!currentSession) return;

  try {
    const res = await fetch('/api/cwd', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': currentSession.sessionId
      },
      body: JSON.stringify({ path: targetPath })
    });

    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || 'Dizin değiştirilemedi.');
    }

    currentPath = data.currentDir;
    await loadDirectory(currentPath);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function navigateUp() {
  if (currentPath === '/' || currentPath === '') return;
  changeDirectory('..');
}

// Render Breadcrumbs
function renderBreadcrumb(path) {
  const bar = document.getElementById('breadcrumbBar');
  if (!path || path === '/') {
    bar.innerHTML = `
      <button onclick="changeDirectory('/')" class="text-sky-400 hover:text-sky-300 font-bold flex items-center gap-1">
        <i class="fa-solid fa-house text-xs"></i> / (root)
      </button>`;
    return;
  }

  const parts = path.split('/').filter(Boolean);
  let accumulated = '';
  let html = `
    <button onclick="changeDirectory('/')" class="text-sky-400 hover:text-sky-300 font-bold flex items-center gap-1">
      <i class="fa-solid fa-house text-xs"></i> /
    </button>`;

  parts.forEach((part, idx) => {
    accumulated += '/' + part;
    const isLast = idx === parts.length - 1;
    const clickPath = accumulated;

    html += `<span class="text-slate-600">/</span>`;
    if (isLast) {
      html += `<span class="text-slate-100 font-bold px-1 py-0.5 rounded bg-slate-800">${escapeHtml(part)}</span>`;
    } else {
      html += `<button onclick="changeDirectory('${escapeHtml(clickPath)}')" class="text-slate-300 hover:text-sky-400 hover:underline px-1">${escapeHtml(part)}</button>`;
    }
  });

  bar.innerHTML = html;
}

// Render File Table
function renderFileList(filterQuery = '') {
  const tbody = document.getElementById('fileListBody');
  tbody.innerHTML = '';

  let filtered = [...fileList];
  if (filterQuery) {
    filtered = filtered.filter(f => f.name.toLowerCase().includes(filterQuery.toLowerCase()));
  }

  // Sort
  filtered.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;

    let valA = a[sortField];
    let valB = b[sortField];

    if (sortField === 'name') {
      return sortDirection === 'asc'
        ? valA.localeCompare(valB, undefined, { sensitivity: 'base' })
        : valB.localeCompare(valA, undefined, { sensitivity: 'base' });
    }
    if (sortField === 'size') {
      return sortDirection === 'asc' ? (valA || 0) - (valB || 0) : (valB || 0) - (valA || 0);
    }
    if (sortField === 'modifiedAt') {
      return sortDirection === 'asc'
        ? new Date(valA || 0) - new Date(valB || 0)
        : new Date(valB || 0) - new Date(valA || 0);
    }
    return 0;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="py-8 text-center text-slate-500 font-sans">
          <i class="fa-regular fa-folder-open text-2xl mb-2 block text-slate-600"></i>
          Bu klasörde görüntülenecek dosya yok.
        </td>
      </tr>`;
    return;
  }

  filtered.forEach(file => {
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-800/40 border-b border-slate-800/40 transition group';

    const iconHtml = getFileIcon(file);
    const sizeStr = file.isDirectory ? '-' : formatBytes(file.size);
    const dateStr = file.modifiedAt ? new Date(file.modifiedAt).toLocaleString('tr-TR') : (file.rawModifiedAt || '-');
    const permBadge = formatPermissions(file.permissions);

    tr.innerHTML = `
      <td class="py-2.5 px-4 flex items-center gap-2.5 overflow-hidden">
        ${iconHtml}
        <span class="truncate font-medium ${file.isDirectory ? 'text-sky-300 font-semibold cursor-pointer hover:underline' : 'text-slate-200 cursor-pointer hover:text-white'}"
          title="${escapeHtml(file.name)}">
          ${escapeHtml(file.name)}
        </span>
      </td>
      <td class="py-2.5 px-4 text-right text-slate-400 font-mono text-[11px]">${sizeStr}</td>
      <td class="py-2.5 px-4 text-center">
        <span class="px-1.5 py-0.5 rounded text-[10px] bg-slate-800/80 text-slate-300 border border-slate-700/60 font-mono">${permBadge}</span>
      </td>
      <td class="py-2.5 px-4 text-slate-400 text-[11px] whitespace-nowrap">${dateStr}</td>
      <td class="py-2.5 px-4 text-right whitespace-nowrap">
        <div class="inline-flex items-center gap-1 opacity-80 group-hover:opacity-100 transition">
          ${!file.isDirectory ? `
            <button onclick="downloadFile('${escapeHtml(file.name)}')" title="İndir" class="w-7 h-7 rounded hover:bg-slate-700 text-slate-300 hover:text-emerald-400 flex items-center justify-center transition">
              <i class="fa-solid fa-download text-xs"></i>
            </button>
            <button onclick="openFilePreview('${escapeHtml(file.name)}')" title="Görüntüle / Düzenle" class="w-7 h-7 rounded hover:bg-slate-700 text-slate-300 hover:text-sky-400 flex items-center justify-center transition">
              <i class="fa-solid fa-pen-to-square text-xs"></i>
            </button>
          ` : ''}
          <button onclick="openRenameModal('${escapeHtml(file.name)}')" title="Yeniden Adlandır" class="w-7 h-7 rounded hover:bg-slate-700 text-slate-300 hover:text-amber-400 flex items-center justify-center transition">
            <i class="fa-solid fa-pen text-xs"></i>
          </button>
          <button onclick="openChmodModal('${escapeHtml(file.name)}')" title="İzinler (CHMOD)" class="w-7 h-7 rounded hover:bg-slate-700 text-slate-300 hover:text-purple-400 flex items-center justify-center transition">
            <i class="fa-solid fa-key text-xs"></i>
          </button>
          <button onclick="deleteItem('${escapeHtml(file.name)}', ${file.isDirectory})" title="Sil" class="w-7 h-7 rounded hover:bg-rose-950/40 text-slate-400 hover:text-rose-400 flex items-center justify-center transition">
            <i class="fa-solid fa-trash-can text-xs"></i>
          </button>
        </div>
      </td>
    `;

    // Row click: click on row text to enter folder or view file
    const nameSpan = tr.querySelector('td:first-child span');
    nameSpan.addEventListener('click', () => {
      if (file.isDirectory) {
        changeDirectory(file.name);
      } else {
        openFilePreview(file.name);
      }
    });

    tbody.appendChild(tr);
  });
}

// File Icons Mapping
function getFileIcon(file) {
  if (file.isDirectory) {
    return '<i class="fa-solid fa-folder text-amber-400 text-base"></i>';
  }
  if (file.isSymbolicLink) {
    return '<i class="fa-solid fa-link text-indigo-400 text-sm"></i>';
  }

  const ext = file.name.split('.').pop().toLowerCase();
  switch (ext) {
    case 'html':
    case 'htm':
      return '<i class="fa-brands fa-html5 text-orange-500 text-sm"></i>';
    case 'css':
      return '<i class="fa-brands fa-css3-alt text-sky-400 text-sm"></i>';
    case 'js':
    case 'mjs':
      return '<i class="fa-brands fa-js text-yellow-400 text-sm"></i>';
    case 'php':
      return '<i class="fa-brands fa-php text-indigo-400 text-sm"></i>';
    case 'py':
      return '<i class="fa-brands fa-python text-emerald-400 text-sm"></i>';
    case 'json':
      return '<i class="fa-solid fa-code text-amber-300 text-sm"></i>';
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'svg':
    case 'webp':
      return '<i class="fa-solid fa-file-image text-emerald-400 text-sm"></i>';
    case 'zip':
    case 'rar':
    case 'tar':
    case 'gz':
    case '7z':
      return '<i class="fa-solid fa-file-zipper text-rose-400 text-sm"></i>';
    case 'pdf':
      return '<i class="fa-solid fa-file-pdf text-red-500 text-sm"></i>';
    case 'sql':
      return '<i class="fa-solid fa-database text-teal-400 text-sm"></i>';
    case 'txt':
    case 'md':
    case 'log':
      return '<i class="fa-solid fa-file-lines text-slate-300 text-sm"></i>';
    default:
      return '<i class="fa-solid fa-file text-slate-400 text-sm"></i>';
  }
}

// Download File
function downloadFile(filename) {
  if (!currentSession) return;
  const filePath = (currentPath === '/' ? '' : currentPath) + '/' + filename;
  window.open(`/api/download?path=${encodeURIComponent(filePath)}&sessionId=${currentSession.sessionId}`, '_blank');
}

// Open File Preview / Editor
async function openFilePreview(filename) {
  if (!currentSession) return;
  const ext = filename.split('.').pop().toLowerCase();
  const filePath = (currentPath === '/' ? '' : currentPath) + '/' + filename;

  // If Image, open Image Preview Modal
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) {
    document.getElementById('imagePreviewTitle').innerText = filename;
    const imgEl = document.getElementById('imagePreviewImg');
    imgEl.src = `/api/view?path=${encodeURIComponent(filePath)}&inline=true&sessionId=${currentSession.sessionId}`;
    openModal('imagePreviewModal');
    return;
  }

  // Else open in Code/Text Editor
  currentEditingPath = filePath;
  document.getElementById('editorFilename').innerText = filename;
  document.getElementById('editorFilesize').innerText = 'Yükleniyor...';
  document.getElementById('editorTextarea').value = 'İçerik sunucudan alınıyor...';
  openModal('editorModal');

  try {
    const res = await fetch(`/api/view?path=${encodeURIComponent(filePath)}`, {
      headers: { 'x-session-id': currentSession.sessionId }
    });
    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || 'Dosya okunamadı.');
    }

    document.getElementById('editorFilesize').innerText = formatBytes(data.size);
    document.getElementById('editorTextarea').value = data.content;
  } catch (err) {
    document.getElementById('editorTextarea').value = `Hata: ${err.message}`;
    showToast(err.message, 'error');
  }
}

// Save Editor Content back to FTP
async function saveEditorContent() {
  if (!currentSession || !currentEditingPath) return;

  const saveBtn = document.getElementById('editorSaveBtn');
  const originalHtml = saveBtn.innerHTML;
  saveBtn.disabled = true;
  saveBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Kaydediliyor...';

  const content = document.getElementById('editorTextarea').value;

  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': currentSession.sessionId
      },
      body: JSON.stringify({ path: currentEditingPath, content })
    });

    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || 'Kaydetme başarısız.');
    }

    showToast('Dosya FTP sunucusuna kaydedildi.', 'success');
    refreshFiles();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.innerHTML = originalHtml;
  }
}

// Submit New Folder
async function submitNewFolder() {
  const nameInput = document.getElementById('newFolderNameInput');
  const name = nameInput.value.trim();
  if (!name) return;

  try {
    const res = await fetch('/api/mkdir', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': currentSession.sessionId
      },
      body: JSON.stringify({ name })
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    nameInput.value = '';
    closeModal('newFolderModal');
    showToast('Klasör oluşturuldu.', 'success');
    refreshFiles();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Submit New File
async function submitNewFile() {
  const nameInput = document.getElementById('newFileNameInput');
  const name = nameInput.value.trim();
  if (!name) return;

  const filePath = (currentPath === '/' ? '' : currentPath) + '/' + name;

  try {
    const res = await fetch('/api/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': currentSession.sessionId
      },
      body: JSON.stringify({ path: filePath, content: '' })
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    nameInput.value = '';
    closeModal('newFileModal');
    showToast('Dosya oluşturuldu.', 'success');
    refreshFiles();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Rename File/Folder
function openRenameModal(oldName) {
  document.getElementById('renameOldPath').value = oldName;
  document.getElementById('renameNewNameInput').value = oldName;
  openModal('renameModal');
}

async function submitRename() {
  const oldName = document.getElementById('renameOldPath').value;
  const newName = document.getElementById('renameNewNameInput').value.trim();
  if (!newName || oldName === newName) {
    closeModal('renameModal');
    return;
  }

  try {
    const res = await fetch('/api/rename', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': currentSession.sessionId
      },
      body: JSON.stringify({ oldPath: oldName, newPath: newName })
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    closeModal('renameModal');
    showToast('Yeniden adlandırıldı.', 'success');
    refreshFiles();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Chmod Permissions Modal
function openChmodModal(name) {
  document.getElementById('chmodFilePath').value = name;
  // default 755
  document.getElementById('perm_o_r').checked = true;
  document.getElementById('perm_o_w').checked = true;
  document.getElementById('perm_o_x').checked = true;
  document.getElementById('perm_g_r').checked = true;
  document.getElementById('perm_g_w').checked = false;
  document.getElementById('perm_g_x').checked = true;
  document.getElementById('perm_w_r').checked = true;
  document.getElementById('perm_w_w').checked = false;
  document.getElementById('perm_w_x').checked = true;
  calcChmod();
  openModal('chmodModal');
}

function calcChmod() {
  const o_r = document.getElementById('perm_o_r').checked ? 4 : 0;
  const o_w = document.getElementById('perm_o_w').checked ? 2 : 0;
  const o_x = document.getElementById('perm_o_x').checked ? 1 : 0;
  const owner = o_r + o_w + o_x;

  const g_r = document.getElementById('perm_g_r').checked ? 4 : 0;
  const g_w = document.getElementById('perm_g_w').checked ? 2 : 0;
  const g_x = document.getElementById('perm_g_x').checked ? 1 : 0;
  const group = g_r + g_w + g_x;

  const w_r = document.getElementById('perm_w_r').checked ? 4 : 0;
  const w_w = document.getElementById('perm_w_w').checked ? 2 : 0;
  const w_x = document.getElementById('perm_w_x').checked ? 1 : 0;
  const world = w_r + w_w + w_x;

  document.getElementById('chmodOctalInput').value = `${owner}${group}${world}`;
}

async function submitChmod() {
  const filePath = document.getElementById('chmodFilePath').value;
  const mode = document.getElementById('chmodOctalInput').value.trim();

  try {
    const res = await fetch('/api/chmod', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': currentSession.sessionId
      },
      body: JSON.stringify({ path: filePath, mode })
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    closeModal('chmodModal');
    showToast('İzinler güncellendi.', 'success');
    refreshFiles();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Delete Item
async function deleteItem(name, isDirectory) {
  const typeText = isDirectory ? 'klasörünü ve içindeki tüm dosyaları' : 'dosyasını';
  if (!confirm(`"${name}" ${typeText} silmek istediğinize emin misiniz?`)) {
    return;
  }

  try {
    const res = await fetch('/api/delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': currentSession.sessionId
      },
      body: JSON.stringify({ path: name, isDirectory })
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showToast('Öğe silindi.', 'success');
    refreshFiles();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// File & Folder Upload with Progress and Hierarchy Support
function handleFileUpload(e) {
  const files = e.target.files;
  if (!files || files.length === 0) return;
  const items = Array.from(files).map(f => ({ file: f, relativePath: f.name }));
  uploadItems(items);
  e.target.value = '';
}

function handleFolderUpload(e) {
  const files = e.target.files;
  if (!files || files.length === 0) return;
  const items = Array.from(files).map(f => ({
    file: f,
    relativePath: f.webkitRelativePath || f.name
  }));
  uploadItems(items);
  e.target.value = '';
}

// Upload Items in safe batches (handles folders, nested paths, and avoids Cloud Run 32MB payload limit)
async function uploadItems(items) {
  if (!currentSession || !items || items.length === 0) return;

  const progressBar = document.getElementById('uploadProgressBar');
  const progressFill = document.getElementById('uploadProgressFill');
  const percentText = document.getElementById('uploadPercent');
  const statusText = document.getElementById('uploadStatusText');

  progressBar.classList.remove('hidden');
  progressFill.style.width = '0%';
  percentText.innerText = '0%';

  const totalFiles = items.length;
  let uploadedCount = 0;
  const BATCH_SIZE = 10; // Batch size

  try {
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      const formData = new FormData();
      const relativePaths = [];

      for (const item of batch) {
        formData.append('files', item.file);
        relativePaths.push(item.relativePath);
      }
      formData.append('paths', JSON.stringify(relativePaths));

      statusText.innerText = `Yükleniyor: ${uploadedCount + 1}-${Math.min(uploadedCount + batch.length, totalFiles)} / ${totalFiles}`;

      const res = await fetch('/api/upload', {
        method: 'POST',
        headers: {
          'x-session-id': currentSession.sessionId
        },
        body: formData
      });

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Yükleme sırasında hata oluştu.');
      }

      uploadedCount += batch.length;
      const percent = Math.round((uploadedCount / totalFiles) * 100);
      progressFill.style.width = `${percent}%`;
      percentText.innerText = `${percent}%`;
    }

    showToast(`${totalFiles} dosya/öğe başarıyla yüklendi.`, 'success');
    refreshFiles();
  } catch (err) {
    showToast(`Yükleme hatası: ${err.message}`, 'error');
  } finally {
    setTimeout(() => {
      progressBar.classList.add('hidden');
    }, 1200);
  }
}

// Drag & Drop Setup (Handles both files and deeply nested folders)
function setupDragAndDrop() {
  const container = document.body;
  const overlay = document.getElementById('dragDropOverlay');
  let dragCounter = 0;

  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    container.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
    }, false);
  });

  container.addEventListener('dragenter', (e) => {
    if (!currentSession) return;
    dragCounter++;
    overlay.classList.remove('hidden');
  });

  container.addEventListener('dragleave', (e) => {
    if (!currentSession) return;
    dragCounter--;
    if (dragCounter <= 0) {
      overlay.classList.add('hidden');
      dragCounter = 0;
    }
  });

  container.addEventListener('drop', async (e) => {
    if (!currentSession) return;
    dragCounter = 0;
    overlay.classList.add('hidden');

    const dt = e.dataTransfer;
    if (dt.items && dt.items.length > 0) {
      showToast('Sürüklenen klasör ve dosyalar taranıyor...', 'info');
      const items = await scanDataTransferItems(dt.items);
      if (items.length > 0) {
        uploadItems(items);
      } else {
        showToast('Yüklenecek dosya bulunamadı.', 'error');
      }
    } else if (dt.files && dt.files.length > 0) {
      const items = Array.from(dt.files).map(f => ({ file: f, relativePath: f.name }));
      uploadItems(items);
    }
  });
}

// Recursively scan FileSystemEntry for folder trees
async function scanDataTransferItems(items) {
  const fileItems = [];

  async function traverseEntry(entry, currentPath = '') {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => {
        entry.file(resolve, reject);
      });
      const relativePath = currentPath ? `${currentPath}/${file.name}` : file.name;
      fileItems.push({ file, relativePath });
    } else if (entry.isDirectory) {
      const dirReader = entry.createReader();
      const nextPath = currentPath ? `${currentPath}/${entry.name}` : entry.name;

      const readEntries = async () => {
        const entries = await new Promise((resolve, reject) => {
          dirReader.readEntries(resolve, reject);
        });
        if (entries.length > 0) {
          for (const subEntry of entries) {
            await traverseEntry(subEntry, nextPath);
          }
          await readEntries(); // Chrome/WebKit returns chunks of up to 100 entries; repeat until empty
        }
      };
      await readEntries();
    }
  }

  const entriesToScan = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.webkitGetAsEntry) {
      const entry = item.webkitGetAsEntry();
      if (entry) entriesToScan.push(entry);
    } else if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f) fileItems.push({ file: f, relativePath: f.name });
    }
  }

  for (const entry of entriesToScan) {
    await traverseEntry(entry);
  }

  return fileItems;
}

// Polling Logs from Server
function startLogPolling() {
  stopLogPolling();
  fetchLogs();
  logPollInterval = setInterval(fetchLogs, 2500);
}

function stopLogPolling() {
  if (logPollInterval) {
    clearInterval(logPollInterval);
    logPollInterval = null;
  }
}

async function fetchLogs() {
  if (!currentSession) return;
  try {
    const res = await fetch('/api/logs', {
      headers: { 'x-session-id': currentSession.sessionId }
    });
    const data = await res.json();
    if (data.success && data.logs) {
      renderLogs(data.logs);
    }
  } catch (e) {
    // ignore
  }
}

function renderLogs(logs) {
  const container = document.getElementById('logOutput');
  const countBadge = document.getElementById('logCountBadge');
  countBadge.innerText = `${logs.length} kayıt`;

  if (logs.length === 0) {
    container.innerHTML = `<div class="text-slate-500">[Sistem hazır] FTP bağlantısı kuruldu.</div>`;
    return;
  }

  container.innerHTML = logs.map(l => {
    let colorClass = 'text-slate-400';
    let prefix = 'DURUM:';

    if (l.type === 'command') {
      colorClass = 'text-sky-400 font-semibold';
      prefix = 'KOMUT:';
    } else if (l.type === 'success') {
      colorClass = 'text-emerald-400';
      prefix = 'BAŞARILI:';
    } else if (l.type === 'error') {
      colorClass = 'text-rose-400 font-bold';
      prefix = 'HATA:';
    }

    return `<div class="${colorClass}"><span class="text-slate-600">[${l.timestamp}]</span> <span class="text-slate-500">${prefix}</span> ${escapeHtml(l.message)}</div>`;
  }).join('');

  container.scrollTop = container.scrollHeight;
}

function clearLogs() {
  document.getElementById('logOutput').innerHTML = `<div class="text-slate-500">[Temizlendi]</div>`;
  document.getElementById('logCountBadge').innerText = '0 kayıt';
}

function toggleConsoleHeight() {
  const container = document.getElementById('logConsoleContainer');
  const icon = document.getElementById('consoleToggleIcon');
  if (container.style.height === '260px') {
    container.style.height = '120px';
    icon.className = 'fa-solid fa-chevron-up';
  } else {
    container.style.height = '260px';
    icon.className = 'fa-solid fa-chevron-down';
  }
}

// Bookmarks / Saved Servers
function loadBookmarks() {
  const listEl = document.getElementById('bookmarksList');
  const raw = localStorage.getItem('cloudftp_bookmarks');
  let bookmarks = [];
  try {
    bookmarks = raw ? JSON.parse(raw) : [];
  } catch (e) {
    bookmarks = [];
  }

  if (bookmarks.length === 0) {
    listEl.innerHTML = `<div class="text-center py-4 text-xs text-slate-500">Henüz kayıtlı bir FTP sunucusu yok.</div>`;
    return;
  }

  listEl.innerHTML = bookmarks.map((b, index) => `
    <div class="flex items-center justify-between p-2.5 bg-slate-950 rounded-xl border border-slate-800 hover:border-slate-700 transition">
      <div class="cursor-pointer flex-grow" onclick="useBookmark(${index})">
        <div class="font-bold text-xs text-white flex items-center gap-1.5">
          <i class="fa-solid fa-server text-sky-400 text-[10px]"></i>
          ${escapeHtml(b.name)}
        </div>
        <div class="text-[11px] text-slate-400 font-mono mt-0.5">
          ${escapeHtml(b.user)}@${escapeHtml(b.host)}:${b.port}
        </div>
      </div>
      <div class="flex items-center gap-1">
        <button onclick="useBookmark(${index})" class="px-2.5 py-1 rounded bg-sky-600/30 hover:bg-sky-600 text-sky-300 hover:text-white text-[11px] font-medium transition">
          Doldur
        </button>
        <button onclick="deleteBookmark(${index})" class="p-1 rounded text-slate-500 hover:text-rose-400 hover:bg-slate-900 transition">
          <i class="fa-solid fa-trash-can text-xs"></i>
        </button>
      </div>
    </div>
  `).join('');
}

function saveCurrentBookmark() {
  const nameInput = document.getElementById('bookmarkNameInput');
  const name = nameInput.value.trim() || 'FTP Sunucusu';
  const host = document.getElementById('hostInput').value.trim();
  const port = document.getElementById('portInput').value.trim() || '21';
  const user = document.getElementById('userInput').value.trim();
  const secure = document.getElementById('secureCheck').checked;

  if (!host) {
    showToast('Lütfen önce bir sunucu adresi girin.', 'error');
    return;
  }

  let bookmarks = [];
  try {
    bookmarks = JSON.parse(localStorage.getItem('cloudftp_bookmarks') || '[]');
  } catch (e) {}

  bookmarks.push({ name, host, port, user, secure });
  localStorage.setItem('cloudftp_bookmarks', JSON.stringify(bookmarks));

  nameInput.value = '';
  loadBookmarks();
  showToast('Bağlantı kaydedildi.', 'success');
}

function useBookmark(index) {
  let bookmarks = [];
  try {
    bookmarks = JSON.parse(localStorage.getItem('cloudftp_bookmarks') || '[]');
  } catch (e) {}

  const b = bookmarks[index];
  if (!b) return;

  document.getElementById('hostInput').value = b.host;
  document.getElementById('portInput').value = b.port || 21;
  document.getElementById('userInput').value = b.user || '';
  document.getElementById('secureCheck').checked = b.secure || false;
  document.getElementById('passwordInput').focus();

  closeModal('bookmarksModal');
  showToast(`"${b.name}" bilgileri forma aktarıldı.`, 'info');
}

function deleteBookmark(index) {
  let bookmarks = [];
  try {
    bookmarks = JSON.parse(localStorage.getItem('cloudftp_bookmarks') || '[]');
  } catch (e) {}

  bookmarks.splice(index, 1);
  localStorage.setItem('cloudftp_bookmarks', JSON.stringify(bookmarks));
  loadBookmarks();
  showToast('Kayıt silindi.', 'info');
}

// Helper: DLPTest FTP Credentials
function loadTestFtpCredentials() {
  document.getElementById('hostInput').value = 'ftp.dlptest.com';
  document.getElementById('portInput').value = '21';
  document.getElementById('userInput').value = 'dlpuser';
  document.getElementById('passwordInput').value = 'rNrKYTX9g7z3RgJRmxWuGHbeu';
  document.getElementById('secureCheck').checked = false;
  showToast('Örnek DLPTest FTP bilgileri dolduruldu. "Hızlı Bağlan" butonuna tıklayabilirsiniz.', 'info');
}

// Sorting
function sortFiles(field) {
  if (sortField === field) {
    sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    sortField = field;
    sortDirection = 'asc';
  }

  // Update icons
  ['name', 'size', 'modifiedAt'].forEach(col => {
    const icon = document.getElementById(`sort-${col}`);
    if (col === field) {
      icon.className = `fa-solid ${sortDirection === 'asc' ? 'fa-sort-up' : 'fa-sort-down'} ml-1 text-sky-400`;
    } else {
      icon.className = 'fa-solid fa-sort ml-1 text-slate-600';
    }
  });

  renderFileList(document.getElementById('searchInput').value.trim());
}

// Modal Helpers
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// Toast Notifications
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');

  let bgClass = 'bg-slate-900 border-slate-700 text-slate-200';
  let iconClass = 'fa-circle-info text-sky-400';

  if (type === 'success') {
    bgClass = 'bg-slate-900 border-emerald-500/40 text-emerald-200';
    iconClass = 'fa-circle-check text-emerald-400';
  } else if (type === 'error') {
    bgClass = 'bg-slate-900 border-rose-500/40 text-rose-200';
    iconClass = 'fa-circle-exclamation text-rose-400';
  }

  toast.className = `pointer-events-auto flex items-center gap-2.5 px-4 py-2.5 rounded-xl border shadow-2xl text-xs font-medium transition-all duration-300 transform translate-y-2 opacity-0 ${bgClass}`;
  toast.innerHTML = `
    <i class="fa-solid ${iconClass} text-sm"></i>
    <span class="flex-grow">${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  });

  setTimeout(() => {
    toast.classList.add('opacity-0', '-translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Format Utilities
function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatPermissions(perm) {
  if (!perm) return '0755';
  const toRwx = (val) => {
    let r = val & 4 ? 'r' : '-';
    let w = val & 2 ? 'w' : '-';
    let x = val & 1 ? 'x' : '-';
    return r + w + x;
  };
  return `${toRwx(perm.user)}${toRwx(perm.group)}${toRwx(perm.world)}`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

