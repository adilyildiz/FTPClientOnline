// CloudFTP - Web FTP Client Frontend Logic

let currentSession = null;
let currentPath = '/';
let fileList = [];
window.fileList = fileList;
let sortField = 'name';
let sortDirection = 'asc';
let logPollInterval = null;
let currentEditingPath = null;
window.currentEditingSource = 'remote';
window.currentLocalEditingHandle = null;
let selectedNames = new Set();
let pendingDefaultRemoteDir = null;
let clientLogs = [];
let logsClearedAtTs = 0;

function addClientLog(type, message) {
  const ts = Date.now();
  clientLogs.push({
    ts,
    timestamp: new Date(ts).toLocaleTimeString('tr-TR'),
    type,
    message
  });
  if (clientLogs.length > 200) clientLogs.shift();
  if (!currentSession) {
    renderLogs([]);
  } else {
    fetchLogs();
  }
}

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

  // Window Drag & Drop for FileZilla XML files
  window.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) {
      e.preventDefault();
    }
  });
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    const file = e.dataTransfer.files[0];
    if (file && (file.name.toLowerCase().endsWith('.xml') || file.type === 'text/xml' || file.type === 'application/xml')) {
      e.preventDefault();
      e.stopPropagation();
      readAndProcessFileZillaXmlFile(file);
    }
  });

  // Context Menu dismiss handlers
  document.addEventListener('click', () => hideContextMenu());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideContextMenu();
  });

  // Enter key shortcuts inside quick modals
  document.getElementById('newFolderNameInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitNewFolder(); }
  });
  document.getElementById('newFileNameInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitNewFile(); }
  });
  document.getElementById('renameNewNameInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submitRename(); }
  });

  // Right-click on empty explorer table container
  document.getElementById('explorerTableContainer').addEventListener('contextmenu', (e) => {
    if (!currentSession) return;
    if (e.target.closest('tr')) return; // handled by row listener
    e.preventDefault();
    showEmptyAreaContextMenu(e);
  });

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
      if (typeof updateSyncToolbarState === 'function') updateSyncToolbarState();
      if (typeof checkAndOfferSavedMapping === 'function') await checkAndOfferSavedMapping(currentSession);
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
    if (pendingDefaultRemoteDir) {
      const targetStartDir = pendingDefaultRemoteDir;
      pendingDefaultRemoteDir = null;
      try {
        await loadDirectory(targetStartDir);
      } catch (_) {
        await loadDirectory(currentPath);
      }
    } else {
      await loadDirectory(currentPath);
    }
    startLogPolling();
    if (typeof updateSyncToolbarState === 'function') updateSyncToolbarState();
    let appliedFromBookmark = false;
    if (typeof applyPendingBookmarkMappingOnConnect === 'function') {
      appliedFromBookmark = await applyPendingBookmarkMappingOnConnect();
    }
    if (!appliedFromBookmark && typeof checkAndOfferSavedMapping === 'function') {
      await checkAndOfferSavedMapping(currentSession);
    }
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
  window.fileList = fileList;
  renderFileList();
  if (typeof syncState !== 'undefined') {
    syncState.isSyncNavigating = false;
    syncState.syncBrowsing = false;
  }
  if (typeof hideSavedMappingBanner === 'function') hideSavedMappingBanner();
  if (typeof hideSyncWarning === 'function') hideSyncWarning();
  if (typeof updateSyncToolbarState === 'function') updateSyncToolbarState();
  if (typeof refreshComparisonAndRender === 'function') refreshComparisonAndRender();
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
async function loadDirectory(path, options = { triggerSync: false }) {
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
    window.fileList = fileList;
    clearSelection();

    renderBreadcrumb(currentPath);
    if (typeof computeComparison === 'function') computeComparison();
    renderFileList(document.getElementById('searchInput')?.value.trim() || '');
    if (typeof renderLocalFileList === 'function') {
      renderLocalFileList(document.getElementById('localSearchInput')?.value.trim() || '');
    }

    if (options.triggerSync && typeof onRemoteNavigatedForSync === 'function') {
      await onRemoteNavigatedForSync(currentPath);
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    refreshIcon.classList.remove('fa-spin');
  }
}

// Refresh Directory
async function refreshFiles() {
  await loadDirectory(currentPath, { triggerSync: false });
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
    await loadDirectory(currentPath, { triggerSync: true });
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
  const mappedRoot = (typeof syncState !== 'undefined' && syncState.mapped) ? syncState.remoteBasePath : null;
  const isRootMapped = mappedRoot === '/';

  if (!path || path === '/') {
    bar.innerHTML = `
      <button onclick="changeDirectory('/')" class="text-sky-400 hover:text-sky-300 font-bold flex items-center gap-1">
        <i class="fa-solid fa-house text-xs"></i> / (root)${isRootMapped ? ' <i class="fa-solid fa-anchor text-amber-400 text-[9px] ml-0.5" title="Eşleme Kökü"></i>' : ''}
      </button>`;
    return;
  }

  const parts = path.split('/').filter(Boolean);
  let accumulated = '';
  let html = `
    <button onclick="changeDirectory('/')" class="text-sky-400 hover:text-sky-300 font-bold flex items-center gap-1">
      <i class="fa-solid fa-house text-xs"></i> /${isRootMapped ? ' <i class="fa-solid fa-anchor text-amber-400 text-[9px]" title="Eşleme Kökü"></i>' : ''}
    </button>`;

  parts.forEach((part, idx) => {
    accumulated += '/' + part;
    const isLast = idx === parts.length - 1;
    const clickPath = accumulated;
    const isMapped = mappedRoot === clickPath;

    html += `<span class="text-slate-600">/</span>`;
    if (isLast) {
      html += `<span class="text-slate-100 font-bold px-1 py-0.5 rounded bg-slate-800">${escapeHtml(part)}${isMapped ? ' <i class="fa-solid fa-anchor text-amber-400 text-[9px] ml-0.5" title="Eşleme Kökü"></i>' : ''}</span>`;
    } else {
      html += `<button onclick="changeDirectory('${escapeAttrArg(clickPath)}')" class="text-slate-300 hover:text-sky-400 hover:underline px-1">${escapeHtml(part)}${isMapped ? ' <i class="fa-solid fa-anchor text-amber-400 text-[9px]" title="Eşleme Kökü"></i>' : ''}</button>`;
    }
  });

  bar.innerHTML = html;
}

function renderRemotePlaceholderRow(tbody, name = '') {
  const tr = document.createElement('tr');
  tr.className = 'h-9 border-b border-slate-800/25 bg-slate-950/20 comparison-placeholder pointer-events-none select-none';
  tr.setAttribute('data-placeholder', 'true');
  tr.innerHTML = `
    <td class="h-9 py-0 pl-3 pr-1 w-7 text-center">&nbsp;</td>
    <td class="h-9 py-0 px-2 text-slate-600/40 text-[11px] font-mono italic">&nbsp;</td>
    <td class="h-9 py-0 px-2 w-20 text-right text-slate-600/40 text-[11px] font-mono">&nbsp;</td>
    <td class="h-9 py-0 px-2 w-24 hidden 2xl:table-cell text-center">&nbsp;</td>
    <td class="h-9 py-0 px-2 w-32 hidden xl:table-cell text-slate-600/40 text-[11px]">&nbsp;</td>
    <td class="h-9 py-0 px-2 w-36 text-right">&nbsp;</td>
  `;
  tbody.appendChild(tr);
}

function renderRemoteRow(tbody, file, localWritable) {
  const tr = document.createElement('tr');
  const isSelected = selectedNames.has(file.name);
  const cmp = typeof getRemoteComparisonInfo === 'function' ? getRemoteComparisonInfo(file.name) : null;
  const cmpRowClass = cmp ? cmp.rowClass : '';

  tr.className = `${isSelected ? 'bg-sky-950/40' : (cmpRowClass || 'hover:bg-slate-800/40')} h-9 border-b border-slate-800/40 transition group`;

  const iconHtml = getFileIcon(file);
  const sizeStr = file.isDirectory ? '-' : formatBytes(file.size);
  const dateStr = file.modifiedAt
    ? new Date(file.modifiedAt).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
    : (file.rawModifiedAt || '-');
  const permBadge = formatPermissions(file.permissions);
  const cmpBadge = cmp && cmp.badgeHtml ? cmp.badgeHtml : '';
  const safeName = escapeHtml(file.name);
  const safeArg = escapeAttrArg(file.name);

  tr.innerHTML = `
    <td class="pl-3 pr-1 align-middle text-center">
      <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="toggleRowSelection('${safeArg}', this)"
        class="row-checkbox rounded bg-slate-800 border-slate-700 text-sky-500 focus:ring-0 cursor-pointer">
    </td>
    <td class="px-2 align-middle">
      <div class="flex items-center gap-2 overflow-hidden min-w-0">
        <span class="drag-source inline-flex items-center gap-2 min-w-0" draggable="true">
          ${iconHtml}
          <span class="remote-name-link truncate font-medium ${file.isDirectory ? 'text-sky-300 font-semibold cursor-pointer hover:underline' : 'text-slate-200 cursor-pointer hover:text-white'}"
            title="${safeName}">
            ${safeName}
          </span>
        </span>
        ${cmpBadge}
      </div>
    </td>
    <td class="px-2 align-middle text-right text-slate-400 font-mono text-[11px] whitespace-nowrap">${sizeStr}</td>
    <td class="px-2 align-middle text-center hidden 2xl:table-cell whitespace-nowrap">
      <span class="inline-block px-1.5 py-1 rounded text-[10px] leading-none whitespace-nowrap bg-slate-800/80 text-slate-300 border border-slate-700/60 font-mono">${permBadge}</span>
    </td>
    <td class="px-2 align-middle text-slate-400 text-[11px] whitespace-nowrap hidden xl:table-cell">${dateStr}</td>
    <td class="px-2 align-middle text-right whitespace-nowrap">
      <div class="inline-flex items-center gap-0.5 opacity-80 group-hover:opacity-100 transition">
        ${localWritable ? `
          <button onclick="downloadRemoteItemToLocal('${safeArg}', ${file.isDirectory})" title="Eşleşen Yerel Klasöre İndir" class="w-6 h-6 rounded hover:bg-slate-700 text-emerald-400 hover:text-emerald-300 flex items-center justify-center transition">
            <i class="fa-solid fa-arrow-left text-[11px]"></i>
          </button>
        ` : ''}
        ${file.isDirectory ? `
          <button onclick="downloadFolderAsZip('${safeArg}')" title="ZIP Olarak İndir" class="w-6 h-6 rounded hover:bg-slate-700 text-slate-300 hover:text-amber-400 flex items-center justify-center transition">
            <i class="fa-solid fa-file-zipper text-[11px]"></i>
          </button>
        ` : `
          <button onclick="downloadFile('${safeArg}')" title="İndir" class="w-6 h-6 rounded hover:bg-slate-700 text-slate-300 hover:text-emerald-400 flex items-center justify-center transition">
            <i class="fa-solid fa-download text-[11px]"></i>
          </button>
          <button onclick="openFilePreview('${safeArg}')" title="Görüntüle / Düzenle" class="w-6 h-6 rounded hover:bg-slate-700 text-slate-300 hover:text-sky-400 flex items-center justify-center transition">
            <i class="fa-solid fa-pen-to-square text-[11px]"></i>
          </button>
        `}
        <button onclick="openRenameModal('${safeArg}')" title="Yeniden Adlandır" class="w-6 h-6 rounded hover:bg-slate-700 text-slate-300 hover:text-amber-400 flex items-center justify-center transition">
          <i class="fa-solid fa-pen text-[11px]"></i>
        </button>
        <button onclick="openChmodModal('${safeArg}')" title="İzinler (CHMOD)" class="w-6 h-6 rounded hover:bg-slate-700 text-slate-300 hover:text-purple-400 flex items-center justify-center transition">
          <i class="fa-solid fa-key text-[11px]"></i>
        </button>
        <button onclick="deleteItem('${safeArg}', ${file.isDirectory})" title="Sil" class="w-6 h-6 rounded hover:bg-rose-950/40 text-slate-400 hover:text-rose-400 flex items-center justify-center transition">
          <i class="fa-solid fa-trash-can text-[11px]"></i>
        </button>
      </div>
    </td>
  `;

  // Drag only from icon/name handle (allows marquee box selection on empty row/cell areas)
  tr.querySelector('.drag-source')?.addEventListener('dragstart', (e) => {
    const names = (selectedNames.has(file.name) && selectedNames.size > 1)
      ? Array.from(selectedNames)
      : [file.name];
    e.dataTransfer.setData('application/x-cloudftp-remote', JSON.stringify({
      multiple: names.length > 1,
      names,
      name: file.name,
      isDirectory: file.isDirectory
    }));
    e.dataTransfer.effectAllowed = 'copy';
  });

  // Row click: click on row text to enter folder or view file
  tr.querySelector('.remote-name-link')?.addEventListener('click', () => {
    if (file.isDirectory) {
      changeDirectory(file.name);
    } else {
      openFilePreview(file.name);
    }
  });

  // Right-click context menu on row
  tr.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e, file);
  });

  tbody.appendChild(tr);
}

// Render File Table
function renderFileList(filterQuery = '') {
  const tbody = document.getElementById('fileListBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const isComparing = typeof syncState !== 'undefined' && syncState.compareEnabled && typeof localState !== 'undefined' && localState.provider && currentSession;
  if (isComparing && typeof getAlignedComparisonSlots === 'function') {
    const localQuery = document.getElementById('localSearchInput')?.value.trim() || '';
    const aligned = getAlignedComparisonSlots(localQuery, filterQuery);
    if (!aligned || aligned.slots.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="py-8 text-center text-slate-500 font-sans">
            <i class="fa-regular fa-folder-open text-2xl mb-2 block text-slate-600"></i>
            ${syncState.compareDiffOnly ? 'Bu dizinde fark bulunamadı.' : 'Bu klasörde görüntülenecek dosya yok.'}
          </td>
        </tr>`;
      if (typeof syncComparisonRerender === 'function') syncComparisonRerender('remote');
      return;
    }

    const localWritable = typeof canWriteToLocal === 'function' && canWriteToLocal();
    aligned.slots.forEach(slot => {
      const file = slot.type === 'dir' ? aligned.remoteDirMap.get(slot.name) : aligned.remoteFileMap.get(slot.name);
      if (file) {
        renderRemoteRow(tbody, file, localWritable);
      } else {
        renderRemotePlaceholderRow(tbody, slot.name);
      }
    });

    if (typeof syncComparisonRerender === 'function') syncComparisonRerender('remote');
    return;
  }

  let filtered = [...fileList];
  if (filterQuery) {
    filtered = filtered.filter(f => f.name.toLowerCase().includes(filterQuery.toLowerCase()));
  }

  if (typeof shouldHideRemoteInDiffOnly === 'function') {
    filtered = filtered.filter(f => !shouldHideRemoteInDiffOnly(f.name));
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
        <td colspan="6" class="py-8 text-center text-slate-500 font-sans">
          <i class="fa-regular fa-folder-open text-2xl mb-2 block text-slate-600"></i>
          ${typeof syncState !== 'undefined' && syncState.compareEnabled && syncState.compareDiffOnly ? 'Bu dizinde fark bulunamadı.' : 'Bu klasörde görüntülenecek dosya yok.'}
        </td>
      </tr>`;
    return;
  }

  const localWritable = typeof canWriteToLocal === 'function' && canWriteToLocal();
  filtered.forEach(file => {
    renderRemoteRow(tbody, file, localWritable);
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
  window.currentEditingSource = 'remote';
  window.currentLocalEditingHandle = null;
  currentEditingPath = filePath;
  document.getElementById('editorFilename').innerText = filename;
  document.getElementById('editorFilesize').innerText = 'Yükleniyor...';
  const badge = document.getElementById('editorSourceBadge');
  if (badge) {
    badge.innerText = 'Uzak FTP';
    badge.className = 'text-[10px] px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-500/30';
  }
  const saveBtn = document.getElementById('editorSaveBtn');
  if (saveBtn) saveBtn.disabled = false;
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

// Save Editor Content back to FTP or Local Folder
async function saveEditorContent() {
  const saveBtn = document.getElementById('editorSaveBtn');
  const originalHtml = saveBtn.innerHTML;
  const content = document.getElementById('editorTextarea').value;

  if (window.currentEditingSource === 'local') {
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Kaydediliyor...';
    try {
      await saveLocalEditorContent(content);
      showToast('Dosya yerel klasöre kaydedildi.', 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      saveBtn.disabled = false;
      saveBtn.innerHTML = originalHtml;
    }
    return;
  }

  if (!currentSession || !currentEditingPath) return;

  saveBtn.disabled = true;
  saveBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Kaydediliyor...';

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
async function uploadItems(rawItems) {
  if (!currentSession || !rawItems || rawItems.length === 0) return;

  // FileZilla-style conflict pre-check and overwrite resolution
  let items = rawItems;
  try {
    items = await resolveConflicts(rawItems);
  } catch (err) {
    if (err.message === 'cancelled') {
      showToast('Yükleme işlemi iptal edildi.', 'info');
      return;
    }
    console.error('Çakışma denetimi hatası:', err);
  }

  if (!items || items.length === 0) {
    showToast('Tüm çakışan dosyalar atlandı veya yüklenecek dosya kalmadı.', 'info');
    return;
  }

  const progressBar = document.getElementById('uploadProgressBar');
  const progressFill = document.getElementById('uploadProgressFill');
  const percentText = document.getElementById('uploadPercent');
  const statusText = document.getElementById('uploadStatusText');

  progressBar.classList.remove('hidden');
  progressFill.style.width = '0%';
  percentText.innerText = '0%';

  const totalFiles = items.length;
  let uploadedCount = 0;
  const MAX_FILES_PER_BATCH = 10;
  const MAX_BYTES_PER_BATCH = 20 * 1024 * 1024; // Avoid Cloud Run 32MB limit

  const batches = [];
  let currentBatch = [];
  let currentBatchBytes = 0;
  for (const item of items) {
    const fileSize = item.file?.size || 0;
    if (
      currentBatch.length >= MAX_FILES_PER_BATCH ||
      (currentBatch.length > 0 && currentBatchBytes + fileSize > MAX_BYTES_PER_BATCH)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBatchBytes = 0;
    }
    currentBatch.push(item);
    currentBatchBytes += fileSize;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  try {
    for (const batch of batches) {
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

// FileZilla-style Overwrite / Conflict Resolution Helper
async function resolveConflicts(items) {
  if (!items || items.length === 0) return items;

  try {
    const res = await fetch('/api/check-exists', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': currentSession.sessionId
      },
      body: JSON.stringify({ paths: items.map(i => i.relativePath) })
    });

    const data = await res.json();
    if (!data.success || !data.conflicts || data.conflicts.length === 0) {
      return items; // No conflicts found! Proceed directly.
    }

    const conflicts = data.conflicts;
    let rememberedAction = null;
    const finalItems = [];
    const allPaths = items.map(i => i.relativePath);

    for (let k = 0; k < conflicts.length; k++) {
      const conflict = conflicts[k];
      const sourceItem = items.find(i => i.relativePath === conflict.relativePath);
      if (!sourceItem) continue;

      let action = rememberedAction;

      if (!action) {
        // Prompt user with FileZilla Overwrite Modal
        const result = await promptOverwriteModal(conflict, sourceItem, k + 1, conflicts.length);
        if (result.applyToAll) {
          rememberedAction = result.type;
        }
        action = result.type;
      }

      // Process action
      if (action === 'skip') {
        // Skip file
        continue;
      } else if (action === 'overwrite') {
        finalItems.push(sourceItem);
      } else if (action === 'overwrite_diff') {
        const sizeDiff = sourceItem.file.size !== conflict.size;
        const dateDiff = conflict.modifiedAt && sourceItem.file.lastModified
          ? Math.abs(sourceItem.file.lastModified - new Date(conflict.modifiedAt).getTime()) > 60000
          : false;
        if (sizeDiff || dateDiff) {
          finalItems.push(sourceItem);
        } else {
          console.log(`Boyut ve tarih aynı olduğu için atlandı: ${sourceItem.relativePath}`);
        }
      } else if (action === 'rename') {
        const newRelPath = getRenamedPath(sourceItem.relativePath, allPaths);
        allPaths.push(newRelPath);
        finalItems.push({
          file: sourceItem.file,
          relativePath: newRelPath
        });
      }
    }

    // Include all items that had NO conflicts
    const conflictRelPaths = new Set(conflicts.map(c => c.relativePath));
    for (const item of items) {
      if (!conflictRelPaths.has(item.relativePath)) {
        finalItems.push(item);
      }
    }

    return finalItems;
  } catch (err) {
    if (err.message === 'cancelled') throw err;
    console.error('Conflict check error:', err);
    return items;
  }
}

// Show FileZilla-style Overwrite Modal and await user decision
function promptOverwriteModal(conflict, sourceItem, currentNum, totalNum, direction = 'upload') {
  return new Promise((resolve, reject) => {
    const modal = document.getElementById('overwriteModal');
    const filenameEl = document.getElementById('overwriteFilename');
    const locationTextEl = document.getElementById('overwriteLocationText');
    const targetIconEl = document.getElementById('overwriteTargetIcon');
    const targetLabelEl = document.getElementById('overwriteTargetLabel');
    const sourceIconEl = document.getElementById('overwriteSourceIcon');
    const sourceLabelEl = document.getElementById('overwriteSourceLabel');
    const badgeEl = document.getElementById('overwriteCounterBadge');
    const targetSizeEl = document.getElementById('targetFileSize');
    const targetDateEl = document.getElementById('targetFileDate');
    const sourceSizeEl = document.getElementById('sourceFileSize');
    const sourceDateEl = document.getElementById('sourceFileDate');
    const confirmBtn = document.getElementById('overwriteConfirmBtn');
    const cancelBtn = document.getElementById('overwriteCancelQueueBtn');
    const applyToAllCheck = document.getElementById('overwriteApplyToAll');

    if (direction === 'download') {
      if (locationTextEl) locationTextEl.innerText = 'hedef yerel klasörde zaten mevcut.';
      if (targetIconEl) targetIconEl.className = 'fa-solid fa-laptop text-rose-400';
      if (targetLabelEl) targetLabelEl.innerText = 'Mevcut Yerel Dosya (Hedef)';
      if (sourceIconEl) sourceIconEl.className = 'fa-solid fa-server text-sky-400';
      if (sourceLabelEl) sourceLabelEl.innerText = 'Uzak FTP Dosyası (Kaynak)';
    } else {
      if (locationTextEl) locationTextEl.innerText = 'hedef FTP dizininde zaten mevcut.';
      if (targetIconEl) targetIconEl.className = 'fa-solid fa-server text-rose-400';
      if (targetLabelEl) targetLabelEl.innerText = 'Mevcut Dosya (Hedef)';
      if (sourceIconEl) sourceIconEl.className = 'fa-solid fa-cloud-arrow-up text-emerald-400';
      if (sourceLabelEl) sourceLabelEl.innerText = 'Yeni Dosya (Kaynak)';
    }

    filenameEl.innerText = conflict.relativePath;
    badgeEl.innerText = `${currentNum} / ${totalNum}`;
    targetSizeEl.innerText = formatBytes(conflict.size);
    targetDateEl.innerText = conflict.modifiedAt ? new Date(conflict.modifiedAt).toLocaleString('tr-TR') : '-';
    sourceSizeEl.innerText = formatBytes(sourceItem.file.size);
    sourceDateEl.innerText = new Date(sourceItem.file.lastModified).toLocaleString('tr-TR');

    // Reset default checkbox
    applyToAllCheck.checked = false;

    modal.classList.remove('hidden');

    function cleanup() {
      modal.classList.add('hidden');
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
    }

    function onConfirm() {
      const selectedRadio = document.querySelector('input[name="overwriteAction"]:checked');
      const actionType = selectedRadio ? selectedRadio.value : 'overwrite';
      const applyToAll = applyToAllCheck.checked;
      cleanup();
      resolve({ type: actionType, applyToAll });
    }

    function onCancel() {
      cleanup();
      reject(new Error('cancelled'));
    }

    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
  });
}

// Generate unique renamed path e.g. "image (1).png"
function getRenamedPath(originalRelPath, existingPaths) {
  const parts = originalRelPath.split('/');
  const filename = parts.pop();
  const dir = parts.join('/');
  const dotIndex = filename.lastIndexOf('.');
  const baseName = dotIndex !== -1 ? filename.substring(0, dotIndex) : filename;
  const ext = dotIndex !== -1 ? filename.substring(dotIndex) : '';

  let counter = 1;
  let candidate = dir ? `${dir}/${baseName} (${counter})${ext}` : `${baseName} (${counter})${ext}`;
  while (existingPaths.includes(candidate)) {
    counter++;
    candidate = dir ? `${dir}/${baseName} (${counter})${ext}` : `${baseName} (${counter})${ext}`;
  }
  return candidate;
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

  const isInternalDrag = (e) => {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    return Array.from(types).some(t => t === 'application/x-cloudftp-local' || t === 'application/x-cloudftp-remote');
  };

  container.addEventListener('dragenter', (e) => {
    if (!currentSession || isInternalDrag(e)) return;
    dragCounter++;
    overlay.classList.remove('hidden');
  });

  container.addEventListener('dragleave', (e) => {
    if (!currentSession || isInternalDrag(e)) return;
    dragCounter--;
    if (dragCounter <= 0) {
      overlay.classList.add('hidden');
      dragCounter = 0;
    }
  });

  container.addEventListener('drop', async (e) => {
    if (!currentSession || isInternalDrag(e)) return;
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

function renderLogs(serverLogs) {
  const container = document.getElementById('logOutput');
  const countBadge = document.getElementById('logCountBadge');

  const combined = [...(serverLogs || []), ...(clientLogs || [])]
    .filter(l => !logsClearedAtTs || !l.ts || l.ts > logsClearedAtTs)
    .sort((a, b) => (a.ts || 0) - (b.ts || 0))
    .slice(-200);

  countBadge.innerText = `${combined.length} kayıt`;

  if (combined.length === 0) {
    container.innerHTML = `<div class="text-slate-500">[Sistem hazır] ${currentSession ? 'FTP bağlantısı kuruldu.' : 'FTP bağlantısı bekleniyor...'}</div>`;
    return;
  }

  container.innerHTML = combined.map(l => {
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

    const tsStr = l.ts ? new Date(l.ts).toLocaleTimeString('tr-TR') : l.timestamp;
    return `<div class="${colorClass}"><span class="text-slate-600">[${tsStr}]</span> <span class="text-slate-500">${prefix}</span> ${escapeHtml(l.message)}</div>`;
  }).join('');

  container.scrollTop = container.scrollHeight;
}

function clearLogs() {
  logsClearedAtTs = Date.now();
  clientLogs = [];
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

// ==================== BOOKMARKS & FILEZILLA XML INTEGRATION ====================

function loadBookmarks(filterQuery = '') {
  const listEl = document.getElementById('bookmarksList');
  if (!listEl) return;
  const raw = localStorage.getItem('cloudftp_bookmarks');
  let bookmarks = [];
  try {
    bookmarks = raw ? JSON.parse(raw) : [];
  } catch (e) {
    bookmarks = [];
  }

  if (bookmarks.length === 0) {
    listEl.innerHTML = `
      <div class="text-center py-6 text-xs text-slate-500 font-sans space-y-2">
        <i class="fa-solid fa-folder-open text-2xl text-slate-600 block"></i>
        <div>Henüz kayıtlı bir FTP sunucusu yok.</div>
        <div class="text-[11px] text-slate-400">
          Yukarıdaki formu kullanarak kaydedebilir veya <button onclick="triggerFileZillaXmlUpload()" class="text-amber-400 hover:underline font-medium">FileZilla XML</button> yedeğinizi yükleyebilirsiniz.
        </div>
      </div>`;
    return;
  }

  let displayList = bookmarks.map((b, originalIndex) => ({ ...b, originalIndex }));

  if (filterQuery) {
    const q = filterQuery.toLowerCase();
    displayList = displayList.filter(b =>
      (b.name && b.name.toLowerCase().includes(q)) ||
      (b.host && b.host.toLowerCase().includes(q)) ||
      (b.user && b.user.toLowerCase().includes(q)) ||
      (b.remoteDir && b.remoteDir.toLowerCase().includes(q)) ||
      (b.filezillaFolder && b.filezillaFolder.toLowerCase().includes(q)) ||
      (b.filezillaLocalDir && b.filezillaLocalDir.toLowerCase().includes(q))
    );
  }

  if (displayList.length === 0) {
    listEl.innerHTML = `<div class="text-center py-4 text-xs text-slate-500">Aramanıza uygun kayıt bulunamadı ("${escapeHtml(filterQuery)}").</div>`;
    return;
  }

  if (typeof preloadBookmarkHandles === 'function') {
    preloadBookmarkHandles(bookmarks);
  }

  const mappingsMap = typeof getSavedMappingsMap === 'function' ? getSavedMappingsMap() : {};

  listEl.innerHTML = displayList.map(b => {
    const index = b.originalIndex;
    const connKey = `${b.user || 'anonymous'}@${b.host}:${b.port || 21}`;
    const mapped = mappingsMap[connKey];
    const localName = b.localFolderName || mapped?.localFolderName || '';
    const localBase = b.localBasePath !== undefined ? b.localBasePath : (mapped?.localBasePath || '');
    const remoteBase = b.remoteDir || mapped?.remoteBasePath || '/';
    const localDisplay = localName ? (localBase ? `${localName}/${localBase}` : localName) : (b.filezillaLocalDir || '');

    return `
      <div class="flex items-center justify-between p-2.5 bg-slate-950 rounded-xl border border-slate-800 hover:border-slate-700 transition gap-2 group">
        <div class="cursor-pointer flex-grow min-w-0" onclick="connectBookmark(${index})" title="Bu sunucuya doğrudan bağlan">
          <div class="font-bold text-xs text-white flex items-center gap-1.5 flex-wrap">
            <i class="fa-solid fa-server text-sky-400 text-[10px]"></i>
            <span class="truncate">${escapeHtml(b.name)}</span>
            ${b.filezillaFolder ? `<span class="text-[9px] px-1.5 py-0.2 rounded bg-slate-800/90 text-amber-300 font-sans border border-slate-700/60" title="FileZilla Klasörü"><i class="fa-regular fa-folder mr-1"></i>${escapeHtml(b.filezillaFolder)}</span>` : ''}
          </div>
          <div class="text-[11px] text-slate-400 font-mono mt-0.5 truncate flex items-center gap-1.5 flex-wrap">
            <span>${escapeHtml(b.user || 'anonymous')}@${escapeHtml(b.host)}:${b.port || 21}</span>
            ${b.secure ? '<span class="text-emerald-400 text-[10px] font-semibold bg-emerald-950/40 px-1 rounded border border-emerald-800/40">FTPS</span>' : '<span class="text-slate-500 text-[10px]">FTP</span>'}
            ${b.remoteDir ? `<span class="text-sky-400 text-[10px]">(${escapeHtml(b.remoteDir)})</span>` : ''}
            ${b.password ? '<span class="text-amber-400 text-[10px]" title="Şifre kayıtlı"><i class="fa-solid fa-key"></i></span>' : '<span class="text-slate-600 text-[10px]" title="Şifre girilmeli"><i class="fa-regular fa-eye-slash"></i></span>'}
          </div>
          ${localDisplay ? `
            <div class="text-[10px] text-emerald-400/90 font-mono mt-0.5 truncate">
              <i class="fa-solid fa-folder-tree mr-1"></i>Yerel: ${escapeHtml(localDisplay)} ↔ ${escapeHtml(remoteBase)}
            </div>
          ` : ''}
        </div>
        <div class="flex items-center gap-1 flex-none">
          <button onclick="connectBookmark(${index})" title="Bu Sunucuya Doğrudan Bağlan" class="px-2.5 py-1 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-[11px] font-semibold flex items-center gap-1 transition shadow-sm shadow-sky-600/30">
            <i class="fa-solid fa-bolt text-[10px]"></i>
            <span class="hidden sm:inline">Bağlan</span>
          </button>
          <button onclick="useBookmark(${index})" title="Forma Doldur (Bağlanmadan)" class="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] transition border border-slate-700">
            Doldur
          </button>
          <button onclick="attachLocalFolderToBookmark(${index})" title="Yerel Klasör Bağla / Değiştir" class="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-emerald-400 hover:text-emerald-300 transition border border-slate-800">
            <i class="fa-solid fa-folder-plus text-xs"></i>
          </button>
          <button onclick="deleteBookmark(${index})" title="Kaydı Sil" class="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-slate-900 transition">
            <i class="fa-solid fa-trash-can text-xs"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function filterBookmarksList(query) {
  loadBookmarks(query.trim());
}

async function saveCurrentBookmark() {
  const nameInput = document.getElementById('bookmarkNameInput');
  const remoteDirInput = document.getElementById('bookmarkRemoteDirInput');
  const name = nameInput.value.trim() || 'FTP Sunucusu';
  const host = document.getElementById('hostInput').value.trim();
  const port = document.getElementById('portInput').value.trim() || '21';
  const user = document.getElementById('userInput').value.trim();
  const password = document.getElementById('passwordInput')?.value || '';
  const secure = document.getElementById('secureCheck').checked;
  const remoteDir = (remoteDirInput?.value.trim()) || (typeof syncState !== 'undefined' && syncState.mapped ? syncState.remoteBasePath : '');

  if (!host) {
    showToast('Lütfen önce bir sunucu adresi girin.', 'error');
    return;
  }

  let bookmarks = [];
  try {
    bookmarks = JSON.parse(localStorage.getItem('cloudftp_bookmarks') || '[]');
  } catch (e) {}

  const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `bm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const hasPendingHandle = typeof pendingBookmarkLocalHandle !== 'undefined' && !!pendingBookmarkLocalHandle;
  const localFolderName = hasPendingHandle ? pendingBookmarkLocalName : '';
  const localBasePath = hasPendingHandle ? pendingBookmarkLocalBasePath : '';

  bookmarks.push({ id, name, host, port, user, password, secure, remoteDir, localFolderName, localBasePath });
  localStorage.setItem('cloudftp_bookmarks', JSON.stringify(bookmarks));

  if (hasPendingHandle && typeof HandlesDB !== 'undefined') {
    const connKey = `${user || 'anonymous'}@${host}:${port}`;
    await HandlesDB.save(`bookmark:${id}`, pendingBookmarkLocalHandle);
    await HandlesDB.save(connKey, pendingBookmarkLocalHandle);
    if (window.bookmarkHandlesCache) {
      window.bookmarkHandlesCache.set(`bookmark:${id}`, pendingBookmarkLocalHandle);
      window.bookmarkHandlesCache.set(connKey, pendingBookmarkLocalHandle);
    }
    const map = getSavedMappingsMap();
    map[connKey] = {
      key: connKey,
      host,
      port: parseInt(port, 10) || 21,
      user: user || 'anonymous',
      localFolderName,
      localBasePath,
      remoteBasePath: remoteDir || '/',
      syncBrowsing: true,
      compareEnabled: true,
      updatedAt: Date.now()
    };
    saveMappingsMap(map);
    if (typeof renderRecentLocalMappings === 'function') renderRecentLocalMappings();
  }

  nameInput.value = '';
  if (remoteDirInput) remoteDirInput.value = '';
  loadBookmarks();
  showToast('Bağlantı kaydedildi.', 'success');
}

async function useBookmark(index) {
  let bookmarks = [];
  try {
    bookmarks = JSON.parse(localStorage.getItem('cloudftp_bookmarks') || '[]');
  } catch (e) {}

  const b = bookmarks[index];
  if (!b) return;

  document.getElementById('hostInput').value = b.host;
  document.getElementById('portInput').value = b.port || 21;
  document.getElementById('userInput').value = b.user || '';
  document.getElementById('passwordInput').value = b.password || '';
  document.getElementById('secureCheck').checked = b.secure || false;

  const connKey = `${b.user || 'anonymous'}@${b.host}:${b.port || 21}`;
  const mappingsMap = typeof getSavedMappingsMap === 'function' ? getSavedMappingsMap() : {};
  const savedMapping = mappingsMap[connKey];
  pendingDefaultRemoteDir = b.remoteDir || savedMapping?.remoteBasePath || null;

  closeModal('bookmarksModal');
  if (!b.password) {
    document.getElementById('passwordInput').focus();
  }

  if (typeof activateBookmarkLocalMapping === 'function') {
    await activateBookmarkLocalMapping(b);
  }

  showToast(`"${b.name}" bilgileri forma aktarıldı.`, 'info');
}

async function connectBookmark(index) {
  let bookmarks = [];
  try {
    bookmarks = JSON.parse(localStorage.getItem('cloudftp_bookmarks') || '[]');
  } catch (e) {}

  const b = bookmarks[index];
  if (!b) return;

  document.getElementById('hostInput').value = b.host || '';
  document.getElementById('portInput').value = b.port || 21;
  document.getElementById('userInput').value = b.user || '';
  document.getElementById('passwordInput').value = b.password || '';
  document.getElementById('secureCheck').checked = Boolean(b.secure);

  const connKey = `${b.user || 'anonymous'}@${b.host}:${b.port || 21}`;
  const mappingsMap = typeof getSavedMappingsMap === 'function' ? getSavedMappingsMap() : {};
  const savedMapping = mappingsMap[connKey];
  pendingDefaultRemoteDir = b.remoteDir || savedMapping?.remoteBasePath || null;

  if (typeof syncState !== 'undefined') {
    if (b.syncBrowsing !== undefined) syncState.syncBrowsing = Boolean(b.syncBrowsing);
    if (b.compareEnabled !== undefined) syncState.compareEnabled = Boolean(b.compareEnabled);
  }

  closeModal('bookmarksModal');

  if (typeof activateBookmarkLocalMapping === 'function') {
    await activateBookmarkLocalMapping(b);
  }

  showToast(`"${b.name}" sunucusuna bağlanılıyor...`, 'info');
  const form = document.getElementById('connectForm');
  if (form) {
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  }
}

async function deleteBookmark(index) {
  let bookmarks = [];
  try {
    bookmarks = JSON.parse(localStorage.getItem('cloudftp_bookmarks') || '[]');
  } catch (e) {}

  const removed = bookmarks[index];
  bookmarks.splice(index, 1);
  localStorage.setItem('cloudftp_bookmarks', JSON.stringify(bookmarks));
  if (removed?.id && typeof HandlesDB !== 'undefined') {
    await HandlesDB.remove(`bookmark:${removed.id}`);
    window.bookmarkHandlesCache?.delete(`bookmark:${removed.id}`);
  }
  loadBookmarks();
  showToast('Kayıt silindi.', 'info');
}

// ==================== FILEZILLA XML PARSER, IMPORT & EXPORT ====================

function parseFileZillaRemoteDir(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (!s) return '';
  if (s.startsWith('/')) return s;

  // FileZilla serialized format: "1 0 [len] [segment] [len] [segment] ..."
  const match = s.match(/^(\d+)\s+(\d+)\s*(.*)$/);
  if (match) {
    let rest = match[3].trim();
    if (!rest) return '/';
    const segments = [];
    while (rest.length > 0) {
      const lenMatch = rest.match(/^(\d+)\s+/);
      if (!lenMatch) {
        if (rest) segments.push(rest.trim());
        break;
      }
      const len = parseInt(lenMatch[1], 10);
      const startIdx = lenMatch[0].length;
      const seg = rest.slice(startIdx, startIdx + len).trim();
      if (seg) segments.push(seg);
      rest = rest.slice(startIdx + len).trim();
    }
    return segments.length > 0 ? '/' + segments.join('/') : '/';
  }

  return s.startsWith('/') ? s : '/' + s;
}

function formatFileZillaRemoteDir(dir) {
  if (!dir || dir === '/') return '1 0';
  const clean = String(dir).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!clean) return '1 0';
  const segments = clean.split('/');
  let res = '1 0';
  for (const seg of segments) {
    if (seg) res += ` ${seg.length} ${seg}`;
  }
  return res;
}

function decodeFileZillaPassword(passNode) {
  if (!passNode) return '';
  const text = passNode.textContent?.trim() || '';
  if (!text) return '';
  const encoding = (passNode.getAttribute('encoding') || '').toLowerCase();
  if (encoding === 'base64') {
    try {
      const binary = atob(text);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
      try {
        return atob(text);
      } catch (err) {
        return text;
      }
    }
  }
  return text;
}

function encodeBase64Utf8(str) {
  if (!str) return '';
  try {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  } catch (e) {
    return btoa(str);
  }
}

function parseServerElement(el, folderPath = '') {
  const host = el.querySelector(':scope > Host')?.textContent?.trim() || el.getAttribute('Host') || '';
  if (!host) return null;

  const portStr = el.querySelector(':scope > Port')?.textContent?.trim() || el.getAttribute('Port') || '21';
  const port = parseInt(portStr, 10) || 21;

  const rawProtocol = el.querySelector(':scope > Protocol')?.textContent?.trim() || el.getAttribute('Protocol') || '0';
  // 0: FTP, 1: SFTP, 2: FTPS (explicit), 3: FTPS (implicit), 4: FTP over TLS
  const isSecure = rawProtocol === '2' || rawProtocol === '3' || rawProtocol === '4' || port === 990;
  const isSftp = rawProtocol === '1' || port === 22;

  const user = el.querySelector(':scope > User')?.textContent?.trim() || el.getAttribute('User') || '';

  const passEl = el.querySelector(':scope > Pass');
  const password = passEl ? decodeFileZillaPassword(passEl) : (el.getAttribute('Pass') || '');

  const nameTag = el.querySelector(':scope > Name')?.textContent?.trim() || el.getAttribute('Name') || '';
  const name = nameTag || host;

  const rawRemote = el.querySelector(':scope > RemoteDir')?.textContent?.trim() || '';
  const remoteDir = parseFileZillaRemoteDir(rawRemote);

  const localDir = el.querySelector(':scope > LocalDir')?.textContent?.trim() || '';
  let localFolderName = '';
  if (localDir) {
    const normalized = localDir.replace(/\\/g, '/').replace(/\/+$/, '');
    const segs = normalized.split('/');
    localFolderName = segs[segs.length - 1] || '';
  }

  const syncBrowsing = el.querySelector(':scope > SyncBrowsing')?.textContent?.trim() === '1';
  const compareEnabled = el.querySelector(':scope > DirectoryComparison')?.textContent?.trim() === '1';
  const comments = el.querySelector(':scope > Comments')?.textContent?.trim() || '';

  return {
    host,
    port,
    user,
    password,
    secure: isSecure,
    isSftp,
    name,
    remoteDir: (remoteDir === '/' ? '' : remoteDir),
    filezillaFolder: folderPath || '',
    filezillaLocalDir: localDir || '',
    localFolderName,
    syncBrowsing,
    compareEnabled,
    comments
  };
}

function parseFileZillaXml(xmlString) {
  if (!xmlString || typeof xmlString !== 'string') {
    throw new Error('XML içeriği boş.');
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, 'application/xml');
  const parserErr = doc.querySelector('parsererror');
  if (parserErr) {
    throw new Error('XML formatı geçersiz: ' + (parserErr.textContent || '').slice(0, 100));
  }

  const foundServers = [];

  function walk(node, folderPath = '') {
    const children = Array.from(node.children || []);
    for (const child of children) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'server' || tag === 'site') {
        const s = parseServerElement(child, folderPath);
        if (s) foundServers.push(s);
      } else if (tag === 'folder') {
        const folderName = child.querySelector(':scope > Name')?.textContent?.trim() || child.getAttribute('Name') || 'Klasör';
        const nextPath = folderPath ? `${folderPath} / ${folderName}` : folderName;
        walk(child, nextPath);
      } else if (tag === 'servers' || tag === 'sites' || tag === 'filezilla3' || tag === 'filezilla') {
        walk(child, folderPath);
      }
    }
  }

  walk(doc.documentElement, '');

  if (foundServers.length === 0) {
    const allServers = doc.querySelectorAll('Server, Site');
    allServers.forEach(el => {
      const s = parseServerElement(el, '');
      if (s) foundServers.push(s);
    });
  }

  return foundServers;
}

function triggerFileZillaXmlUpload() {
  const input = document.getElementById('filezillaXmlFileInput');
  if (input) {
    input.value = '';
    input.click();
  }
}

function handleFileZillaXmlUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  readAndProcessFileZillaXmlFile(file);
}

function readAndProcessFileZillaXmlFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    const xmlText = e.target.result;
    try {
      const servers = parseFileZillaXml(xmlText);
      if (servers.length === 0) {
        showToast('XML dosyasında kayıtlı bir FileZilla sunucusu bulunamadı.', 'warning');
        return;
      }
      renderFileZillaImportPreview(servers, file.name);
    } catch (err) {
      showToast('FileZilla XML ayrıştırma hatası: ' + err.message, 'error');
    }
  };
  reader.onerror = () => {
    showToast('Dosya okunamadı.', 'error');
  };
  reader.readAsText(file, 'UTF-8');
}

function renderFileZillaImportPreview(servers, fileName) {
  window.pendingFzImportServers = servers;

  const fileNameEl = document.getElementById('filezillaImportFileName');
  const summaryEl = document.getElementById('filezillaImportSummary');
  const listEl = document.getElementById('filezillaImportList');
  const selectAllCb = document.getElementById('fzSelectAllCheckbox');

  if (fileNameEl) {
    fileNameEl.innerHTML = `<i class="fa-solid fa-file-code text-amber-400"></i> ${escapeHtml(fileName || 'FileZilla.xml')}`;
  }
  if (summaryEl) {
    summaryEl.innerText = `${servers.length} adet FTP sunucusu bulundu`;
  }
  if (selectAllCb) selectAllCb.checked = true;

  if (listEl) {
    listEl.innerHTML = servers.map((s, i) => {
      return `
        <label class="flex items-start gap-2.5 p-2.5 bg-slate-950/70 hover:bg-slate-950 rounded-xl border border-slate-800/80 cursor-pointer transition">
          <input type="checkbox" class="fz-import-item-cb mt-1 rounded bg-slate-800 border-slate-700 text-amber-500 focus:ring-0 cursor-pointer" data-idx="${i}" checked onchange="updateFzImportSelectedCount()">
          <div class="flex-grow min-w-0">
            <div class="font-bold text-xs text-white flex items-center gap-1.5 flex-wrap">
              <i class="fa-solid fa-server text-sky-400 text-[10px]"></i>
              <span class="truncate">${escapeHtml(s.name)}</span>
              ${s.filezillaFolder ? `<span class="text-[9px] px-1.5 py-0.2 rounded bg-slate-800 text-amber-300 font-sans border border-slate-700/60"><i class="fa-regular fa-folder mr-1"></i>${escapeHtml(s.filezillaFolder)}</span>` : ''}
              ${s.secure ? '<span class="text-[9px] px-1.5 py-0.2 rounded bg-emerald-950 text-emerald-400 font-semibold border border-emerald-800/40">FTPS</span>' : '<span class="text-[9px] px-1 rounded text-slate-500">FTP</span>'}
              ${s.isSftp ? '<span class="text-[9px] px-1.5 py-0.2 rounded bg-indigo-950 text-indigo-300 border border-indigo-800/40">SFTP</span>' : ''}
            </div>
            <div class="text-[11px] text-slate-400 font-mono mt-0.5 truncate flex items-center gap-1.5 flex-wrap">
              <span>${escapeHtml(s.user || 'anonymous')}@${escapeHtml(s.host)}:${s.port}</span>
              ${s.remoteDir ? `<span class="text-sky-400 text-[10px]">(${escapeHtml(s.remoteDir)})</span>` : ''}
              ${s.password ? '<span class="text-amber-400 text-[10px]" title="Şifre kayıtlı"><i class="fa-solid fa-key"></i> Şifre var</span>' : '<span class="text-slate-600 text-[10px]" title="Şifre yok"><i class="fa-regular fa-eye-slash"></i> Şifresiz</span>'}
            </div>
            ${s.filezillaLocalDir ? `
              <div class="text-[10px] text-slate-500 truncate mt-0.5">
                <i class="fa-regular fa-folder mr-1"></i>${escapeHtml(s.filezillaLocalDir)}
              </div>
            ` : ''}
          </div>
        </label>
      `;
    }).join('');
  }

  updateFzImportSelectedCount();
  openModal('filezillaImportModal');
}

function toggleFzImportSelectAll(masterCb) {
  const checkboxes = document.querySelectorAll('.fz-import-item-cb');
  checkboxes.forEach(cb => {
    cb.checked = masterCb.checked;
  });
  updateFzImportSelectedCount();
}

function updateFzImportSelectedCount() {
  const checkboxes = document.querySelectorAll('.fz-import-item-cb');
  let checkedCount = 0;
  checkboxes.forEach(cb => {
    if (cb.checked) checkedCount++;
  });
  const label = document.getElementById('fzSelectedCountLabel');
  if (label) {
    label.innerText = `${checkedCount}/${checkboxes.length} seçildi`;
  }
  const submitBtn = document.getElementById('submitFzImportBtn');
  if (submitBtn) {
    submitBtn.disabled = checkedCount === 0;
    submitBtn.classList.toggle('opacity-50', checkedCount === 0);
  }
}

function executeFileZillaImport() {
  if (!window.pendingFzImportServers || window.pendingFzImportServers.length === 0) {
    closeModal('filezillaImportModal');
    return;
  }

  const checkboxes = document.querySelectorAll('.fz-import-item-cb');
  const selectedIndices = [];
  checkboxes.forEach(cb => {
    if (cb.checked) {
      const idx = parseInt(cb.dataset.idx, 10);
      if (!isNaN(idx)) selectedIndices.push(idx);
    }
  });

  if (selectedIndices.length === 0) {
    showToast('Lütfen içe aktarılacak en az bir sunucu seçin.', 'warning');
    return;
  }

  const replaceMode = document.querySelector('input[name="fzImportMode"]:checked')?.value === 'replace';

  let currentBookmarks = [];
  try {
    currentBookmarks = replaceMode ? [] : JSON.parse(localStorage.getItem('cloudftp_bookmarks') || '[]');
  } catch (e) {
    currentBookmarks = [];
  }

  const mappingsMap = typeof getSavedMappingsMap === 'function' ? getSavedMappingsMap() : {};
  let addedCount = 0;

  selectedIndices.forEach(idx => {
    const s = window.pendingFzImportServers[idx];
    if (!s) return;

    const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `fz_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const bm = {
      id,
      name: s.name,
      host: s.host,
      port: s.port,
      user: s.user,
      password: s.password || '',
      secure: s.secure,
      remoteDir: s.remoteDir || '',
      localFolderName: s.localFolderName || '',
      localBasePath: '',
      filezillaFolder: s.filezillaFolder || '',
      filezillaLocalDir: s.filezillaLocalDir || '',
      syncBrowsing: s.syncBrowsing,
      compareEnabled: s.compareEnabled,
      comments: s.comments || ''
    };

    currentBookmarks.push(bm);
    addedCount++;

    if (s.localFolderName || s.remoteDir) {
      const connKey = `${s.user || 'anonymous'}@${s.host}:${s.port || 21}`;
      if (!mappingsMap[connKey]) {
        mappingsMap[connKey] = {
          key: connKey,
          host: s.host,
          port: s.port || 21,
          user: s.user || 'anonymous',
          localFolderName: s.localFolderName || '',
          localBasePath: '',
          remoteBasePath: s.remoteDir || '/',
          syncBrowsing: s.syncBrowsing,
          compareEnabled: s.compareEnabled,
          updatedAt: Date.now()
        };
      }
    }
  });

  localStorage.setItem('cloudftp_bookmarks', JSON.stringify(currentBookmarks));
  if (typeof saveMappingsMap === 'function') {
    saveMappingsMap(mappingsMap);
  }
  if (typeof renderRecentLocalMappings === 'function') {
    renderRecentLocalMappings();
  }

  closeModal('filezillaImportModal');
  loadBookmarks();
  openModal('bookmarksModal');

  showToast(`${addedCount} adet FileZilla sunucusu başarıyla içe aktarıldı!`, 'success');
  addClientLog('system', `${addedCount} adet FileZilla sunucu kaydı içe aktarıldı.`);
}

function exportToFileZillaXml() {
  let bookmarks = [];
  try {
    bookmarks = JSON.parse(localStorage.getItem('cloudftp_bookmarks') || '[]');
  } catch (e) {}

  if (bookmarks.length === 0) {
    showToast('Dışa aktarılacak kayıtlı sunucu bulunamadı.', 'warning');
    return;
  }

  function escapeXml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  const xmlServers = bookmarks.map(b => {
    const passXml = b.password
      ? `<Pass encoding="base64">${encodeBase64Utf8(b.password)}</Pass>`
      : '<Pass/>';
    const logontype = b.password ? 1 : (b.user ? 2 : 0);
    const protocol = b.secure ? 2 : 0;
    const remoteDirStr = formatFileZillaRemoteDir(b.remoteDir);
    const localDirStr = escapeXml(b.filezillaLocalDir || (b.localFolderName ? `/${b.localFolderName}` : ''));

    return `        <Server>
            <Host>${escapeXml(b.host)}</Host>
            <Port>${b.port || 21}</Port>
            <Protocol>${protocol}</Protocol>
            <Type>0</Type>
            <User>${escapeXml(b.user || '')}</User>
            ${passXml}
            <Logontype>${logontype}</Logontype>
            <TimezoneOffset>0</TimezoneOffset>
            <PasvMode>MODE_DEFAULT</PasvMode>
            <MaximumMultipleConnections>0</MaximumMultipleConnections>
            <EncodingType>Auto</EncodingType>
            <BypassProxy>0</BypassProxy>
            <Name>${escapeXml(b.name)}</Name>
            <Comments>${escapeXml(b.comments || '')}</Comments>
            <LocalDir>${localDirStr}</LocalDir>
            <RemoteDir>${remoteDirStr}</RemoteDir>
            <SyncBrowsing>${b.syncBrowsing ? 1 : 0}</SyncBrowsing>
            <DirectoryComparison>${b.compareEnabled ? 1 : 0}</DirectoryComparison>
        </Server>`;
  }).join('\n');

  const xmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<FileZilla3 version="3.66.5" platform="windows">
    <Servers>
${xmlServers}
    </Servers>
</FileZilla3>
`;

  const blob = new Blob([xmlContent], { type: 'application/xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `FileZilla_Export_${new Date().toISOString().slice(0, 10)}.xml`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast(`${bookmarks.length} adet sunucu FileZilla XML olarak indirildi.`, 'success');
}

// Helper: Public Test FTP Server Credentials from https://dlptest.com/ftp-test/
function loadTestFtpCredentials() {
  document.getElementById('hostInput').value = 'ftp.dlptest.com';
  document.getElementById('portInput').value = '21';
  document.getElementById('userInput').value = 'dlpuser';
  document.getElementById('passwordInput').value = 'rNrKYTX9g7z3RgJRmxWuGHbeu';
  document.getElementById('secureCheck').checked = false;
  showToast('Halka açık DLPTest FTP test sunucusu bilgileri dolduruldu. "Hızlı Bağlan" butonuna tıklayabilirsiniz.', 'info');
}

// Download Folder as ZIP Archive
async function downloadFolderAsZip(folderName) {
  if (!currentSession) return;
  const folderPath = (currentPath === '/' ? '' : currentPath) + '/' + folderName;
  showToast(`"${folderName}.zip" arşivi sunucuda hazırlanıyor...`, 'info');

  try {
    const res = await fetch(`/api/download-zip?path=${encodeURIComponent(folderPath)}`, {
      headers: { 'x-session-id': currentSession.sessionId }
    });

    if (!res.ok) {
      let errMsg = 'ZIP arşivi oluşturulamadı.';
      try {
        const errData = await res.json();
        if (errData.error) errMsg = errData.error;
      } catch (e) {}
      throw new Error(errMsg);
    }

    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${folderName}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
    showToast(`"${folderName}.zip" indirildi.`, 'success');
  } catch (err) {
    showToast(`ZIP indirme hatası: ${err.message}`, 'error');
  }
}

// Multi-selection & Batch Delete Functions
function toggleRowSelection(name, checkbox) {
  if (checkbox.checked) {
    selectedNames.add(name);
  } else {
    selectedNames.delete(name);
  }
  updateBulkActionBar();
  // Highlight row visually
  const row = checkbox.closest('tr');
  if (row) {
    if (checkbox.checked) {
      row.classList.add('bg-sky-950/40');
      row.classList.remove('hover:bg-slate-800/40');
    } else {
      row.classList.remove('bg-sky-950/40');
      row.classList.add('hover:bg-slate-800/40');
    }
  }
}

function toggleSelectAll(masterCheckbox) {
  const checkboxes = document.querySelectorAll('.row-checkbox');
  selectedNames.clear();
  checkboxes.forEach(cb => {
    cb.checked = masterCheckbox.checked;
    const row = cb.closest('tr');
    const nameSpan = row?.querySelector('.remote-name-link');
    const name = nameSpan?.getAttribute('title');
    if (masterCheckbox.checked && name) {
      selectedNames.add(name);
      row.classList.add('bg-sky-950/40');
    } else if (row) {
      row.classList.remove('bg-sky-950/40');
    }
  });
  updateBulkActionBar();
}

function clearSelection() {
  selectedNames.clear();
  const masterCheckbox = document.getElementById('selectAllCheckbox');
  if (masterCheckbox) masterCheckbox.checked = false;
  document.querySelectorAll('.row-checkbox').forEach(cb => {
    cb.checked = false;
    cb.closest('tr')?.classList.remove('bg-sky-950/40');
  });
  updateBulkActionBar();
}

function updateBulkActionBar() {
  const bar = document.getElementById('bulkActionBar');
  const countText = document.getElementById('selectedCountText');
  const bulkLocalBtn = document.getElementById('bulkDownloadToLocalBtn');
  if (!bar) return;

  if (bulkLocalBtn) {
    const canWriteLocal = typeof canWriteToLocal === 'function' && canWriteToLocal();
    bulkLocalBtn.classList.toggle('hidden', !canWriteLocal);
  }

  if (selectedNames.size > 0) {
    countText.innerText = `${selectedNames.size} öğe seçildi`;
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
}

function setRemoteSelectionFromSet(newSet) {
  selectedNames = new Set(newSet);
  const tbody = document.getElementById('fileListBody');
  const master = document.getElementById('selectAllCheckbox');
  const rows = tbody ? tbody.querySelectorAll('tr') : [];
  let totalVisible = 0;
  let checkedVisible = 0;

  rows.forEach(row => {
    const cb = row.querySelector('.row-checkbox');
    const name = row.querySelector('.remote-name-link')?.getAttribute('title');
    if (!cb || !name) return;
    totalVisible++;
    const isSel = selectedNames.has(name);
    cb.checked = isSel;
    if (isSel) checkedVisible++;
    row.classList.toggle('bg-sky-950/40', isSel);
    if (isSel) row.classList.remove('hover:bg-slate-800/40');
    else row.classList.add('hover:bg-slate-800/40');
  });

  if (master) {
    master.checked = totalVisible > 0 && checkedVisible === totalVisible;
  }
  updateBulkActionBar();
}

async function deleteSelectedItems() {
  if (!currentSession || selectedNames.size === 0) return;

  if (!confirm(`Seçili ${selectedNames.size} öğeyi (ve alt klasörlerini) kalıcı olarak silmek istediğinize emin misiniz?`)) {
    return;
  }

  const itemsToDelete = [];
  selectedNames.forEach(name => {
    const fileObj = fileList.find(f => f.name === name);
    if (fileObj) {
      itemsToDelete.push({ path: fileObj.name, isDirectory: fileObj.isDirectory });
    }
  });

  try {
    const res = await fetch('/api/delete-batch', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': currentSession.sessionId
      },
      body: JSON.stringify({ items: itemsToDelete })
    });

    const data = await res.json();
    if (!data.success) throw new Error(data.error);

    showToast(`${itemsToDelete.length} öğe başarıyla silindi.`, 'success');
    clearSelection();
    refreshFiles();
  } catch (err) {
    showToast(`Toplu silme hatası: ${err.message}`, 'error');
  }
}

// Custom Right-Click Context Menu
function showContextMenu(e, file) {
  const menu = document.getElementById('contextMenu');
  const itemsContainer = document.getElementById('contextMenuItems');
  if (!menu || !itemsContainer) return;

  const safeArg = escapeAttrArg(file.name);
  const canWriteLocal = typeof canWriteToLocal === 'function' && canWriteToLocal();
  let html = '';

  if (file.isDirectory) {
    html += `
      <button onclick="changeDirectory('${safeArg}'); hideContextMenu()" class="w-full text-left px-3 py-1.5 rounded-lg hover:bg-slate-800 text-slate-200 flex items-center gap-2 transition">
        <i class="fa-solid fa-folder-open text-amber-400 w-4"></i> Klasörü Aç
      </button>
      ${canWriteLocal ? `
        <button onclick="downloadRemoteItemToLocal('${safeArg}', true); hideContextMenu()" class="w-full text-left px-3 py-1.5 rounded-lg hover:bg-slate-800 text-emerald-300 flex items-center gap-2 transition">
          <i class="fa-solid fa-arrow-left text-emerald-400 w-4"></i> Yerel Klasöre İndir
        </button>
      ` : ''}
      <button onclick="downloadFolderAsZip('${safeArg}'); hideContextMenu()" class="w-full text-left px-3 py-1.5 rounded-lg hover:bg-slate-800 text-slate-200 flex items-center gap-2 transition">
        <i class="fa-solid fa-file-zipper text-emerald-400 w-4"></i> ZIP Olarak İndir
      </button>`;
  } else {
    html += `
      <button onclick="openFilePreview('${safeArg}'); hideContextMenu()" class="w-full text-left px-3 py-1.5 rounded-lg hover:bg-slate-800 text-slate-200 flex items-center gap-2 transition">
        <i class="fa-solid fa-pen-to-square text-sky-400 w-4"></i> Düzenle / Önizle
      </button>
      ${canWriteLocal ? `
        <button onclick="downloadRemoteItemToLocal('${safeArg}', false); hideContextMenu()" class="w-full text-left px-3 py-1.5 rounded-lg hover:bg-slate-800 text-emerald-300 flex items-center gap-2 transition">
          <i class="fa-solid fa-arrow-left text-emerald-400 w-4"></i> Yerel Klasöre İndir
        </button>
      ` : ''}
      <button onclick="downloadFile('${safeArg}'); hideContextMenu()" class="w-full text-left px-3 py-1.5 rounded-lg hover:bg-slate-800 text-slate-200 flex items-center gap-2 transition">
        <i class="fa-solid fa-download text-emerald-400 w-4"></i> İndir
      </button>`;
  }

  html += `
    <div class="my-1 border-t border-slate-800"></div>
    <button onclick="openRenameModal('${safeArg}'); hideContextMenu()" class="w-full text-left px-3 py-1.5 rounded-lg hover:bg-slate-800 text-slate-200 flex items-center gap-2 transition">
      <i class="fa-solid fa-pen text-amber-400 w-4"></i> Yeniden Adlandır
    </button>
    <button onclick="openChmodModal('${safeArg}'); hideContextMenu()" class="w-full text-left px-3 py-1.5 rounded-lg hover:bg-slate-800 text-slate-200 flex items-center gap-2 transition">
      <i class="fa-solid fa-key text-purple-400 w-4"></i> İzinler (CHMOD)
    </button>
    <div class="my-1 border-t border-slate-800"></div>
    <button onclick="deleteItem('${safeArg}', ${file.isDirectory}); hideContextMenu()" class="w-full text-left px-3 py-1.5 rounded-lg hover:bg-rose-950/60 text-rose-400 flex items-center gap-2 transition">
      <i class="fa-solid fa-trash-can w-4"></i> Sil
    </button>
  `;

  itemsContainer.innerHTML = html;
  positionAndShowContextMenu(e, menu);
}

function showEmptyAreaContextMenu(e) {
  const menu = document.getElementById('contextMenu');
  const itemsContainer = document.getElementById('contextMenuItems');
  if (!menu || !itemsContainer) return;

  itemsContainer.innerHTML = `
    <button onclick="openModal('newFolderModal'); hideContextMenu()" class="w-full text-left px-3 py-1.5 rounded-lg hover:bg-slate-800 text-slate-200 flex items-center gap-2 transition">
      <i class="fa-solid fa-folder-plus text-amber-400 w-4"></i> Yeni Klasör
    </button>
    <button onclick="openModal('newFileModal'); hideContextMenu()" class="w-full text-left px-3 py-1.5 rounded-lg hover:bg-slate-800 text-slate-200 flex items-center gap-2 transition">
      <i class="fa-solid fa-file-circle-plus text-sky-400 w-4"></i> Yeni Dosya
    </button>
    <div class="my-1 border-t border-slate-800"></div>
    <button onclick="refreshFiles(); hideContextMenu()" class="w-full text-left px-3 py-1.5 rounded-lg hover:bg-slate-800 text-slate-200 flex items-center gap-2 transition">
      <i class="fa-solid fa-arrows-rotate text-emerald-400 w-4"></i> Yenile
    </button>
    <button onclick="navigateUp(); hideContextMenu()" class="w-full text-left px-3 py-1.5 rounded-lg hover:bg-slate-800 text-slate-200 flex items-center gap-2 transition">
      <i class="fa-solid fa-arrow-up text-slate-400 w-4"></i> Üst Dizine Çık
    </button>
  `;

  positionAndShowContextMenu(e, menu);
}

function positionAndShowContextMenu(e, menu) {
  menu.classList.remove('hidden');
  const menuWidth = menu.offsetWidth || 192;
  const menuHeight = menu.offsetHeight || 200;
  const x = (e.clientX + menuWidth > window.innerWidth) ? (window.innerWidth - menuWidth - 10) : e.clientX;
  const y = (e.clientY + menuHeight > window.innerHeight) ? (window.innerHeight - menuHeight - 10) : e.clientY;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
}

function hideContextMenu() {
  const menu = document.getElementById('contextMenu');
  if (menu) menu.classList.add('hidden');
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
    if (!icon) return;
    if (col === field) {
      icon.className = `fa-solid ${sortDirection === 'asc' ? 'fa-sort-up' : 'fa-sort-down'} ml-1 text-sky-400`;
    } else {
      icon.className = 'fa-solid fa-sort ml-1 text-slate-600';
    }
  });

  if (typeof syncState !== 'undefined' && syncState.compareEnabled && typeof localState !== 'undefined' && localState.provider && currentSession) {
    localState.sortField = sortField;
    localState.sortDirection = sortDirection;
    ['name', 'size', 'modifiedAt'].forEach(col => {
      const icon = document.getElementById(`local-sort-${col}`);
      if (!icon) return;
      if (col === sortField) {
        icon.className = `fa-solid ${sortDirection === 'asc' ? 'fa-sort-up' : 'fa-sort-down'} ml-1 text-emerald-400`;
      } else {
        icon.className = 'fa-solid fa-sort ml-1 text-slate-600';
      }
    });
    renderFileList(document.getElementById('searchInput')?.value.trim() || '');
    if (typeof renderLocalFileList === 'function') {
      renderLocalFileList(document.getElementById('localSearchInput')?.value.trim() || '');
    }
  } else {
    renderFileList(document.getElementById('searchInput')?.value.trim() || '');
  }
}

// Modal Helpers
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
  if (id === 'bookmarksModal') {
    if (typeof resetBookmarkLocalFolderDraft === 'function') resetBookmarkLocalFolderDraft();
    if (typeof loadBookmarks === 'function') loadBookmarks();
  }
}

function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  if (id === 'imagePreviewModal' && typeof localPreviewBlobUrl !== 'undefined' && localPreviewBlobUrl) {
    URL.revokeObjectURL(localPreviewBlobUrl);
    localPreviewBlobUrl = null;
  }
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

function escapeAttrArg(str) {
  if (!str) return '';
  return escapeHtml(
    String(str)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
  );
}

