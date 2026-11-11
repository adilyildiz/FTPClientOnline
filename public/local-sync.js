// CloudFTP - FileZilla-style Local Folder Mapping, Synchronized Browsing,
// Directory Comparison & Bidirectional Sync Module

const localState = {
  provider: null, // 'fs_access' | 'virtual' | null
  rootHandle: null,
  rootName: '',
  canWrite: false,
  virtualTree: new Map(), // path -> Array<entry>
  currentPath: '', // relative to rootHandle ('' = root)
  files: [],
  selectedNames: new Set(),
  sortField: 'name',
  sortDirection: 'asc',
  paneVisible: true,
  mobileView: 'both'
};

const syncState = {
  mapped: false,
  localBasePath: '',
  remoteBasePath: '/',
  syncBrowsing: false,
  compareEnabled: false,
  compareCriteria: 'size_time', // 'size_time' | 'size'
  compareDiffOnly: false,
  isSyncNavigating: false,
  pendingMissing: null, // { side: 'remote' | 'local', targetPath: string }
  pendingReconnectMapping: null, // { key, mapping, handle }
  pendingBookmarkMapping: null, // { localBasePath, remoteBasePath }
  comparison: {
    localMap: new Map(),
    remoteMap: new Map()
  },
  syncPlanItems: [],
  syncBaseLocalPath: '',
  syncBaseRemotePath: '/'
};

// ==================== INDEXEDDB HANDLE PERSISTENCE ====================

const HandlesDB = {
  dbName: 'cloudftp_handles_db',
  storeName: 'handles',
  _open() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error('IndexedDB desteklenmiyor'));
        return;
      }
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          db.createObjectStore(this.storeName);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async save(key, handle) {
    try {
      const db = await this._open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).put(handle, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      return false;
    }
  },
  async get(key) {
    try {
      const db = await this._open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readonly');
        const req = tx.objectStore(this.storeName).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      return null;
    }
  },
  async remove(key) {
    try {
      const db = await this._open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(this.storeName, 'readwrite');
        tx.objectStore(this.storeName).delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      return false;
    }
  }
};

function getSavedMappingsMap() {
  try {
    return JSON.parse(localStorage.getItem('cloudftp_mappings') || '{}');
  } catch (e) {
    return {};
  }
}

function saveMappingsMap(map) {
  try {
    localStorage.setItem('cloudftp_mappings', JSON.stringify(map));
  } catch (e) {
    // ignore quota errors
  }
}

function getConnectionMappingKey(session = currentSession) {
  if (!session || !session.host) return null;
  const user = session.user || 'anonymous';
  const port = session.port || 21;
  return `${user}@${session.host}:${port}`;
}

// ==================== PATH UTILITIES ====================

function normalizeRemotePath(p) {
  if (!p) return '/';
  let s = String(p).replace(/\\/g, '/').trim();
  if (!s.startsWith('/')) s = '/' + s;
  const parts = s.split('/');
  const resolved = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return '/' + resolved.join('/');
}

function normalizeLocalRelPath(p) {
  if (!p) return '';
  const parts = String(p).replace(/\\/g, '/').split('/');
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

function joinLocalPath(base, name) {
  const b = normalizeLocalRelPath(base);
  const n = normalizeLocalRelPath(name);
  if (!b) return n;
  if (!n) return b;
  return `${b}/${n}`;
}

function joinRemotePath(base, rel) {
  const b = normalizeRemotePath(base);
  const r = normalizeLocalRelPath(rel);
  if (!r) return b;
  return b === '/' ? `/${r}` : `${b}/${r}`;
}

function getRelativeSubpath(basePath, targetPath, isRemote = true) {
  if (isRemote) {
    const base = normalizeRemotePath(basePath);
    const target = normalizeRemotePath(targetPath);
    if (base === '/') return target === '/' ? '' : target.slice(1);
    if (target === base) return '';
    if (target.startsWith(base + '/')) return target.slice(base.length + 1);
    return null;
  } else {
    const base = normalizeLocalRelPath(basePath);
    const target = normalizeLocalRelPath(targetPath);
    if (base === '') return target;
    if (target === base) return '';
    if (target.startsWith(base + '/')) return target.slice(base.length + 1);
    return null;
  }
}

function getLocalDisplayPath(relPath = localState.currentPath) {
  if (!localState.provider) return '';
  const clean = normalizeLocalRelPath(relPath);
  return clean ? `${localState.rootName}/${clean}` : localState.rootName;
}

function canWriteToLocal() {
  return localState.provider === 'fs_access' && localState.canWrite && !!localState.rootHandle;
}

// ==================== INITIALIZATION & EVENT BINDING ====================

document.addEventListener('DOMContentLoaded', () => {
  initLocalSyncUI();
});

function initLocalSyncUI() {
  // Restore pane visibility and split width
  const savedVisible = localStorage.getItem('cloudftp_local_pane_visible');
  if (savedVisible === 'false') {
    localState.paneVisible = false;
    applyLocalPaneVisibility();
  }
  const savedWidth = localStorage.getItem('cloudftp_local_pane_width');
  if (savedWidth && window.innerWidth >= 1024) {
    const localPane = document.getElementById('localPane');
    if (localPane) localPane.style.width = savedWidth;
  }

  // Toolbar buttons
  document.getElementById('toggleLocalPaneBtn')?.addEventListener('click', toggleLocalPane);
  document.getElementById('mapCurrentDirsBtn')?.addEventListener('click', mapCurrentDirectories);
  document.getElementById('clearMappingBtn')?.addEventListener('click', clearMapping);
  document.getElementById('syncBrowsingToggleBtn')?.addEventListener('click', toggleSyncBrowsing);
  document.getElementById('compareToggleBtn')?.addEventListener('click', toggleCompareMode);
  document.getElementById('compareCriteriaSelect')?.addEventListener('change', (e) => {
    syncState.compareCriteria = e.target.value;
    refreshComparisonAndRender();
  });
  document.getElementById('compareDiffOnlyCheck')?.addEventListener('change', (e) => {
    syncState.compareDiffOnly = e.target.checked;
    refreshComparisonAndRender();
  });
  document.getElementById('openSyncModalBtn')?.addEventListener('click', openSyncModal);

  // Local pane controls
  document.getElementById('pickLocalFolderBtn')?.addEventListener('click', pickLocalFolder);
  document.getElementById('localFolderFallbackInput')?.addEventListener('change', handleFallbackLocalFolder);
  document.getElementById('localNavUpBtn')?.addEventListener('click', localNavigateUp);
  document.getElementById('localNavRootBtn')?.addEventListener('click', localNavigateRoot);
  document.getElementById('localRefreshBtn')?.addEventListener('click', refreshLocalFiles);
  document.getElementById('localNewFolderBtn')?.addEventListener('click', () => openModal('localNewFolderModal'));
  document.getElementById('localSearchInput')?.addEventListener('input', (e) => {
    renderLocalFileList(e.target.value.trim());
  });

  // Banners
  document.getElementById('reconnectSavedMappingBtn')?.addEventListener('click', reconnectSavedMapping);
  document.getElementById('forgetSavedMappingBtn')?.addEventListener('click', forgetSavedMapping);
  document.getElementById('syncCreateMissingBtn')?.addEventListener('click', createMissingCounterpartAndSync);
  document.getElementById('syncDismissWarningBtn')?.addEventListener('click', hideSyncWarning);

  // Enter key in local new folder modal
  document.getElementById('localNewFolderNameInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitLocalNewFolder();
    }
  });

  // Local empty area right-click
  document.getElementById('localExplorerTableContainer')?.addEventListener('contextmenu', (e) => {
    if (!localState.provider) return;
    if (e.target.closest('tr')) return;
    e.preventDefault();
    showLocalEmptyContextMenu(e);
  });

  // Internal drag & drop between panes
  setupInterPaneDragAndDrop();

  // Marquee drag-selection on both Local and Remote file explorers
  initBothExplorerMarqueeSelections();

  // Resizer
  initPaneResizer();

  // Recent mappings list in empty local state
  renderRecentLocalMappings();
  updateSyncToolbarState();
}

function initPaneResizer() {
  const resizer = document.getElementById('paneResizer');
  const localPane = document.getElementById('localPane');
  const container = document.getElementById('dropZoneContainer');
  if (!resizer || !localPane || !container) return;

  let isDragging = false;

  resizer.addEventListener('pointerdown', (e) => {
    if (window.innerWidth < 1024) return;
    isDragging = true;
    resizer.classList.add('resizing');
    resizer.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  resizer.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;
    let pct = ((e.clientX - rect.left) / rect.width) * 100;
    pct = Math.max(25, Math.min(75, pct));
    localPane.style.width = `${pct.toFixed(1)}%`;
  });

  const endDrag = (e) => {
    if (!isDragging) return;
    isDragging = false;
    resizer.classList.remove('resizing');
    try { resizer.releasePointerCapture(e.pointerId); } catch (_) {}
    if (localPane.style.width) {
      localStorage.setItem('cloudftp_local_pane_width', localPane.style.width);
    }
  };

  resizer.addEventListener('pointerup', endDrag);
  resizer.addEventListener('pointercancel', endDrag);
}

function toggleLocalPane() {
  localState.paneVisible = !localState.paneVisible;
  localStorage.setItem('cloudftp_local_pane_visible', String(localState.paneVisible));
  applyLocalPaneVisibility();
}

function applyLocalPaneVisibility() {
  const localPane = document.getElementById('localPane');
  const resizer = document.getElementById('paneResizer');
  const btn = document.getElementById('toggleLocalPaneBtn');
  if (!localPane) return;

  if (localState.paneVisible) {
    localPane.classList.remove('hidden');
    if (resizer) resizer.classList.remove('hidden');
    if (btn) {
      btn.className = 'px-2.5 py-1 rounded-lg bg-sky-600/20 text-sky-300 border border-sky-500/40 hover:bg-sky-600/30 font-medium flex items-center gap-1.5 transition';
    }
  } else {
    localPane.classList.add('hidden');
    if (resizer) resizer.classList.add('hidden');
    if (btn) {
      btn.className = 'px-2.5 py-1 rounded-lg bg-slate-800 text-slate-400 border border-slate-700 hover:text-white font-medium flex items-center gap-1.5 transition';
    }
  }
}

function setMobilePaneView(view) {
  localState.mobileView = view;
  const localPane = document.getElementById('localPane');
  const remotePane = document.getElementById('remotePane');
  const tabs = {
    both: document.getElementById('mobTabBoth'),
    local: document.getElementById('mobTabLocal'),
    remote: document.getElementById('mobTabRemote')
  };

  Object.entries(tabs).forEach(([k, el]) => {
    if (!el) return;
    if (k === view) {
      el.className = 'px-2 py-0.5 rounded bg-slate-800 text-white font-medium';
    } else {
      el.className = 'px-2 py-0.5 rounded text-slate-400 hover:text-white';
    }
  });

  if (!localPane || !remotePane) return;
  if (view === 'both') {
    localPane.classList.remove('hidden', 'h-full');
    localPane.classList.add('h-1/2');
    remotePane.classList.remove('hidden');
    localState.paneVisible = true;
  } else if (view === 'local') {
    localPane.classList.remove('hidden', 'h-1/2');
    localPane.classList.add('h-full');
    remotePane.classList.add('hidden');
  } else if (view === 'remote') {
    localPane.classList.add('hidden');
    remotePane.classList.remove('hidden');
  }
}

// ==================== PICKING & LOADING LOCAL FOLDER ====================

async function pickLocalFolder() {
  if (!localState.paneVisible) {
    localState.paneVisible = true;
    applyLocalPaneVisibility();
  }

  if (typeof window.showDirectoryPicker === 'function') {
    try {
      let handle;
      let canWrite = true;
      try {
        handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      } catch (permErr) {
        if (permErr.name === 'AbortError') return;
        // Try read-only mode if readwrite rejected
        handle = await window.showDirectoryPicker({ mode: 'read' });
        canWrite = false;
      }

      if (canWrite && handle.queryPermission) {
        const perm = await handle.queryPermission({ mode: 'readwrite' });
        canWrite = perm === 'granted';
      }

      await activateFsAccessHandle(handle, canWrite, '');
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
      showToast(`Klasör açılamadı: ${err.message}`, 'error');
      return;
    }
  }

  // Fallback for Firefox/Safari/non-HTTPS contexts
  document.getElementById('localFolderFallbackInput')?.click();
}

async function activateFsAccessHandle(handle, canWrite, startRelPath = '', autoMapIfConnected = true) {
  localState.provider = 'fs_access';
  localState.rootHandle = handle;
  localState.rootName = handle.name;
  localState.canWrite = canWrite;
  localState.virtualTree.clear();
  localState.currentPath = normalizeLocalRelPath(startRelPath);

  hideSavedMappingBanner();
  updateLocalPaneUI(true);
  await loadLocalDirectory(localState.currentPath, { triggerSync: false });

  addClientLog('success', `Yerel klasör açıldı: "${handle.name}" (${canWrite ? 'Okuma/Yazma' : 'Salt Okunur'})`);

  if (autoMapIfConnected && currentSession && !syncState.mapped) {
    mapCurrentDirectories();
  } else if (syncState.compareEnabled) {
    refreshComparisonAndRender();
  }
  updateSyncToolbarState();
}

function handleFallbackLocalFolder(e) {
  const fileListInput = e.target.files;
  if (!fileListInput || fileListInput.length === 0) return;

  const tree = new Map();
  tree.set('', []);
  let rootName = 'Yerel Klasör';

  const ensureDirNode = (dirPath, name, parentPath) => {
    if (!tree.has(dirPath)) {
      tree.set(dirPath, []);
      const parentArr = tree.get(parentPath);
      if (parentArr && !parentArr.some(item => item.isDirectory && item.name === name)) {
        parentArr.push({
          name,
          isDirectory: true,
          size: 0,
          modifiedAt: null,
          file: null,
          handle: null
        });
      }
    }
  };

  for (const f of Array.from(fileListInput)) {
    const rel = (f.webkitRelativePath || f.name).replace(/\\/g, '/');
    const segments = rel.split('/').filter(Boolean);
    if (segments.length === 0) continue;

    if (segments.length > 1) {
      rootName = segments[0];
      segments.shift();
    }

    let accPath = '';
    for (let i = 0; i < segments.length - 1; i++) {
      const folderName = segments[i];
      const nextPath = accPath ? `${accPath}/${folderName}` : folderName;
      ensureDirNode(nextPath, folderName, accPath);
      accPath = nextPath;
    }

    const fileName = segments[segments.length - 1];
    if (!tree.has(accPath)) tree.set(accPath, []);
    tree.get(accPath).push({
      name: fileName,
      isDirectory: false,
      size: f.size,
      modifiedAt: f.lastModified ? new Date(f.lastModified).toISOString() : null,
      file: f,
      handle: null
    });
  }

  e.target.value = '';

  localState.provider = 'virtual';
  localState.rootHandle = null;
  localState.rootName = rootName;
  localState.canWrite = false;
  localState.virtualTree = tree;
  localState.currentPath = '';

  hideSavedMappingBanner();
  updateLocalPaneUI(true);
  loadLocalDirectory('', { triggerSync: false });
  addClientLog('info', `Yerel klasör (Salt Okunur mod) yüklendi: "${rootName}"`);

  if (currentSession && !syncState.mapped) {
    mapCurrentDirectories();
  }
  updateSyncToolbarState();
}

function updateLocalPaneUI(hasFolder) {
  const emptyState = document.getElementById('localDisconnectedState');
  const tableContainer = document.getElementById('localExplorerTableContainer');
  const modeBadge = document.getElementById('localFsModeBadge');
  const upBtn = document.getElementById('localNavUpBtn');
  const rootBtn = document.getElementById('localNavRootBtn');
  const refreshBtn = document.getElementById('localRefreshBtn');
  const newFolderBtn = document.getElementById('localNewFolderBtn');
  const bulkDelBtn = document.getElementById('localBulkDeleteBtn');

  if (hasFolder) {
    emptyState?.classList.add('hidden');
    tableContainer?.classList.remove('hidden');
    if (modeBadge) {
      modeBadge.classList.remove('hidden');
      if (localState.canWrite) {
        modeBadge.innerText = 'Okuma/Yazma';
        modeBadge.className = 'text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30';
      } else {
        modeBadge.innerText = 'Salt Okunur';
        modeBadge.className = 'text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30';
      }
    }
    if (upBtn) upBtn.disabled = localState.currentPath === '';
    if (rootBtn) rootBtn.disabled = false;
    if (refreshBtn) refreshBtn.disabled = false;
    if (newFolderBtn) newFolderBtn.disabled = !localState.canWrite;
    if (bulkDelBtn) bulkDelBtn.classList.toggle('hidden', !localState.canWrite);
  } else {
    emptyState?.classList.remove('hidden');
    tableContainer?.classList.add('hidden');
    modeBadge?.classList.add('hidden');
    if (upBtn) upBtn.disabled = true;
    if (rootBtn) rootBtn.disabled = true;
    if (refreshBtn) refreshBtn.disabled = true;
    if (newFolderBtn) newFolderBtn.disabled = true;
  }
}

async function getLocalDirHandle(relPath, create = false) {
  if (localState.provider !== 'fs_access' || !localState.rootHandle) {
    throw new Error('Yerel klasör erişimi aktif değil.');
  }
  const clean = normalizeLocalRelPath(relPath);
  if (!clean) return localState.rootHandle;
  let current = localState.rootHandle;
  for (const segment of clean.split('/')) {
    current = await current.getDirectoryHandle(segment, { create });
  }
  return current;
}

async function loadLocalDirectory(relPath = '', options = { triggerSync: true }) {
  if (!localState.provider) return false;
  const cleanPath = normalizeLocalRelPath(relPath);
  const refreshIcon = document.getElementById('localRefreshIcon');
  refreshIcon?.classList.add('fa-spin');

  try {
    let entries = [];
    if (localState.provider === 'fs_access') {
      const dirHandle = await getLocalDirHandle(cleanPath, false);
      for await (const [name, handle] of dirHandle.entries()) {
        if (handle.kind === 'directory') {
          entries.push({
            name,
            isDirectory: true,
            size: 0,
            modifiedAt: null,
            handle,
            file: null
          });
        } else {
          let size = 0;
          let modifiedAt = null;
          try {
            const file = await handle.getFile();
            size = file.size;
            modifiedAt = file.lastModified ? new Date(file.lastModified).toISOString() : null;
          } catch (_) {}
          entries.push({
            name,
            isDirectory: false,
            size,
            modifiedAt,
            handle,
            file: null
          });
        }
      }
    } else {
      if (!localState.virtualTree.has(cleanPath)) {
        throw new Error(`Yerel klasör bulunamadı: ${cleanPath}`);
      }
      entries = [...(localState.virtualTree.get(cleanPath) || [])];
    }

    localState.currentPath = cleanPath;
    localState.files = entries;
    clearLocalSelection();
    updateLocalPaneUI(true);
    renderLocalBreadcrumb(cleanPath);

    if (syncState.compareEnabled && currentSession) {
      computeComparison();
      if (typeof renderFileList === 'function') {
        renderFileList(document.getElementById('searchInput')?.value.trim() || '');
      }
    } else {
      syncState.comparison.localMap.clear();
      syncState.comparison.remoteMap.clear();
    }

    renderLocalFileList(document.getElementById('localSearchInput')?.value.trim() || '');

    if (options.triggerSync && syncState.syncBrowsing && !syncState.isSyncNavigating && currentSession) {
      await onLocalNavigatedForSync();
    }
    return true;
  } catch (err) {
    showToast(`Yerel klasör okunamadı: ${err.message}`, 'error');
    return false;
  } finally {
    refreshIcon?.classList.remove('fa-spin');
  }
}

function localNavigateUp() {
  if (!localState.provider || !localState.currentPath) return;
  const parts = localState.currentPath.split('/').filter(Boolean);
  parts.pop();
  loadLocalDirectory(parts.join('/'));
}

function localNavigateRoot() {
  if (!localState.provider) return;
  loadLocalDirectory('');
}

function refreshLocalFiles() {
  if (!localState.provider) return;
  loadLocalDirectory(localState.currentPath, { triggerSync: false });
}

function renderLocalBreadcrumb(relPath) {
  const bar = document.getElementById('localBreadcrumbBar');
  if (!bar) return;

  if (!localState.provider) {
    bar.innerHTML = `<span class="text-slate-500"><i class="fa-solid fa-hard-drive text-emerald-400 mr-1.5"></i> Seçilmedi</span>`;
    return;
  }

  const rootLabel = escapeHtml(localState.rootName);
  const parts = normalizeLocalRelPath(relPath).split('/').filter(Boolean);

  if (parts.length === 0) {
    bar.innerHTML = `
      <button onclick="loadLocalDirectory('')" class="text-emerald-400 hover:text-emerald-300 font-bold flex items-center gap-1">
        <i class="fa-solid fa-hard-drive text-xs"></i> ${rootLabel}
      </button>`;
    return;
  }

  let acc = '';
  let html = `
    <button onclick="loadLocalDirectory('')" class="text-emerald-400 hover:text-emerald-300 font-bold flex items-center gap-1">
      <i class="fa-solid fa-hard-drive text-xs"></i> ${rootLabel}
    </button>`;

  parts.forEach((part, idx) => {
    acc = acc ? `${acc}/${part}` : part;
    const isLast = idx === parts.length - 1;
    const target = acc;
    const isMappedBase = syncState.mapped && normalizeLocalRelPath(syncState.localBasePath) === target;
    html += `<span class="text-slate-600">/</span>`;
    if (isLast) {
      html += `<span class="text-slate-100 font-bold px-1 py-0.5 rounded bg-slate-800">${escapeHtml(part)}${isMappedBase ? ' <i class="fa-solid fa-anchor text-amber-400 text-[9px] ml-0.5" title="Eşleme Kökü"></i>' : ''}</span>`;
    } else {
      html += `<button onclick="loadLocalDirectory('${escapeAttrArg(target)}')" class="text-slate-300 hover:text-emerald-400 hover:underline px-1">${escapeHtml(part)}</button>`;
    }
  });

  bar.innerHTML = html;
}

function sortLocalFiles(field) {
  if (localState.sortField === field) {
    localState.sortDirection = localState.sortDirection === 'asc' ? 'desc' : 'asc';
  } else {
    localState.sortField = field;
    localState.sortDirection = 'asc';
  }

  ['name', 'size', 'modifiedAt'].forEach(col => {
    const icon = document.getElementById(`local-sort-${col}`);
    if (!icon) return;
    if (col === localState.sortField) {
      icon.className = `fa-solid ${localState.sortDirection === 'asc' ? 'fa-sort-up' : 'fa-sort-down'} ml-1 text-emerald-400`;
    } else {
      icon.className = 'fa-solid fa-sort ml-1 text-slate-600';
    }
  });

  if (syncState.compareEnabled && localState.provider && currentSession) {
    if (typeof sortField !== 'undefined') {
      sortField = localState.sortField;
      sortDirection = localState.sortDirection;
      ['name', 'size', 'modifiedAt'].forEach(col => {
        const icon = document.getElementById(`sort-${col}`);
        if (!icon) return;
        if (col === sortField) {
          icon.className = `fa-solid ${sortDirection === 'asc' ? 'fa-sort-up' : 'fa-sort-down'} ml-1 text-sky-400`;
        } else {
          icon.className = 'fa-solid fa-sort ml-1 text-slate-600';
        }
      });
    }
    renderLocalFileList(document.getElementById('localSearchInput')?.value.trim() || '');
    if (typeof renderFileList === 'function') {
      renderFileList(document.getElementById('searchInput')?.value.trim() || '');
    }
  } else {
    renderLocalFileList(document.getElementById('localSearchInput')?.value.trim() || '');
  }
}

function renderLocalPlaceholderRow(tbody, name = '') {
  const tr = document.createElement('tr');
  tr.className = 'h-9 border-b border-slate-800/25 bg-slate-950/20 comparison-placeholder pointer-events-none select-none';
  tr.setAttribute('data-placeholder', 'true');
  tr.innerHTML = `
    <td class="h-9 py-0 pl-3 pr-1 w-7 text-center">&nbsp;</td>
    <td class="h-9 py-0 px-2 text-slate-600/40 text-[11px] font-mono italic">&nbsp;</td>
    <td class="h-9 py-0 px-2 w-20 text-right text-slate-600/40 text-[11px] font-mono">&nbsp;</td>
    <td class="h-9 py-0 px-2 w-32 hidden xl:table-cell text-slate-600/40 text-[11px]">&nbsp;</td>
    <td class="h-9 py-0 px-2 w-24 text-right">&nbsp;</td>
  `;
  tbody.appendChild(tr);
}

function renderLocalRow(tbody, file) {
  const tr = document.createElement('tr');
  const isSelected = localState.selectedNames.has(file.name);
  const cmp = syncState.compareEnabled && currentSession ? syncState.comparison.localMap.get(file.name) : null;
  const cmpRowClass = cmp ? cmp.rowClass : '';

  tr.className = `${isSelected ? 'bg-emerald-950/40' : (cmpRowClass || 'hover:bg-slate-800/40')} h-9 border-b border-slate-800/40 transition group`;

  const iconHtml = getFileIcon(file);
  const sizeStr = file.isDirectory ? '-' : formatBytes(file.size);
  const dateStr = file.modifiedAt ? formatCompactDate(file.modifiedAt) : '-';
  const cmpBadge = cmp && cmp.badgeHtml ? cmp.badgeHtml : '';
  const safeName = escapeHtml(file.name);
  const safeArg = escapeAttrArg(file.name);

  tr.innerHTML = `
    <td class="pl-3 pr-1 align-middle text-center">
      <input type="checkbox" ${isSelected ? 'checked' : ''} onchange="toggleLocalRowSelection('${safeArg}', this)"
        class="local-row-checkbox rounded bg-slate-800 border-slate-700 text-emerald-500 focus:ring-0 cursor-pointer">
    </td>
    <td class="px-2 align-middle">
      <div class="flex items-center gap-2 overflow-hidden min-w-0">
        <span class="drag-source inline-flex items-center gap-2 min-w-0" draggable="true">
          ${iconHtml}
          <span class="local-name-link truncate font-medium ${file.isDirectory ? 'text-emerald-300 font-semibold cursor-pointer hover:underline' : 'text-slate-200 cursor-pointer hover:text-white'}"
            title="${safeName}">
            ${safeName}
          </span>
        </span>
        ${cmpBadge}
      </div>
    </td>
    <td class="px-2 align-middle text-right text-slate-400 font-mono text-[11px] whitespace-nowrap">${sizeStr}</td>
    <td class="px-2 align-middle text-slate-400 text-[11px] whitespace-nowrap hidden xl:table-cell">${dateStr}</td>
    <td class="px-2 align-middle text-right whitespace-nowrap">
      <div class="inline-flex items-center gap-1 opacity-80 group-hover:opacity-100 transition">
        <button onclick="uploadLocalItemToRemote('${safeArg}', ${file.isDirectory})" ${currentSession ? '' : 'disabled'} title="FTP'ye Yükle"
          class="w-6 h-6 rounded hover:bg-slate-700 disabled:opacity-30 text-slate-300 hover:text-sky-400 flex items-center justify-center transition">
          <i class="fa-solid fa-arrow-right text-[11px]"></i>
        </button>
        ${!file.isDirectory ? `
          <button onclick="openLocalFilePreview('${safeArg}')" title="Görüntüle / Düzenle"
            class="w-6 h-6 rounded hover:bg-slate-700 text-slate-300 hover:text-emerald-400 flex items-center justify-center transition">
            <i class="fa-solid fa-pen-to-square text-[11px]"></i>
          </button>
        ` : ''}
        ${localState.canWrite ? `
          <button onclick="deleteLocalItem('${safeArg}', ${file.isDirectory})" title="Yerel Öğeyi Sil"
            class="w-6 h-6 rounded hover:bg-rose-950/40 text-slate-400 hover:text-rose-400 flex items-center justify-center transition">
            <i class="fa-solid fa-trash-can text-[11px]"></i>
          </button>
        ` : ''}
      </div>
    </td>
  `;

  tr.querySelector('.drag-source')?.addEventListener('dragstart', (e) => {
    const names = (localState.selectedNames.has(file.name) && localState.selectedNames.size > 1)
      ? Array.from(localState.selectedNames)
      : [file.name];
    e.dataTransfer.setData('application/x-cloudftp-local', JSON.stringify({
      multiple: names.length > 1,
      names,
      name: file.name,
      isDirectory: file.isDirectory
    }));
    e.dataTransfer.effectAllowed = 'copy';
  });

  tr.querySelector('.local-name-link')?.addEventListener('click', () => {
    if (file.isDirectory) {
      loadLocalDirectory(joinLocalPath(localState.currentPath, file.name));
    } else {
      openLocalFilePreview(file.name);
    }
  });

  tr.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showLocalContextMenu(e, file);
  });

  tbody.appendChild(tr);
}

function renderLocalFileList(filterQuery = '') {
  const tbody = document.getElementById('localFileListBody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const isComparing = Boolean(syncState.compareEnabled && localState.provider && currentSession);
  if (isComparing && typeof getAlignedComparisonSlots === 'function') {
    const remoteQuery = document.getElementById('searchInput')?.value.trim() || '';
    const aligned = getAlignedComparisonSlots(filterQuery, remoteQuery);
    if (!aligned || aligned.slots.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" class="py-8 text-center text-slate-500 font-sans">
            <i class="fa-regular fa-folder-open text-2xl mb-2 block text-slate-600"></i>
            ${syncState.compareDiffOnly ? 'Bu dizinde fark bulunamadı.' : 'Bu yerel klasör boş.'}
          </td>
        </tr>`;
      syncComparisonRerender('local');
      return;
    }

    aligned.slots.forEach(slot => {
      const file = slot.type === 'dir' ? aligned.localDirMap.get(slot.name) : aligned.localFileMap.get(slot.name);
      if (file) {
        renderLocalRow(tbody, file);
      } else {
        renderLocalPlaceholderRow(tbody, slot.name);
      }
    });

    syncComparisonRerender('local');
    return;
  }

  let filtered = [...localState.files];
  if (filterQuery) {
    const q = filterQuery.toLowerCase();
    filtered = filtered.filter(f => f.name.toLowerCase().includes(q));
  }

  if (syncState.compareEnabled && syncState.compareDiffOnly && currentSession) {
    filtered = filtered.filter(f => {
      const cmp = syncState.comparison.localMap.get(f.name);
      return !cmp || (cmp.status !== 'same' && cmp.status !== 'both_dir');
    });
  }

  filtered.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;

    if (localState.sortField === 'name') {
      return localState.sortDirection === 'asc'
        ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        : b.name.localeCompare(a.name, undefined, { sensitivity: 'base' });
    }
    if (localState.sortField === 'size') {
      return localState.sortDirection === 'asc' ? (a.size || 0) - (b.size || 0) : (b.size || 0) - (a.size || 0);
    }
    if (localState.sortField === 'modifiedAt') {
      return localState.sortDirection === 'asc'
        ? new Date(a.modifiedAt || 0) - new Date(b.modifiedAt || 0)
        : new Date(b.modifiedAt || 0) - new Date(a.modifiedAt || 0);
    }
    return 0;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="py-8 text-center text-slate-500 font-sans">
          <i class="fa-regular fa-folder-open text-2xl mb-2 block text-slate-600"></i>
          ${syncState.compareEnabled && syncState.compareDiffOnly ? 'Bu dizinde fark bulunamadı.' : 'Bu yerel klasör boş.'}
        </td>
      </tr>`;
    return;
  }

  filtered.forEach(file => {
    renderLocalRow(tbody, file);
  });
}

// ==================== LOCAL SELECTION & CRUD ====================

function toggleLocalRowSelection(name, checkbox) {
  if (checkbox.checked) {
    localState.selectedNames.add(name);
  } else {
    localState.selectedNames.delete(name);
  }
  updateLocalBulkBar();
  const row = checkbox.closest('tr');
  if (row) {
    row.classList.toggle('bg-emerald-950/40', checkbox.checked);
  }
}

function toggleLocalSelectAll(masterCheckbox) {
  const checkboxes = document.querySelectorAll('.local-row-checkbox');
  localState.selectedNames.clear();
  checkboxes.forEach(cb => {
    cb.checked = masterCheckbox.checked;
    const row = cb.closest('tr');
    const name = row?.querySelector('.local-name-link')?.getAttribute('title');
    if (masterCheckbox.checked && name) {
      localState.selectedNames.add(name);
      row.classList.add('bg-emerald-950/40');
    } else if (row) {
      row.classList.remove('bg-emerald-950/40');
    }
  });
  updateLocalBulkBar();
}

function clearLocalSelection() {
  localState.selectedNames.clear();
  const master = document.getElementById('localSelectAllCheckbox');
  if (master) master.checked = false;
  document.querySelectorAll('.local-row-checkbox').forEach(cb => {
    cb.checked = false;
    cb.closest('tr')?.classList.remove('bg-emerald-950/40');
  });
  updateLocalBulkBar();
}

function updateLocalBulkBar() {
  const bar = document.getElementById('localBulkActionBar');
  const text = document.getElementById('localSelectedCountText');
  if (!bar || !text) return;
  if (localState.selectedNames.size > 0) {
    text.innerText = `${localState.selectedNames.size} öğe seçildi`;
    bar.classList.remove('hidden');
  } else {
    bar.classList.add('hidden');
  }
}

function setLocalSelectionFromSet(newSet) {
  localState.selectedNames = new Set(newSet);
  const tbody = document.getElementById('localFileListBody');
  const master = document.getElementById('localSelectAllCheckbox');
  const rows = tbody ? tbody.querySelectorAll('tr') : [];
  let totalVisible = 0;
  let checkedVisible = 0;

  rows.forEach(row => {
    const cb = row.querySelector('.local-row-checkbox');
    const name = row.querySelector('.local-name-link')?.getAttribute('title');
    if (!cb || !name) return;
    totalVisible++;
    const isSel = localState.selectedNames.has(name);
    cb.checked = isSel;
    if (isSel) checkedVisible++;
    row.classList.toggle('bg-emerald-950/40', isSel);
  });

  if (master) {
    master.checked = totalVisible > 0 && checkedVisible === totalVisible;
  }
  updateLocalBulkBar();
}

async function submitLocalNewFolder() {
  if (!canWriteToLocal()) return;
  const input = document.getElementById('localNewFolderNameInput');
  const name = input?.value.trim();
  if (!name) return;

  try {
    const dirHandle = await getLocalDirHandle(localState.currentPath, false);
    await dirHandle.getDirectoryHandle(name, { create: true });
    input.value = '';
    closeModal('localNewFolderModal');
    showToast(`Yerel klasör oluşturuldu: ${name}`, 'success');
    addClientLog('success', `Yerel klasör oluşturuldu: ${joinLocalPath(localState.currentPath, name)}`);
    await loadLocalDirectory(localState.currentPath, { triggerSync: false });
  } catch (err) {
    showToast(`Yerel klasör oluşturulamadı: ${err.message}`, 'error');
  }
}

async function deleteLocalItem(name, isDirectory) {
  if (!canWriteToLocal()) return;
  const label = isDirectory ? 'klasörünü ve içindeki tüm dosyaları' : 'dosyasını';
  if (!confirm(`Bilgisayarınızdaki "${name}" ${label} kalıcı olarak silmek istediğinize emin misiniz?`)) {
    return;
  }
  try {
    const dirHandle = await getLocalDirHandle(localState.currentPath, false);
    await dirHandle.removeEntry(name, { recursive: !!isDirectory });
    showToast(`Yerelden silindi: ${name}`, 'success');
    addClientLog('info', `Yerelden silindi: ${joinLocalPath(localState.currentPath, name)}`);
    await loadLocalDirectory(localState.currentPath, { triggerSync: false });
  } catch (err) {
    showToast(`Silme hatası: ${err.message}`, 'error');
  }
}

async function deleteSelectedLocalItems() {
  if (!canWriteToLocal() || localState.selectedNames.size === 0) return;
  if (!confirm(`Bilgisayarınızdaki seçili ${localState.selectedNames.size} öğeyi kalıcı olarak silmek istediğinize emin misiniz?`)) {
    return;
  }
  try {
    const dirHandle = await getLocalDirHandle(localState.currentPath, false);
    for (const name of localState.selectedNames) {
      const entry = localState.files.find(f => f.name === name);
      if (entry) {
        await dirHandle.removeEntry(name, { recursive: !!entry.isDirectory });
      }
    }
    showToast(`${localState.selectedNames.size} yerel öğe silindi.`, 'success');
    clearLocalSelection();
    await loadLocalDirectory(localState.currentPath, { triggerSync: false });
  } catch (err) {
    showToast(`Toplu silme hatası: ${err.message}`, 'error');
  }
}

// ==================== LOCAL PREVIEW & EDITOR ====================

let localPreviewBlobUrl = null;

async function getLocalFileObject(relDirPath, fileName) {
  if (localState.provider === 'fs_access') {
    const dirHandle = await getLocalDirHandle(relDirPath, false);
    const fileHandle = await dirHandle.getFileHandle(fileName, { create: false });
    const file = await fileHandle.getFile();
    return { file, fileHandle };
  }
  const arr = localState.virtualTree.get(normalizeLocalRelPath(relDirPath)) || [];
  const item = arr.find(i => !i.isDirectory && i.name === fileName);
  if (!item || !item.file) throw new Error('Yerel dosya bulunamadı.');
  return { file: item.file, fileHandle: null };
}

async function openLocalFilePreview(filename) {
  try {
    const { file, fileHandle } = await getLocalFileObject(localState.currentPath, filename);
    const ext = filename.split('.').pop().toLowerCase();

    if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) {
      if (localPreviewBlobUrl) {
        URL.revokeObjectURL(localPreviewBlobUrl);
        localPreviewBlobUrl = null;
      }
      localPreviewBlobUrl = URL.createObjectURL(file);
      document.getElementById('imagePreviewTitle').innerText = `${filename} (Yerel)`;
      document.getElementById('imagePreviewImg').src = localPreviewBlobUrl;
      openModal('imagePreviewModal');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      showToast('5 MB üzeri yerel dosyalar düzenleyicide açılamaz.', 'error');
      return;
    }

    const content = await file.text();
    window.currentEditingSource = 'local';
    window.currentLocalEditingHandle = fileHandle;
    window.currentEditingPath = joinLocalPath(localState.currentPath, filename);

    document.getElementById('editorFilename').innerText = filename;
    document.getElementById('editorFilesize').innerText = formatBytes(file.size);
    const badge = document.getElementById('editorSourceBadge');
    if (badge) {
      badge.innerText = localState.canWrite ? 'Yerel Klasör (Yazılabilir)' : 'Yerel Klasör (Salt Okunur)';
      badge.className = 'text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30';
    }
    const saveBtn = document.getElementById('editorSaveBtn');
    if (saveBtn) saveBtn.disabled = !localState.canWrite;

    document.getElementById('editorTextarea').value = content;
    openModal('editorModal');
  } catch (err) {
    showToast(`Yerel dosya okunamadı: ${err.message}`, 'error');
  }
}

async function saveLocalEditorContent(content) {
  if (!canWriteToLocal() || !window.currentLocalEditingHandle) {
    throw new Error('Yerel yazma izni yok.');
  }
  const writable = await window.currentLocalEditingHandle.createWritable();
  await writable.write(content);
  await writable.close();
  addClientLog('success', `Yerel dosya kaydedildi: ${window.currentEditingPath}`);
  await loadLocalDirectory(localState.currentPath, { triggerSync: false });
}

// ==================== LOCAL <-> REMOTE TRANSFERS ====================

async function collectLocalItemsForUpload(baseRelDir, itemNames, includeRootFolderPrefix = true) {
  const items = [];
  const entries = localState.files.filter(f => itemNames.includes(f.name));

  async function walkFsAccess(dirHandle, relPrefix) {
    for await (const [name, handle] of dirHandle.entries()) {
      const nextRel = relPrefix ? `${relPrefix}/${name}` : name;
      if (handle.kind === 'directory') {
        await walkFsAccess(handle, nextRel);
      } else {
        const file = await handle.getFile();
        items.push({ file, relativePath: nextRel });
      }
    }
  }

  function walkVirtual(vPath, relPrefix) {
    const list = localState.virtualTree.get(vPath) || [];
    for (const entry of list) {
      const nextRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        walkVirtual(joinLocalPath(vPath, entry.name), nextRel);
      } else if (entry.file) {
        items.push({ file: entry.file, relativePath: nextRel });
      }
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory) {
      if (localState.provider === 'fs_access') {
        const file = await entry.handle.getFile();
        items.push({ file, relativePath: entry.name });
      } else if (entry.file) {
        items.push({ file: entry.file, relativePath: entry.name });
      }
    } else {
      const prefix = includeRootFolderPrefix ? entry.name : '';
      if (localState.provider === 'fs_access') {
        await walkFsAccess(entry.handle, prefix);
      } else {
        walkVirtual(joinLocalPath(baseRelDir, entry.name), prefix);
      }
    }
  }

  return items;
}

async function uploadLocalItemToRemote(name, isDirectory) {
  if (!currentSession) {
    showToast('Önce FTP sunucusuna bağlanmalısınız.', 'error');
    return;
  }
  try {
    const items = await collectLocalItemsForUpload(localState.currentPath, [name], true);
    if (items.length === 0) {
      showToast(isDirectory ? 'Seçilen klasör boş.' : 'Dosya okunamadı.', 'info');
      return;
    }
    await uploadItems(items);
  } catch (err) {
    showToast(`Yükleme hazırlama hatası: ${err.message}`, 'error');
  }
}

async function uploadSelectedLocalItems() {
  if (!currentSession) {
    showToast('Önce FTP sunucusuna bağlanmalısınız.', 'error');
    return;
  }
  if (localState.selectedNames.size === 0) return;
  try {
    const items = await collectLocalItemsForUpload(localState.currentPath, Array.from(localState.selectedNames), true);
    if (items.length === 0) {
      showToast('Yüklenecek dosya bulunamadı.', 'info');
      return;
    }
    clearLocalSelection();
    await uploadItems(items);
  } catch (err) {
    showToast(`Yükleme hazırlama hatası: ${err.message}`, 'error');
  }
}

// Download Remote Files/Folders directly to Mapped Local Directory
async function downloadRemoteItemToLocal(name, isDirectory) {
  await downloadRemoteItemsToLocal([{ name, isDirectory }]);
}

async function downloadSelectedToLocal() {
  if (!currentSession || selectedNames.size === 0) return;
  const targets = [];
  selectedNames.forEach(name => {
    const f = fileList.find(item => item.name === name);
    if (f) targets.push({ name: f.name, isDirectory: f.isDirectory });
  });
  await downloadRemoteItemsToLocal(targets);
}

async function downloadRemoteItemsToLocal(targets) {
  if (!currentSession) return;
  if (!canWriteToLocal()) {
    showToast('Yerel klasöre indirmek için Okuma/Yazma izinli bir yerel klasör seçin.', 'error');
    return;
  }
  if (!targets || targets.length === 0) return;

  const progressBar = document.getElementById('uploadProgressBar');
  const progressFill = document.getElementById('uploadProgressFill');
  const percentText = document.getElementById('uploadPercent');
  const statusText = document.getElementById('uploadStatusText');

  try {
    // Expand directories recursively into flat download descriptors
    const downloadQueue = [];
    for (const target of targets) {
      if (!target.isDirectory) {
        const remoteFile = fileList.find(f => f.name === target.name);
        downloadQueue.push({
          remotePath: joinRemotePath(currentPath, target.name),
          relativeLocalPath: target.name,
          size: remoteFile?.size || 0,
          modifiedAt: remoteFile?.modifiedAt || null
        });
      } else {
        const folderRemotePath = joinRemotePath(currentPath, target.name);
        const res = await fetch('/api/list-tree', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-session-id': currentSession.sessionId
          },
          body: JSON.stringify({ basePath: folderRemotePath, maxDepth: 12 })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Uzak klasör taranamadı.');
        for (const entry of data.entries) {
          if (!entry.isDirectory) {
            downloadQueue.push({
              remotePath: joinRemotePath(folderRemotePath, entry.relativePath),
              relativeLocalPath: `${target.name}/${entry.relativePath}`,
              size: entry.size || 0,
              modifiedAt: entry.modifiedAt || null
            });
          } else {
            // Ensure empty subfolders get created
            const subLocalDir = joinLocalPath(localState.currentPath, `${target.name}/${entry.relativePath}`);
            await getLocalDirHandle(subLocalDir, true);
          }
        }
      }
    }

    if (downloadQueue.length === 0) {
      await loadLocalDirectory(localState.currentPath, { triggerSync: false });
      showToast('Klasör yapısı yerel klasöre aktarıldı.', 'success');
      return;
    }

    // Check conflicts against existing local files
    const resolvedQueue = await resolveLocalDownloadConflicts(downloadQueue);
    if (resolvedQueue.length === 0) {
      showToast('Tüm çakışan dosyalar atlandı.', 'info');
      return;
    }

    progressBar?.classList.remove('hidden');
    if (progressFill) progressFill.style.width = '0%';
    if (percentText) percentText.innerText = '0%';

    let done = 0;
    for (const item of resolvedQueue) {
      if (statusText) statusText.innerText = `İndiriliyor (${done + 1}/${resolvedQueue.length}): ${item.relativeLocalPath}`;
      await downloadSingleRemoteToLocal(item.remotePath, item.relativeLocalPath);
      done++;
      const pct = Math.round((done / resolvedQueue.length) * 100);
      if (progressFill) progressFill.style.width = `${pct}%`;
      if (percentText) percentText.innerText = `${pct}%`;
    }

    addClientLog('success', `${resolvedQueue.length} dosya yerel klasöre indirildi.`);
    showToast(`${resolvedQueue.length} dosya yerel klasöre indirildi.`, 'success');
    await loadLocalDirectory(localState.currentPath, { triggerSync: false });
  } catch (err) {
    if (err.message === 'cancelled') {
      showToast('İndirme kuyruğu iptal edildi.', 'info');
      return;
    }
    showToast(`Yerel indirme hatası: ${err.message}`, 'error');
  } finally {
    setTimeout(() => progressBar?.classList.add('hidden'), 1200);
  }
}

async function resolveLocalDownloadConflicts(downloadQueue) {
  const conflicts = [];
  for (const item of downloadQueue) {
    const fullLocalRel = joinLocalPath(localState.currentPath, item.relativeLocalPath);
    const parts = fullLocalRel.split('/');
    const fileName = parts.pop();
    const dirRel = parts.join('/');

    try {
      const dirHandle = await getLocalDirHandle(dirRel, false);
      const fh = await dirHandle.getFileHandle(fileName, { create: false });
      const existingFile = await fh.getFile();
      conflicts.push({
        item,
        existingSize: existingFile.size,
        existingLastModified: existingFile.lastModified
      });
    } catch (_) {
      // No local file exists
    }
  }

  if (conflicts.length === 0) return downloadQueue;

  let remembered = null;
  const conflictMap = new Map(conflicts.map(c => [c.item.relativeLocalPath, c]));
  const finalQueue = [];
  const usedPaths = downloadQueue.map(i => i.relativeLocalPath);

  for (let i = 0; i < conflicts.length; i++) {
    const c = conflicts[i];
    let action = remembered;

    if (!action) {
      const res = await promptOverwriteModal(
        {
          relativePath: c.item.relativeLocalPath,
          size: c.existingSize,
          modifiedAt: c.existingLastModified ? new Date(c.existingLastModified).toISOString() : null
        },
        {
          file: {
            size: c.item.size,
            lastModified: c.item.modifiedAt ? new Date(c.item.modifiedAt).getTime() : Date.now()
          }
        },
        i + 1,
        conflicts.length,
        'download'
      );
      if (res.applyToAll) remembered = res.type;
      action = res.type;
    }

    if (action === 'skip') continue;
    if (action === 'overwrite') {
      finalQueue.push(c.item);
    } else if (action === 'overwrite_diff') {
      const sizeDiff = c.item.size !== c.existingSize;
      const dateDiff = c.item.modifiedAt && c.existingLastModified
        ? Math.abs(new Date(c.item.modifiedAt).getTime() - c.existingLastModified) > 60000
        : false;
      if (sizeDiff || dateDiff) {
        finalQueue.push(c.item);
      }
    } else if (action === 'rename') {
      const renamedRel = getRenamedPath(c.item.relativeLocalPath, usedPaths);
      usedPaths.push(renamedRel);
      finalQueue.push({ ...c.item, relativeLocalPath: renamedRel });
    }
  }

  for (const item of downloadQueue) {
    if (!conflictMap.has(item.relativeLocalPath)) {
      finalQueue.push(item);
    }
  }
  return finalQueue;
}

async function downloadSingleRemoteToLocal(remoteFullPath, relativeLocalPath, baseLocalRel = localState.currentPath) {
  const res = await fetch(`/api/download?path=${encodeURIComponent(remoteFullPath)}`, {
    headers: { 'x-session-id': currentSession.sessionId }
  });
  if (!res.ok) {
    let msg = 'Dosya indirilemedi.';
    try {
      const err = await res.json();
      if (err.error) msg = err.error;
    } catch (_) {}
    throw new Error(msg);
  }
  const blob = await res.blob();

  const fullLocalRel = joinLocalPath(baseLocalRel, relativeLocalPath);
  const parts = fullLocalRel.split('/');
  const filename = parts.pop();
  const dirRel = parts.join('/');

  const dirHandle = await getLocalDirHandle(dirRel, true);
  const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

// ==================== MAPPING & SYNCHRONIZED BROWSING ====================

async function mapCurrentDirectories() {
  if (!localState.provider || !currentSession) {
    showToast('Eşleme için hem yerel klasör seçilmeli hem de FTP bağlantısı kurulmalıdır.', 'error');
    return;
  }

  syncState.mapped = true;
  syncState.localBasePath = normalizeLocalRelPath(localState.currentPath);
  syncState.remoteBasePath = normalizeRemotePath(currentPath);
  syncState.syncBrowsing = true;
  syncState.compareEnabled = true;

  await persistCurrentMapping();
  updateSyncToolbarState();
  renderLocalBreadcrumb(localState.currentPath);
  if (typeof renderBreadcrumb === 'function') renderBreadcrumb(currentPath);
  refreshComparisonAndRender();

  const localDisplay = getLocalDisplayPath(syncState.localBasePath);
  addClientLog('success', `Klasörler eşlendi: "${localDisplay}" ↔ "${syncState.remoteBasePath}" (Eşzamanlı gezinme açık)`);
  showToast(`Eşlendi: ${localDisplay} ↔ ${syncState.remoteBasePath}`, 'success');
}

async function clearMapping() {
  syncState.mapped = false;
  syncState.syncBrowsing = false;
  syncState.pendingMissing = null;
  hideSyncWarning();

  const key = getConnectionMappingKey();
  if (key) {
    const map = getSavedMappingsMap();
    if (map[key]) {
      delete map[key];
      saveMappingsMap(map);
    }
    await HandlesDB.remove(key);
    renderRecentLocalMappings();
  }

  updateSyncToolbarState();
  renderLocalBreadcrumb(localState.currentPath);
  if (typeof renderBreadcrumb === 'function') renderBreadcrumb(currentPath);
  refreshComparisonAndRender();
  addClientLog('info', 'Klasör eşlemesi kaldırıldı.');
  showToast('Klasör eşlemesi kaldırıldı.', 'info');
}

async function persistCurrentMapping() {
  if (!syncState.mapped || !currentSession) return;
  const key = getConnectionMappingKey();
  if (!key) return;

  const map = getSavedMappingsMap();
  map[key] = {
    key,
    host: currentSession.host,
    port: currentSession.port || 21,
    user: currentSession.user || 'anonymous',
    localFolderName: localState.rootName,
    localBasePath: syncState.localBasePath,
    remoteBasePath: syncState.remoteBasePath,
    syncBrowsing: syncState.syncBrowsing,
    compareEnabled: syncState.compareEnabled,
    updatedAt: Date.now()
  };
  saveMappingsMap(map);

  if (localState.provider === 'fs_access' && localState.rootHandle) {
    await HandlesDB.save(key, localState.rootHandle);
  }
  renderRecentLocalMappings();
}

function toggleSyncBrowsing() {
  if (!localState.provider || !currentSession) return;
  if (!syncState.mapped) {
    mapCurrentDirectories();
    return;
  }

  syncState.syncBrowsing = !syncState.syncBrowsing;
  hideSyncWarning();
  updateSyncToolbarState();
  persistCurrentMapping();

  if (syncState.syncBrowsing) {
    addClientLog('info', 'Eşzamanlı gezinme (Synchronized Browsing) açıldı.');
    showToast('Eşzamanlı gezinme açık.', 'success');
  } else {
    addClientLog('info', 'Eşzamanlı gezinme kapatıldı.');
    showToast('Eşzamanlı gezinme kapatıldı.', 'info');
  }
}

function toggleCompareMode() {
  if (!localState.provider || !currentSession) return;
  syncState.compareEnabled = !syncState.compareEnabled;
  updateSyncToolbarState();
  persistCurrentMapping();
  refreshComparisonAndRender();

  showToast(
    syncState.compareEnabled ? 'Dizin karşılaştırma etkin.' : 'Dizin karşılaştırma kapatıldı.',
    'info'
  );
}

function updateSyncToolbarState() {
  const hasBoth = !!(localState.provider && currentSession);
  const mapBtn = document.getElementById('mapCurrentDirsBtn');
  const syncBtn = document.getElementById('syncBrowsingToggleBtn');
  const cmpBtn = document.getElementById('compareToggleBtn');
  const openSyncBtn = document.getElementById('openSyncModalBtn');
  const cmpOpts = document.getElementById('compareOptionsGroup');
  const badgeText = document.getElementById('mappingStatusText');
  const clearBtn = document.getElementById('clearMappingBtn');

  if (mapBtn) mapBtn.disabled = !hasBoth;
  if (syncBtn) syncBtn.disabled = !hasBoth;
  if (cmpBtn) cmpBtn.disabled = !hasBoth;
  if (openSyncBtn) openSyncBtn.disabled = !hasBoth;

  if (syncBtn) {
    if (syncState.syncBrowsing && hasBoth) {
      syncBtn.className = 'px-2.5 py-1 rounded-lg bg-sky-600 text-white border border-sky-400 font-semibold flex items-center gap-1.5 transition shadow-sm shadow-sky-600/30';
    } else {
      syncBtn.className = 'px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 border border-slate-700 font-medium flex items-center gap-1.5 transition';
    }
  }

  if (cmpBtn) {
    if (syncState.compareEnabled && hasBoth) {
      cmpBtn.className = 'px-2.5 py-1 rounded-lg bg-amber-600/80 text-white border border-amber-400/70 font-semibold flex items-center gap-1.5 transition';
    } else {
      cmpBtn.className = 'px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-300 border border-slate-700 font-medium flex items-center gap-1.5 transition';
    }
  }

  if (cmpOpts) {
    cmpOpts.classList.toggle('hidden', !(syncState.compareEnabled && hasBoth));
  }

  if (badgeText && clearBtn) {
    if (syncState.mapped && localState.provider) {
      const localLabel = getLocalDisplayPath(syncState.localBasePath);
      badgeText.innerHTML = `<span class="text-emerald-300 font-mono">${escapeHtml(localLabel)}</span> <span class="text-slate-500 mx-1">↔</span> <span class="text-sky-300 font-mono">${escapeHtml(syncState.remoteBasePath)}</span>`;
      clearBtn.classList.remove('hidden');
    } else {
      badgeText.innerText = localState.provider
        ? `Yerel: ${localState.rootName} (Henüz uzak dizine eşlenmedi)`
        : 'Eşleme yok — Yerel klasör ve uzak dizini bağlayın';
      clearBtn.classList.add('hidden');
    }
  }
}

async function onLocalNavigatedForSync() {
  if (!syncState.mapped || !syncState.syncBrowsing || !currentSession) return;
  const rel = getRelativeSubpath(syncState.localBasePath, localState.currentPath, false);

  if (rel === null) {
    syncState.syncBrowsing = false;
    updateSyncToolbarState();
    addClientLog('info', 'Eşlenen yerel kök dizin dışına çıkıldığı için eşzamanlı gezinme kapatıldı.');
    showToast('Eşlenen yerel kök dışına çıkıldı; eşzamanlı gezinme durduruldu.', 'info');
    return;
  }

  const targetRemote = joinRemotePath(syncState.remoteBasePath, rel);
  if (normalizeRemotePath(currentPath) === targetRemote) {
    hideSyncWarning();
    return;
  }

  syncState.isSyncNavigating = true;
  try {
    const res = await fetch(`/api/list?path=${encodeURIComponent(targetRemote)}`, {
      headers: { 'x-session-id': currentSession.sessionId }
    });
    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || 'Uzak dizin açılamadı.');
    }

    currentPath = normalizeRemotePath(data.currentDir);
    fileList = data.files || [];
    clearSelection();
    renderBreadcrumb(currentPath);
    refreshComparisonAndRender();
    hideSyncWarning();
  } catch (err) {
    showSyncWarning('remote', targetRemote, `Uzak sunucuda "${targetRemote}" klasörü bulunamadı.`);
    addClientLog('error', `Eşzamanlı gezinme: Uzak klasör yok (${targetRemote})`);
  } finally {
    syncState.isSyncNavigating = false;
  }
}

async function onRemoteNavigatedForSync(newRemotePath) {
  if (!syncState.mapped || !syncState.syncBrowsing || !localState.provider || syncState.isSyncNavigating) return;

  const rel = getRelativeSubpath(syncState.remoteBasePath, newRemotePath, true);
  if (rel === null) {
    syncState.syncBrowsing = false;
    updateSyncToolbarState();
    addClientLog('info', `Eşlenen uzak kök (${syncState.remoteBasePath}) dışına çıkıldığı için eşzamanlı gezinme kapatıldı.`);
    showToast('Eşlenen uzak kök dışına çıkıldı; eşzamanlı gezinme durduruldu.', 'info');
    return;
  }

  const targetLocal = joinLocalPath(syncState.localBasePath, rel);
  if (normalizeLocalRelPath(localState.currentPath) === targetLocal) {
    hideSyncWarning();
    return;
  }

  syncState.isSyncNavigating = true;
  try {
    let exists = false;
    if (localState.provider === 'fs_access') {
      try {
        await getLocalDirHandle(targetLocal, false);
        exists = true;
      } catch (_) {
        exists = false;
      }
    } else {
      exists = localState.virtualTree.has(targetLocal);
    }

    if (exists) {
      await loadLocalDirectory(targetLocal, { triggerSync: false });
      hideSyncWarning();
    } else {
      showSyncWarning('local', targetLocal, `Yerel klasörde "${getLocalDisplayPath(targetLocal)}" bulunamadı.`);
      addClientLog('error', `Eşzamanlı gezinme: Yerel klasör yok (${getLocalDisplayPath(targetLocal)})`);
    }
  } finally {
    syncState.isSyncNavigating = false;
  }
}

function showSyncWarning(side, targetPath, message) {
  syncState.pendingMissing = { side, targetPath };
  const banner = document.getElementById('syncWarningBanner');
  const text = document.getElementById('syncWarningText');
  const createBtn = document.getElementById('syncCreateMissingBtn');
  if (!banner || !text) return;

  text.innerText = message;
  if (createBtn) {
    const canCreate = side === 'remote' || (side === 'local' && canWriteToLocal());
    createBtn.classList.toggle('hidden', !canCreate);
    createBtn.innerText = side === 'remote' ? 'Uzakta Oluştur ve Geç' : 'Yerelde Oluştur ve Geç';
  }
  banner.classList.remove('hidden');
}

function hideSyncWarning() {
  syncState.pendingMissing = null;
  document.getElementById('syncWarningBanner')?.classList.add('hidden');
}

async function createMissingCounterpartAndSync() {
  const pending = syncState.pendingMissing;
  if (!pending) return;

  if (pending.side === 'remote' && currentSession) {
    try {
      const res = await fetch('/api/mkdir', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': currentSession.sessionId
        },
        body: JSON.stringify({ name: pending.targetPath })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      hideSyncWarning();
      await onLocalNavigatedForSync();
      showToast(`Uzak klasör oluşturuldu: ${pending.targetPath}`, 'success');
    } catch (err) {
      showToast(`Uzak klasör oluşturulamadı: ${err.message}`, 'error');
    }
  } else if (pending.side === 'local' && canWriteToLocal()) {
    try {
      await getLocalDirHandle(pending.targetPath, true);
      hideSyncWarning();
      await onRemoteNavigatedForSync(currentPath);
      showToast(`Yerel klasör oluşturuldu: ${pending.targetPath}`, 'success');
    } catch (err) {
      showToast(`Yerel klasör oluşturulamadı: ${err.message}`, 'error');
    }
  }
}

// ==================== SAVED MAPPING RECONNECTION ====================

async function checkAndOfferSavedMapping(session) {
  const key = getConnectionMappingKey(session);
  if (!key) return;
  const map = getSavedMappingsMap();
  const saved = map[key];
  if (!saved) return;

  const handle = await HandlesDB.get(key);
  if (!handle) return;

  // If browser already grants permission, auto-restore
  if (handle.queryPermission) {
    try {
      const rwPerm = await handle.queryPermission({ mode: 'readwrite' });
      if (rwPerm === 'granted') {
        await restoreSavedMapping(saved, handle, true);
        return;
      }
      const rPerm = await handle.queryPermission({ mode: 'read' });
      if (rPerm === 'granted') {
        await restoreSavedMapping(saved, handle, false);
        return;
      }
    } catch (_) {}
  }

  // Otherwise show 1-click reconnect banner (Chromium requires user gesture for requestPermission)
  syncState.pendingReconnectMapping = { key, mapping: saved, handle };
  const banner = document.getElementById('savedMappingBanner');
  const text = document.getElementById('savedMappingBannerText');
  if (banner && text) {
    const localDisp = saved.localBasePath ? `${saved.localFolderName}/${saved.localBasePath}` : saved.localFolderName;
    text.innerHTML = `Kayıtlı eşleme: <strong class="text-emerald-300">${escapeHtml(localDisp)}</strong> ↔ <strong class="text-sky-300">${escapeHtml(saved.remoteBasePath)}</strong>`;
    banner.classList.remove('hidden');
  }
}

async function restoreSavedMapping(saved, handle, canWrite) {
  syncState.mapped = true;
  syncState.localBasePath = normalizeLocalRelPath(saved.localBasePath || '');
  syncState.remoteBasePath = normalizeRemotePath(saved.remoteBasePath || '/');
  syncState.syncBrowsing = saved.syncBrowsing !== false;
  syncState.compareEnabled = saved.compareEnabled !== false;

  await activateFsAccessHandle(handle, canWrite, syncState.localBasePath, false);

  if (currentSession && normalizeRemotePath(currentPath) !== syncState.remoteBasePath) {
    syncState.isSyncNavigating = true;
    try {
      await loadDirectory(syncState.remoteBasePath);
    } finally {
      syncState.isSyncNavigating = false;
    }
  }

  updateSyncToolbarState();
  renderLocalBreadcrumb(localState.currentPath);
  if (typeof renderBreadcrumb === 'function') renderBreadcrumb(currentPath);
  refreshComparisonAndRender();
  showToast(`Kayıtlı eşleme geri yüklendi: ${saved.localFolderName}`, 'success');
}

async function reconnectSavedMapping() {
  const pending = syncState.pendingReconnectMapping;
  if (!pending || !pending.handle) return;

  try {
    let perm = 'denied';
    let canWrite = false;
    if (pending.handle.requestPermission) {
      perm = await pending.handle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        canWrite = true;
      } else {
        perm = await pending.handle.requestPermission({ mode: 'read' });
      }
    }
    if (perm !== 'granted') {
      showToast('Yerel klasör erişim izni verilmedi.', 'error');
      return;
    }

    await restoreSavedMapping(pending.mapping, pending.handle, canWrite);
  } catch (err) {
    showToast(`Klasör yeniden bağlanamadı: ${err.message}`, 'error');
  }
}

async function forgetSavedMapping() {
  const pending = syncState.pendingReconnectMapping;
  if (pending) {
    const map = getSavedMappingsMap();
    delete map[pending.key];
    saveMappingsMap(map);
    await HandlesDB.remove(pending.key);
    syncState.pendingReconnectMapping = null;
    renderRecentLocalMappings();
  }
  hideSavedMappingBanner();
}

function hideSavedMappingBanner() {
  document.getElementById('savedMappingBanner')?.classList.add('hidden');
}

function renderRecentLocalMappings() {
  const box = document.getElementById('recentLocalMappingsBox');
  const list = document.getElementById('recentLocalMappingsList');
  if (!box || !list) return;

  const entries = Object.values(getSavedMappingsMap()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  if (entries.length === 0) {
    box.classList.add('hidden');
    return;
  }

  box.classList.remove('hidden');
  list.innerHTML = entries.slice(0, 5).map(m => {
    const localDisp = m.localBasePath ? `${m.localFolderName}/${m.localBasePath}` : m.localFolderName;
    return `
      <div class="flex items-center justify-between gap-2 p-2 rounded-xl bg-slate-950 border border-slate-800 hover:border-slate-700 transition">
        <div class="min-w-0">
          <div class="text-xs font-semibold text-emerald-300 truncate"><i class="fa-solid fa-folder mr-1"></i>${escapeHtml(localDisp)}</div>
          <div class="text-[11px] text-slate-400 font-mono truncate">${escapeHtml(m.user)}@${escapeHtml(m.host)} → ${escapeHtml(m.remoteBasePath)}</div>
        </div>
        <button type="button" onclick="openSavedMappingByKey('${escapeAttrArg(m.key)}')" class="px-2.5 py-1 rounded-lg bg-emerald-600/20 hover:bg-emerald-600 text-emerald-300 hover:text-white text-[11px] font-medium transition flex-none">
          Aç
        </button>
      </div>`;
  }).join('');
}

async function openSavedMappingByKey(key) {
  const map = getSavedMappingsMap();
  const saved = map[key];
  const handle = await HandlesDB.get(key);
  if (!saved || !handle) {
    showToast('Kayıtlı klasör erişimi artık mevcut değil, lütfen yeniden seçin.', 'info');
    return;
  }
  syncState.pendingReconnectMapping = { key, mapping: saved, handle };
  await reconnectSavedMapping();
}

// ==================== DIRECTORY COMPARISON ====================

function compareFileEntries(localFile, remoteFile, criteria = 'size_time') {
  if (localFile && !remoteFile) return 'local_only';
  if (!localFile && remoteFile) return 'remote_only';
  if (!localFile && !remoteFile) return 'same';

  if (localFile.isDirectory && remoteFile.isDirectory) return 'both_dir';
  if (localFile.isDirectory !== remoteFile.isDirectory) return 'size_diff';

  if ((localFile.size || 0) !== (remoteFile.size || 0)) {
    return 'size_diff';
  }

  if (criteria === 'size_time' && localFile.modifiedAt && remoteFile.modifiedAt) {
    const localMs = new Date(localFile.modifiedAt).getTime();
    const remoteMs = new Date(remoteFile.modifiedAt).getTime();
    const TOLERANCE_MS = 60 * 1000; // FTP LIST often omits seconds
    if (localMs - remoteMs > TOLERANCE_MS) return 'local_newer';
    if (remoteMs - localMs > TOLERANCE_MS) return 'remote_newer';
  }

  return 'same';
}

function getComparisonMeta(status, side) {
  switch (status) {
    case 'local_only':
      return {
        status,
        rowClass: 'cmp-row-local-only',
        badgeHtml: '<span class="px-1.5 py-0.5 rounded text-[9px] leading-none whitespace-nowrap bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 flex-none">Sadece Yerel</span>'
      };
    case 'remote_only':
      return {
        status,
        rowClass: 'cmp-row-remote-only',
        badgeHtml: '<span class="px-1.5 py-0.5 rounded text-[9px] leading-none whitespace-nowrap bg-sky-500/20 text-sky-300 border border-sky-500/30 flex-none">Sadece Uzak</span>'
      };
    case 'size_diff':
      return {
        status,
        rowClass: 'cmp-row-diff',
        badgeHtml: '<span class="px-1.5 py-0.5 rounded text-[9px] leading-none whitespace-nowrap bg-rose-500/20 text-rose-300 border border-rose-500/30 flex-none">Boyut Farklı</span>'
      };
    case 'local_newer':
      return {
        status,
        rowClass: side === 'local' ? 'cmp-row-newer' : 'cmp-row-older',
        badgeHtml: side === 'local'
          ? '<span class="px-1.5 py-0.5 rounded text-[9px] leading-none whitespace-nowrap bg-amber-500/20 text-amber-300 border border-amber-500/30 flex-none">Yerel Yeni</span>'
          : '<span class="px-1.5 py-0.5 rounded text-[9px] leading-none whitespace-nowrap bg-slate-700/60 text-slate-300 border border-slate-600/60 flex-none">Eski</span>'
      };
    case 'remote_newer':
      return {
        status,
        rowClass: side === 'remote' ? 'cmp-row-newer' : 'cmp-row-older',
        badgeHtml: side === 'remote'
          ? '<span class="px-1.5 py-0.5 rounded text-[9px] leading-none whitespace-nowrap bg-amber-500/20 text-amber-300 border border-amber-500/30 flex-none">Uzak Yeni</span>'
          : '<span class="px-1.5 py-0.5 rounded text-[9px] leading-none whitespace-nowrap bg-slate-700/60 text-slate-300 border border-slate-600/60 flex-none">Eski</span>'
      };
    case 'same':
      return {
        status,
        rowClass: '',
        badgeHtml: '<span class="text-[10px] leading-none text-emerald-500/70 flex-none" title="Eşit"><i class="fa-solid fa-check"></i></span>'
      };
    default:
      return { status, rowClass: '', badgeHtml: '' };
  }
}

function getRemoteFilesListSafe() {
  if (typeof fileList !== 'undefined' && Array.isArray(fileList)) return fileList;
  if (typeof window !== 'undefined' && Array.isArray(window.fileList)) return window.fileList;
  return [];
}

let isReRenderingComparison = false;
function syncComparisonRerender(caller) {
  if (isReRenderingComparison) return;
  if (!syncState.compareEnabled || !localState.provider || !currentSession) return;
  isReRenderingComparison = true;
  try {
    if (caller === 'local' && typeof renderFileList === 'function') {
      renderFileList(document.getElementById('searchInput')?.value.trim() || '');
    } else if (caller === 'remote' && typeof renderLocalFileList === 'function') {
      renderLocalFileList(document.getElementById('localSearchInput')?.value.trim() || '');
    }
  } finally {
    isReRenderingComparison = false;
  }
}

function computeComparison() {
  syncState.comparison.localMap.clear();
  syncState.comparison.remoteMap.clear();

  if (!syncState.compareEnabled || !localState.provider || !currentSession) return;

  const remotes = getRemoteFilesListSafe();
  const localByName = new Map(localState.files.map(f => [f.name, f]));
  const remoteByName = new Map(remotes.map(f => [f.name, f]));
  const allNames = new Set([...localByName.keys(), ...remoteByName.keys()]);

  for (const name of allNames) {
    const lf = localByName.get(name) || null;
    const rf = remoteByName.get(name) || null;
    const status = compareFileEntries(lf, rf, syncState.compareCriteria);

    if (lf) syncState.comparison.localMap.set(name, getComparisonMeta(status, 'local'));
    if (rf) syncState.comparison.remoteMap.set(name, getComparisonMeta(status, 'remote'));
  }
}

function getAlignedComparisonSlots(localFilterQuery = '', remoteFilterQuery = '') {
  const isComparing = Boolean(syncState.compareEnabled && localState.provider && currentSession);
  if (!isComparing) return null;

  // 1. Filter local files
  let localEntries = Array.isArray(localState.files) ? [...localState.files] : [];
  if (localFilterQuery) {
    const q = localFilterQuery.toLowerCase();
    localEntries = localEntries.filter(f => f.name.toLowerCase().includes(q));
  }
  if (syncState.compareDiffOnly) {
    localEntries = localEntries.filter(f => {
      const cmp = syncState.comparison.localMap.get(f.name);
      return !cmp || (cmp.status !== 'same' && cmp.status !== 'both_dir');
    });
  }

  // 2. Filter remote files
  const remotes = getRemoteFilesListSafe();
  let remoteEntries = Array.isArray(remotes) ? [...remotes] : [];
  if (remoteFilterQuery) {
    const q = remoteFilterQuery.toLowerCase();
    remoteEntries = remoteEntries.filter(f => f.name.toLowerCase().includes(q));
  }
  if (syncState.compareDiffOnly) {
    remoteEntries = remoteEntries.filter(f => {
      const cmp = syncState.comparison.remoteMap.get(f.name);
      return !cmp || (cmp.status !== 'same' && cmp.status !== 'both_dir');
    });
  }

  // 3. Separate folders and files
  const localDirs = localEntries.filter(f => f.isDirectory);
  const localFiles = localEntries.filter(f => !f.isDirectory);
  const remoteDirs = remoteEntries.filter(f => f.isDirectory);
  const remoteFiles = remoteEntries.filter(f => !f.isDirectory);

  const localDirMap = new Map(localDirs.map(f => [f.name, f]));
  const localFileMap = new Map(localFiles.map(f => [f.name, f]));
  const remoteDirMap = new Map(remoteDirs.map(f => [f.name, f]));
  const remoteFileMap = new Map(remoteFiles.map(f => [f.name, f]));

  // Union of directory names
  const dirNames = Array.from(new Set([
    ...localDirs.map(d => d.name),
    ...remoteDirs.map(d => d.name)
  ]));

  // Union of file names
  const fileNames = Array.from(new Set([
    ...localFiles.map(f => f.name),
    ...remoteFiles.map(f => f.name)
  ]));

  // Sorting
  const activeSortField = localState.sortField || 'name';
  const activeSortDir = localState.sortDirection || 'asc';

  function compareSlotNames(a, b, isDir) {
    if (activeSortField === 'size' && !isDir) {
      const sizeA = Math.max(localFileMap.get(a)?.size || 0, remoteFileMap.get(a)?.size || 0);
      const sizeB = Math.max(localFileMap.get(b)?.size || 0, remoteFileMap.get(b)?.size || 0);
      return activeSortDir === 'asc' ? sizeA - sizeB : sizeB - sizeA;
    }
    if (activeSortField === 'modifiedAt') {
      const getT = (name) => {
        const item = isDir ? (localDirMap.get(name) || remoteDirMap.get(name)) : (localFileMap.get(name) || remoteFileMap.get(name));
        return item && item.modifiedAt ? new Date(item.modifiedAt).getTime() : 0;
      };
      const tA = getT(a);
      const tB = getT(b);
      return activeSortDir === 'asc' ? tA - tB : tB - tA;
    }
    return activeSortDir === 'asc'
      ? a.localeCompare(b, undefined, { sensitivity: 'base' })
      : b.localeCompare(a, undefined, { sensitivity: 'base' });
  }

  dirNames.sort((a, b) => compareSlotNames(a, b, true));
  fileNames.sort((a, b) => compareSlotNames(a, b, false));

  const slots = [
    ...dirNames.map(name => ({ type: 'dir', name })),
    ...fileNames.map(name => ({ type: 'file', name }))
  ];

  return {
    slots,
    localDirMap,
    localFileMap,
    remoteDirMap,
    remoteFileMap
  };
}

function refreshComparisonAndRender() {
  if (syncState.compareEnabled && localState.provider && currentSession) {
    computeComparison();
  } else {
    syncState.comparison.localMap.clear();
    syncState.comparison.remoteMap.clear();
  }
  renderLocalFileList(document.getElementById('localSearchInput')?.value.trim() || '');
  if (typeof renderFileList === 'function') {
    renderFileList(document.getElementById('searchInput')?.value.trim() || '');
  }
}

function getRemoteComparisonInfo(fileName) {
  if (!syncState.compareEnabled || !localState.provider || !currentSession) return null;
  return syncState.comparison.remoteMap.get(fileName) || null;
}

function shouldHideRemoteInDiffOnly(fileName) {
  if (!syncState.compareEnabled || !syncState.compareDiffOnly || !localState.provider || !currentSession) return false;
  const cmp = syncState.comparison.remoteMap.get(fileName);
  return cmp && (cmp.status === 'same' || cmp.status === 'both_dir');
}

// ==================== FOLDER SYNC WIZARD (KLASÖRLERİ EŞİTLE) ====================

function openSyncModal() {
  if (!localState.provider || !currentSession) {
    showToast('Eşitleme için yerel klasör seçili ve FTP bağlı olmalıdır.', 'error');
    return;
  }

  // Determine aligned base pair: use current directories if aligned, else mapped base or current pair
  let localBase = localState.currentPath;
  let remoteBase = normalizeRemotePath(currentPath);

  if (syncState.mapped) {
    const relL = getRelativeSubpath(syncState.localBasePath, localState.currentPath, false);
    const relR = getRelativeSubpath(syncState.remoteBasePath, currentPath, true);
    if (relL !== null && relR !== null && relL === relR) {
      localBase = localState.currentPath;
      remoteBase = normalizeRemotePath(currentPath);
    } else {
      localBase = syncState.localBasePath;
      remoteBase = syncState.remoteBasePath;
    }
  }

  syncState.syncBaseLocalPath = localBase;
  syncState.syncBaseRemotePath = remoteBase;
  syncState.syncPlanItems = [];

  const pairLabel = document.getElementById('syncModalPairLabel');
  if (pairLabel) {
    pairLabel.innerText = `📁 ${getLocalDisplayPath(localBase)} ↔ 🌐 ${remoteBase}`;
  }

  const dirSelect = document.getElementById('syncDirectionSelect');
  if (dirSelect) {
    const r2lOpt = dirSelect.querySelector('option[value="remote_to_local"]');
    const biOpt = dirSelect.querySelector('option[value="bidirectional"]');
    if (r2lOpt) r2lOpt.disabled = !canWriteToLocal();
    if (biOpt) biOpt.disabled = !canWriteToLocal();
    if (!canWriteToLocal() && dirSelect.value !== 'local_to_remote') {
      dirSelect.value = 'local_to_remote';
    }
  }

  document.getElementById('syncSummaryBar')?.classList.add('hidden');
  document.getElementById('syncPreviewTable')?.classList.add('hidden');
  document.getElementById('syncEmptyHint')?.classList.remove('hidden');
  document.getElementById('syncExecProgressWrap')?.classList.add('hidden');
  const execBtn = document.getElementById('executeSyncBtn');
  if (execBtn) execBtn.disabled = true;

  openModal('syncModal');
}

async function scanLocalTreeForSync(baseRelPath, recursive, excludeSet) {
  const results = new Map(); // relPath -> entry

  if (localState.provider === 'fs_access') {
    const baseHandle = await getLocalDirHandle(baseRelPath, false);
    async function walk(dirHandle, prefix) {
      for await (const [name, handle] of dirHandle.entries()) {
        if (excludeSet.has(name)) continue;
        const rel = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === 'directory') {
          results.set(rel, {
            relativePath: rel,
            name,
            isDirectory: true,
            size: 0,
            modifiedAt: null,
            handle,
            file: null
          });
          if (recursive) {
            await walk(handle, rel);
          }
        } else {
          const file = await handle.getFile();
          results.set(rel, {
            relativePath: rel,
            name,
            isDirectory: false,
            size: file.size,
            modifiedAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
            handle,
            file
          });
        }
      }
    }
    await walk(baseHandle, '');
  } else {
    const baseClean = normalizeLocalRelPath(baseRelPath);
    function walkVirtual(vPath, prefix) {
      const list = localState.virtualTree.get(vPath) || [];
      for (const entry of list) {
        if (excludeSet.has(entry.name)) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        results.set(rel, {
          relativePath: rel,
          name: entry.name,
          isDirectory: entry.isDirectory,
          size: entry.size || 0,
          modifiedAt: entry.modifiedAt,
          handle: null,
          file: entry.file
        });
        if (entry.isDirectory && recursive) {
          walkVirtual(joinLocalPath(vPath, entry.name), rel);
        }
      }
    }
    walkVirtual(baseClean, '');
  }

  return results;
}

async function scanRemoteTreeForSync(baseRemotePath, recursive, excludeArr) {
  const results = new Map();
  if (!recursive && normalizeRemotePath(currentPath) === normalizeRemotePath(baseRemotePath)) {
    const excludeSet = new Set(excludeArr);
    for (const f of fileList) {
      if (f.isSymbolicLink || excludeSet.has(f.name)) continue;
      results.set(f.name, {
        relativePath: f.name,
        name: f.name,
        isDirectory: f.isDirectory,
        size: f.size || 0,
        modifiedAt: f.modifiedAt || null
      });
    }
    return results;
  }

  const res = await fetch('/api/list-tree', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-id': currentSession.sessionId
    },
    body: JSON.stringify({
      basePath: baseRemotePath,
      maxDepth: recursive ? 10 : 0,
      exclude: excludeArr
    })
  });
  const data = await res.json();
  if (!data.success) throw new Error(data.error || 'Uzak dizin taranamadı.');
  if (data.truncated) {
    showToast('Uyarı: Uzak sunucuda 5000+ öğe bulunduğu için tarama sınırlandı.', 'info');
  }
  for (const entry of data.entries) {
    results.set(entry.relativePath, entry);
  }
  return results;
}

async function scanSyncDifferences() {
  const scanBtn = document.getElementById('scanSyncDiffBtn');
  const origHtml = scanBtn.innerHTML;
  scanBtn.disabled = true;
  scanBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i> Taranıyor...';

  const direction = document.getElementById('syncDirectionSelect').value;
  const recursive = document.getElementById('syncScopeSelect').value === 'recursive';
  const criteria = document.getElementById('syncCriteriaSelect').value;
  const deleteOrphans = document.getElementById('syncDeleteOrphansCheck').checked;
  const excludeRaw = document.getElementById('syncExcludeInput').value || '';
  const excludeArr = excludeRaw.split(',').map(s => s.trim()).filter(Boolean);
  const excludeSet = new Set(excludeArr);

  try {
    const localMap = await scanLocalTreeForSync(syncState.syncBaseLocalPath, recursive, excludeSet);
    const remoteMap = await scanRemoteTreeForSync(syncState.syncBaseRemotePath, recursive, excludeArr);

    const allKeys = Array.from(new Set([...localMap.keys(), ...remoteMap.keys()])).sort((a, b) => a.localeCompare(b));
    const plan = [];

    for (const relPath of allKeys) {
      const l = localMap.get(relPath) || null;
      const r = remoteMap.get(relPath) || null;
      const status = compareFileEntries(l, r, criteria);

      let action = 'skip';
      if (l && !r) {
        if (direction === 'local_to_remote' || direction === 'bidirectional') {
          action = l.isDirectory ? 'mkdir_remote' : 'upload';
        } else if (direction === 'remote_to_local' && deleteOrphans) {
          action = 'delete_local';
        }
      } else if (!l && r) {
        if (direction === 'remote_to_local' || direction === 'bidirectional') {
          action = r.isDirectory ? 'mkdir_local' : 'download';
        } else if (direction === 'local_to_remote' && deleteOrphans) {
          action = 'delete_remote';
        }
      } else if (l && r) {
        if (l.isDirectory && r.isDirectory) {
          action = 'skip';
        } else if (status === 'size_diff' || status === 'local_newer' || status === 'remote_newer') {
          if (direction === 'local_to_remote') {
            action = l.isDirectory ? 'skip' : 'upload';
          } else if (direction === 'remote_to_local') {
            action = r.isDirectory ? 'skip' : 'download';
          } else if (direction === 'bidirectional') {
            if (status === 'remote_newer') {
              action = r.isDirectory ? 'skip' : 'download';
            } else {
              action = l.isDirectory ? 'skip' : 'upload';
            }
          }
        }
      }

      if ((action === 'download' || action === 'mkdir_local' || action === 'delete_local') && !canWriteToLocal()) {
        action = 'skip';
      }

      plan.push({
        relativePath: relPath,
        isDirectory: (l && l.isDirectory) || (r && r.isDirectory),
        local: l,
        remote: r,
        status,
        action,
        selected: action !== 'skip'
      });
    }

    syncState.syncPlanItems = plan;
    document.getElementById('syncEmptyHint')?.classList.add('hidden');
    document.getElementById('syncSummaryBar')?.classList.remove('hidden');
    document.getElementById('syncPreviewTable')?.classList.remove('hidden');

    renderSyncPreviewRows();
  } catch (err) {
    showToast(`Tarama hatası: ${err.message}`, 'error');
  } finally {
    scanBtn.disabled = false;
    scanBtn.innerHTML = origHtml;
  }
}

function updateSyncSummaryCounts() {
  const plan = syncState.syncPlanItems;
  let up = 0, down = 0, del = 0, same = 0;

  for (const item of plan) {
    if (item.status === 'same' || item.status === 'both_dir') same++;
    if (!item.selected) continue;
    if (item.action === 'upload' || item.action === 'mkdir_remote') up++;
    else if (item.action === 'download' || item.action === 'mkdir_local') down++;
    else if (item.action === 'delete_remote' || item.action === 'delete_local') del++;
  }

  document.getElementById('syncCountUpload').innerText = `↑ ${up} Yüklenecek`;
  document.getElementById('syncCountDownload').innerText = `↓ ${down} İndirilecek`;
  document.getElementById('syncCountDelete').innerText = `✕ ${del} Silinecek`;
  document.getElementById('syncCountSame').innerText = `✓ ${same} Eşit`;

  const execBtn = document.getElementById('executeSyncBtn');
  if (execBtn) execBtn.disabled = (up + down + del) === 0;
}

function renderSyncPreviewRows() {
  const tbody = document.getElementById('syncPreviewBody');
  if (!tbody) return;

  const hideIdentical = document.getElementById('syncHideIdenticalCheck')?.checked;
  const statusLabels = {
    local_only: '<span class="text-emerald-300">Sadece Yerel</span>',
    remote_only: '<span class="text-sky-300">Sadece Uzak</span>',
    size_diff: '<span class="text-rose-300">Boyut Farklı</span>',
    local_newer: '<span class="text-amber-300">Yerel Yeni</span>',
    remote_newer: '<span class="text-indigo-300">Uzak Yeni</span>',
    same: '<span class="text-slate-500">Eşit</span>',
    both_dir: '<span class="text-slate-500">Ortak Klasör</span>'
  };

  const actionBadges = {
    upload: '<span class="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-semibold">↑ Yükle</span>',
    mkdir_remote: '<span class="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-semibold">↑ Klasör Aç</span>',
    download: '<span class="px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 font-semibold">↓ İndir</span>',
    mkdir_local: '<span class="px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 font-semibold">↓ Klasör Aç</span>',
    delete_remote: '<span class="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 font-semibold">✕ Uzaktan Sil</span>',
    delete_local: '<span class="px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 font-semibold">✕ Yerelden Sil</span>',
    skip: '<span class="text-slate-500">— Atla</span>'
  };

  let visibleCount = 0;
  const rows = [];

  syncState.syncPlanItems.forEach((item, idx) => {
    const isSame = item.status === 'same' || item.status === 'both_dir';
    if (hideIdentical && isSame) return;
    visibleCount++;

    const localStr = item.local
      ? (item.local.isDirectory ? '<span class="text-slate-500">[Klasör]</span>' : formatBytes(item.local.size))
      : '<span class="text-slate-600">—</span>';
    const remoteStr = item.remote
      ? (item.remote.isDirectory ? '<span class="text-slate-500">[Klasör]</span>' : formatBytes(item.remote.size))
      : '<span class="text-slate-600">—</span>';

    const disabledCheck = item.action === 'skip' ? 'disabled' : '';
    rows.push(`
      <tr class="hover:bg-slate-800/40">
        <td class="py-1.5 pl-4 pr-1 text-center">
          <input type="checkbox" ${item.selected ? 'checked' : ''} ${disabledCheck} onchange="toggleSyncItemRow(${idx}, this.checked)"
            class="rounded bg-slate-800 border-slate-700 text-emerald-500 focus:ring-0 cursor-pointer">
        </td>
        <td class="py-1.5 px-2 truncate max-w-[240px] text-slate-200" title="${escapeHtml(item.relativePath)}">
          ${item.isDirectory ? '<i class="fa-solid fa-folder text-amber-400 mr-1.5"></i>' : '<i class="fa-regular fa-file text-slate-400 mr-1.5"></i>'}
          ${escapeHtml(item.relativePath)}
        </td>
        <td class="py-1.5 px-2 text-right text-slate-300">${localStr}</td>
        <td class="py-1.5 px-2 text-center">${actionBadges[item.action] || item.action}</td>
        <td class="py-1.5 px-2 text-right text-slate-300">${remoteStr}</td>
        <td class="py-1.5 px-3 text-[11px]">${statusLabels[item.status] || item.status}</td>
      </tr>
    `);
  });

  if (visibleCount === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-slate-500 font-sans">Tüm dosya ve klasörler senkronize görünüyor.</td></tr>`;
  } else {
    tbody.innerHTML = rows.join('');
  }

  updateSyncSummaryCounts();
}

function toggleSyncItemRow(index, checked) {
  const item = syncState.syncPlanItems[index];
  if (!item) return;
  item.selected = checked;
  updateSyncSummaryCounts();
}

function toggleAllSyncItems(checked) {
  syncState.syncPlanItems.forEach(item => {
    if (item.action !== 'skip') item.selected = checked;
  });
  renderSyncPreviewRows();
}

async function executeSyncPlan() {
  const activeItems = syncState.syncPlanItems.filter(i => i.selected && i.action !== 'skip');
  if (activeItems.length === 0) return;

  const execBtn = document.getElementById('executeSyncBtn');
  const progressWrap = document.getElementById('syncExecProgressWrap');
  const statusEl = document.getElementById('syncExecStatusText');
  const pctEl = document.getElementById('syncExecPercent');
  const fillEl = document.getElementById('syncExecProgressFill');

  execBtn.disabled = true;
  progressWrap.classList.remove('hidden');

  const mkdirRemoteItems = activeItems.filter(i => i.action === 'mkdir_remote');
  const uploadPlanItems = activeItems.filter(i => i.action === 'upload');
  const mkdirLocalItems = activeItems.filter(i => i.action === 'mkdir_local');
  const downloadPlanItems = activeItems.filter(i => i.action === 'download');
  const deleteRemoteItems = activeItems.filter(i => i.action === 'delete_remote');
  const deleteLocalItems = activeItems.filter(i => i.action === 'delete_local');

  const totalOps = activeItems.length;
  let completedOps = 0;

  const updateProgress = (msg) => {
    const pct = Math.min(100, Math.round((completedOps / totalOps) * 100));
    if (statusEl) statusEl.innerText = msg;
    if (pctEl) pctEl.innerText = `${pct}%`;
    if (fillEl) fillEl.style.width = `${pct}%`;
  };

  try {
    // 1. Create remote empty directories
    if (mkdirRemoteItems.length > 0) {
      updateProgress('Uzak klasörler oluşturuluyor...');
      const res = await fetch('/api/mkdir-batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': currentSession.sessionId
        },
        body: JSON.stringify({
          baseDir: syncState.syncBaseRemotePath,
          paths: mkdirRemoteItems.map(i => i.relativePath)
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      completedOps += mkdirRemoteItems.length;
      updateProgress('Uzak klasörler oluşturuldu.');
    }

    // 2. Upload local files in safe batches (max 10 files & <= 20MB per batch)
    if (uploadPlanItems.length > 0) {
      const batches = [];
      let currentBatch = [];
      let currentBytes = 0;
      const MAX_BATCH_BYTES = 20 * 1024 * 1024;

      for (const item of uploadPlanItems) {
        const fileObj = item.local.file || await item.local.handle.getFile();
        if (currentBatch.length >= 10 || (currentBatch.length > 0 && currentBytes + fileObj.size > MAX_BATCH_BYTES)) {
          batches.push(currentBatch);
          currentBatch = [];
          currentBytes = 0;
        }
        currentBatch.push({ file: fileObj, relativePath: item.relativePath });
        currentBytes += fileObj.size;
      }
      if (currentBatch.length > 0) batches.push(currentBatch);

      for (const batch of batches) {
        updateProgress(`Yükleniyor: ${batch[0].relativePath}...`);
        const formData = new FormData();
        const rels = [];
        for (const b of batch) {
          formData.append('files', b.file);
          rels.push(b.relativePath);
        }
        formData.append('paths', JSON.stringify(rels));
        formData.append('baseDir', syncState.syncBaseRemotePath);

        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'x-session-id': currentSession.sessionId },
          body: formData
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Yükleme hatası');

        completedOps += batch.length;
        updateProgress(`${completedOps}/${totalOps} tamamlandı`);
      }
    }

    // 3. Create local directories
    if (mkdirLocalItems.length > 0 && canWriteToLocal()) {
      updateProgress('Yerel klasörler oluşturuluyor...');
      for (const item of mkdirLocalItems) {
        await getLocalDirHandle(joinLocalPath(syncState.syncBaseLocalPath, item.relativePath), true);
        completedOps++;
        updateProgress(`Yerel klasör: ${item.relativePath}`);
      }
    }

    // 4. Download remote files directly into local directory
    if (downloadPlanItems.length > 0 && canWriteToLocal()) {
      for (const item of downloadPlanItems) {
        updateProgress(`İndiriliyor: ${item.relativePath}`);
        const remoteFull = joinRemotePath(syncState.syncBaseRemotePath, item.relativePath);
        await downloadSingleRemoteToLocal(remoteFull, item.relativePath, syncState.syncBaseLocalPath);
        completedOps++;
        updateProgress(`${completedOps}/${totalOps} tamamlandı`);
      }
    }

    // 5. Optional orphan deletions (deepest paths first)
    if (deleteRemoteItems.length > 0) {
      updateProgress('Uzak fazla öğeler siliniyor...');
      const sortedRemoteDel = [...deleteRemoteItems].sort((a, b) => b.relativePath.length - a.relativePath.length);
      const res = await fetch('/api/delete-batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-session-id': currentSession.sessionId
        },
        body: JSON.stringify({
          baseDir: syncState.syncBaseRemotePath,
          items: sortedRemoteDel.map(i => ({ path: i.relativePath, isDirectory: i.isDirectory }))
        })
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      completedOps += deleteRemoteItems.length;
    }

    if (deleteLocalItems.length > 0 && canWriteToLocal()) {
      updateProgress('Yerel fazla öğeler siliniyor...');
      const sortedLocalDel = [...deleteLocalItems].sort((a, b) => b.relativePath.length - a.relativePath.length);
      for (const item of sortedLocalDel) {
        const fullLocal = joinLocalPath(syncState.syncBaseLocalPath, item.relativePath);
        const parts = fullLocal.split('/');
        const name = parts.pop();
        const parentRel = parts.join('/');
        try {
          const parentHandle = await getLocalDirHandle(parentRel, false);
          await parentHandle.removeEntry(name, { recursive: !!item.isDirectory });
        } catch (_) {
          // already removed as child of deleted parent folder
        }
        completedOps++;
      }
    }

    updateProgress('Senkronizasyon tamamlandı!');
    addClientLog('success', `Klasör eşitleme tamamlandı (${totalOps} işlem).`);
    showToast(`Eşitleme başarıyla tamamlandı (${totalOps} işlem).`, 'success');

    await loadLocalDirectory(localState.currentPath, { triggerSync: false });
    await loadDirectory(currentPath);
    closeModal('syncModal');
  } catch (err) {
    showToast(`Senkronizasyon hatası: ${err.message}`, 'error');
    addClientLog('error', `Senkronizasyon hatası: ${err.message}`);
    execBtn.disabled = false;
  }
}

// ==================== INTER-PANE DRAG & DROP & CONTEXT MENU ====================

function setupInterPaneDragAndDrop() {
  const remotePane = document.getElementById('remotePane');
  const localPane = document.getElementById('localPane');

  if (remotePane) {
    remotePane.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('application/x-cloudftp-local')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    remotePane.addEventListener('drop', async (e) => {
      const raw = e.dataTransfer.getData('application/x-cloudftp-local');
      if (!raw) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        const payload = JSON.parse(raw);
        if (payload.multiple && Array.isArray(payload.names) && payload.names.length > 0) {
          if (!currentSession) {
            showToast('Önce FTP sunucusuna bağlanmalısınız.', 'error');
            return;
          }
          const items = await collectLocalItemsForUpload(localState.currentPath, payload.names, true);
          if (items.length > 0) await uploadItems(items);
        } else {
          await uploadLocalItemToRemote(payload.name, payload.isDirectory);
        }
      } catch (_) {}
    });
  }

  if (localPane) {
    localPane.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('application/x-cloudftp-remote') && canWriteToLocal()) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    localPane.addEventListener('drop', async (e) => {
      const raw = e.dataTransfer.getData('application/x-cloudftp-remote');
      if (!raw) return;
      e.preventDefault();
      e.stopPropagation();
      try {
        const payload = JSON.parse(raw);
        if (payload.multiple && Array.isArray(payload.names) && payload.names.length > 0) {
          const targets = payload.names
            .map(n => fileList.find(f => f.name === n))
            .filter(Boolean)
            .map(f => ({ name: f.name, isDirectory: f.isDirectory }));
          if (targets.length > 0) await downloadRemoteItemsToLocal(targets);
        } else {
          await downloadRemoteItemToLocal(payload.name, payload.isDirectory);
        }
      } catch (_) {}
    });
  }
}

// ==================== SYNCHRONIZED SCROLL & MARQUEE SELECTION ====================

function initSyncedScroll() {
  const localContainer = document.getElementById('localExplorerTableContainer');
  const remoteContainer = document.getElementById('explorerTableContainer');
  if (!localContainer || !remoteContainer) return;

  let isSyncing = false;

  localContainer.addEventListener('scroll', () => {
    if (!syncState.compareEnabled || isSyncing) return;
    isSyncing = true;
    remoteContainer.scrollTop = localContainer.scrollTop;
    requestAnimationFrame(() => { isSyncing = false; });
  }, { passive: true });

  remoteContainer.addEventListener('scroll', () => {
    if (!syncState.compareEnabled || isSyncing) return;
    isSyncing = true;
    localContainer.scrollTop = remoteContainer.scrollTop;
    requestAnimationFrame(() => { isSyncing = false; });
  }, { passive: true });
}

function initBothExplorerMarqueeSelections() {
  initSyncedScroll();
  initMarqueeSelection({
    containerId: 'localExplorerTableContainer',
    tbodyId: 'localFileListBody',
    nameSelector: '.local-name-link',
    variant: 'local',
    getSelectedSet: () => localState.selectedNames,
    applySelectionSet: setLocalSelectionFromSet
  });

  initMarqueeSelection({
    containerId: 'explorerTableContainer',
    tbodyId: 'fileListBody',
    nameSelector: '.remote-name-link',
    variant: 'remote',
    getSelectedSet: () => selectedNames,
    applySelectionSet: (s) => {
      if (typeof setRemoteSelectionFromSet === 'function') {
        setRemoteSelectionFromSet(s);
      }
    }
  });
}

function initMarqueeSelection({ containerId, tbodyId, nameSelector, variant, getSelectedSet, applySelectionSet }) {
  const container = document.getElementById(containerId);
  if (!container) return;

  let lastAnchorName = null;

  container.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('thead, input, button, select, textarea, a, .drag-source, .local-name-link, .remote-name-link')) {
      return;
    }

    const rect = container.getBoundingClientRect();
    // Ignore scrollbar clicks
    if (e.clientX > rect.left + container.clientWidth || e.clientY > rect.top + container.clientHeight) {
      return;
    }

    const isAdditive = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;
    const initialSelection = new Set(getSelectedSet());
    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const startContentX = e.clientX - rect.left + container.scrollLeft;
    const startContentY = e.clientY - rect.top + container.scrollTop;

    let didDrag = false;
    let maxMoveDist = 0;
    let marqueeEl = null;
    let autoScrollTimer = null;
    let lastEvent = e;
    let lastMeetsMinArea = false;

    const MIN_DRAG_START_PX = 6;
    const MIN_MARQUEE_AREA = 400;
    const MIN_MARQUEE_SIDE = 12;

    const getVisibleRowNames = () => {
      const tbody = document.getElementById(tbodyId);
      if (!tbody) return [];
      const names = [];
      tbody.querySelectorAll('tr').forEach(r => {
        const n = r.querySelector(nameSelector)?.getAttribute('title');
        if (n) names.push({ row: r, name: n });
      });
      return names;
    };

    const updateMarquee = (ev) => {
      const cRect = container.getBoundingClientRect();
      const theadHeight = container.querySelector('thead')?.getBoundingClientRect().height || 0;
      const minTop = cRect.top + theadHeight;
      const anchorX = cRect.left + startContentX - container.scrollLeft;
      const anchorY = cRect.top + startContentY - container.scrollTop;

      const rawLeft = Math.min(anchorX, ev.clientX);
      const rawRight = Math.max(anchorX, ev.clientX);
      const rawTop = Math.min(anchorY, ev.clientY);
      const rawBottom = Math.max(anchorY, ev.clientY);

      const visLeft = Math.max(cRect.left, Math.min(cRect.right, rawLeft));
      const visRight = Math.max(cRect.left, Math.min(cRect.right, rawRight));
      const visTop = Math.max(minTop, Math.min(cRect.bottom, rawTop));
      const visBottom = Math.max(minTop, Math.min(cRect.bottom, rawBottom));

      const boxWidth = Math.max(0, visRight - visLeft);
      const boxHeight = Math.max(0, visBottom - visTop);
      const boxArea = boxWidth * boxHeight;
      const meetsMinArea = boxArea >= MIN_MARQUEE_AREA && boxWidth >= MIN_MARQUEE_SIDE && boxHeight >= MIN_MARQUEE_SIDE;
      lastMeetsMinArea = meetsMinArea;

      if (!marqueeEl) {
        marqueeEl = document.createElement('div');
        marqueeEl.className = `selection-marquee ${variant === 'local' ? 'selection-marquee-local' : ''}`;
        document.body.appendChild(marqueeEl);
      }

      marqueeEl.style.left = `${visLeft}px`;
      marqueeEl.style.top = `${visTop}px`;
      marqueeEl.style.width = `${boxWidth}px`;
      marqueeEl.style.height = `${boxHeight}px`;
      marqueeEl.style.opacity = meetsMinArea ? '1' : '0.4';
      marqueeEl.style.borderStyle = meetsMinArea ? 'solid' : 'dashed';

      if (!meetsMinArea) {
        // Below minimum area threshold (e.g. user changed their mind or barely dragged): do not force-select any row
        applySelectionSet(initialSelection);
        return;
      }

      const nextSet = (isAdditive || isShift) ? new Set(initialSelection) : new Set();
      for (const { row, name } of getVisibleRowNames()) {
        const rRect = row.getBoundingClientRect();
        const intersects = !(
          rRect.right < rawLeft ||
          rRect.left > rawRight ||
          rRect.bottom < rawTop ||
          rRect.top > rawBottom
        );
        if (intersects) {
          nextSet.add(name);
        }
      }
      applySelectionSet(nextSet);
    };

    const stepAutoScroll = () => {
      if (!didDrag) return;
      const cRect = container.getBoundingClientRect();
      const theadH = container.querySelector('thead')?.getBoundingClientRect().height || 0;
      const edge = 26;
      let delta = 0;
      if (lastEvent.clientY < cRect.top + theadH + edge) {
        delta = -10;
      } else if (lastEvent.clientY > cRect.bottom - edge) {
        delta = 10;
      }
      if (delta !== 0) {
        container.scrollTop += delta;
        updateMarquee(lastEvent);
      }
    };

    const cleanupMarquee = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keydown', onKeyDown);
      if (autoScrollTimer) {
        clearInterval(autoScrollTimer);
        autoScrollTimer = null;
      }
      if (marqueeEl) {
        marqueeEl.remove();
        marqueeEl = null;
      }
    };

    const onKeyDown = (ev) => {
      if (ev.key === 'Escape') {
        cleanupMarquee();
        applySelectionSet(initialSelection);
      }
    };

    const onMouseMove = (ev) => {
      lastEvent = ev;
      const dist = Math.hypot(ev.clientX - startClientX, ev.clientY - startClientY);
      if (dist > maxMoveDist) maxMoveDist = dist;
      if (!didDrag) {
        if (dist < MIN_DRAG_START_PX) return;
        didDrag = true;
        autoScrollTimer = setInterval(stepAutoScroll, 30);
      }
      updateMarquee(ev);
    };

    const onMouseUp = (ev) => {
      cleanupMarquee();

      if (didDrag) {
        if (!lastMeetsMinArea) {
          applySelectionSet(initialSelection);
        }
        return;
      }

      // Cancelled micro-drag (moved >= 4px then returned/released): do not treat as row click
      if (maxMoveDist >= 4) {
        return;
      }

      const clickedRow = ev.target.closest('tbody tr');
      const clickedName = clickedRow?.querySelector(nameSelector)?.getAttribute('title');
      if (clickedName) {
        const rows = getVisibleRowNames();
        if (ev.shiftKey && lastAnchorName) {
          const idxA = rows.findIndex(r => r.name === lastAnchorName);
          const idxB = rows.findIndex(r => r.name === clickedName);
          if (idxA !== -1 && idxB !== -1) {
            const start = Math.min(idxA, idxB);
            const end = Math.max(idxA, idxB);
            const nextSet = isAdditive ? new Set(initialSelection) : new Set();
            for (let i = start; i <= end; i++) {
              nextSet.add(rows[i].name);
            }
            applySelectionSet(nextSet);
            return;
          }
        }
        if (isAdditive) {
          const nextSet = new Set(initialSelection);
          if (nextSet.has(clickedName)) nextSet.delete(clickedName);
          else nextSet.add(clickedName);
          applySelectionSet(nextSet);
        } else {
          applySelectionSet(new Set([clickedName]));
        }
        lastAnchorName = clickedName;
      } else if (!isAdditive && !ev.shiftKey) {
        applySelectionSet(new Set());
        lastAnchorName = null;
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keydown', onKeyDown);
  });
}

// ==================== BOOKMARK LOCAL FOLDER INTEGRATION ====================

window.bookmarkHandlesCache = new Map();
let pendingBookmarkLocalHandle = null;
let pendingBookmarkLocalName = '';
let pendingBookmarkLocalBasePath = '';

function resetBookmarkLocalFolderDraft() {
  if (localState.provider === 'fs_access' && localState.rootHandle) {
    pendingBookmarkLocalHandle = localState.rootHandle;
    pendingBookmarkLocalName = localState.rootName;
    pendingBookmarkLocalBasePath = normalizeLocalRelPath(localState.currentPath);
  } else {
    pendingBookmarkLocalHandle = null;
    pendingBookmarkLocalName = '';
    pendingBookmarkLocalBasePath = '';
  }
  refreshBookmarkLocalBadge();
}

function refreshBookmarkLocalBadge() {
  const label = document.getElementById('bookmarkLocalFolderLabel');
  const clearBtn = document.getElementById('clearBookmarkLocalBtn');
  if (!label) return;
  if (pendingBookmarkLocalHandle) {
    const disp = pendingBookmarkLocalBasePath
      ? `${pendingBookmarkLocalName}/${pendingBookmarkLocalBasePath}`
      : pendingBookmarkLocalName;
    label.innerHTML = `Bağlanacak yerel klasör: <strong class="text-emerald-300 font-mono">${escapeHtml(disp)}</strong>`;
    clearBtn?.classList.remove('hidden');
  } else {
    label.innerText = 'Yerel klasör bağlanmadı';
    clearBtn?.classList.add('hidden');
  }
}

async function pickBookmarkLocalFolder() {
  if (typeof window.showDirectoryPicker !== 'function') {
    showToast('Bu tarayıcıda klasör eşleme kaydı (File System Access API) desteklenmiyor.', 'error');
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    pendingBookmarkLocalHandle = handle;
    pendingBookmarkLocalName = handle.name;
    pendingBookmarkLocalBasePath = '';
    refreshBookmarkLocalBadge();
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast(`Klasör seçilemedi: ${err.message}`, 'error');
    }
  }
}

function clearBookmarkLocalFolder() {
  pendingBookmarkLocalHandle = null;
  pendingBookmarkLocalName = '';
  pendingBookmarkLocalBasePath = '';
  refreshBookmarkLocalBadge();
}

async function preloadBookmarkHandles(bookmarks) {
  if (!Array.isArray(bookmarks)) return;
  for (const b of bookmarks) {
    const connKey = `${b.user || 'anonymous'}@${b.host}:${b.port || 21}`;
    if (b.id) {
      const h = await HandlesDB.get(`bookmark:${b.id}`);
      if (h) window.bookmarkHandlesCache.set(`bookmark:${b.id}`, h);
    }
    const ch = await HandlesDB.get(connKey);
    if (ch) window.bookmarkHandlesCache.set(connKey, ch);
  }
}

async function attachLocalFolderToBookmark(index) {
  if (typeof window.showDirectoryPicker !== 'function') {
    showToast('Bu tarayıcıda kalıcı yerel klasör bağlama desteklenmiyor.', 'error');
    return;
  }
  let bookmarks = [];
  try {
    bookmarks = JSON.parse(localStorage.getItem('cloudftp_bookmarks') || '[]');
  } catch (_) {}
  const b = bookmarks[index];
  if (!b) return;

  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    if (!b.id) b.id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
    b.localFolderName = handle.name;
    b.localBasePath = '';
    bookmarks[index] = b;
    localStorage.setItem('cloudftp_bookmarks', JSON.stringify(bookmarks));

    const connKey = `${b.user || 'anonymous'}@${b.host}:${b.port || 21}`;
    await HandlesDB.save(`bookmark:${b.id}`, handle);
    await HandlesDB.save(connKey, handle);
    window.bookmarkHandlesCache.set(`bookmark:${b.id}`, handle);
    window.bookmarkHandlesCache.set(connKey, handle);

    const map = getSavedMappingsMap();
    map[connKey] = {
      key: connKey,
      host: b.host,
      port: parseInt(b.port, 10) || 21,
      user: b.user || 'anonymous',
      localFolderName: handle.name,
      localBasePath: '',
      remoteBasePath: b.remoteDir || '/',
      syncBrowsing: true,
      compareEnabled: true,
      updatedAt: Date.now()
    };
    saveMappingsMap(map);

    if (typeof loadBookmarks === 'function') loadBookmarks();
    renderRecentLocalMappings();
    showToast(`"${b.name}" için yerel klasör bağlandı: ${handle.name}`, 'success');
  } catch (err) {
    if (err.name !== 'AbortError') {
      showToast(`Klasör bağlanamadı: ${err.message}`, 'error');
    }
  }
}

async function activateBookmarkLocalMapping(bookmark) {
  const connKey = `${bookmark.user || 'anonymous'}@${bookmark.host}:${bookmark.port || 21}`;
  const bookmarkKey = bookmark.id ? `bookmark:${bookmark.id}` : null;
  const cachedHandle = (bookmarkKey && window.bookmarkHandlesCache.get(bookmarkKey)) || window.bookmarkHandlesCache.get(connKey) || null;
  const mappingsMap = getSavedMappingsMap();
  const savedMapping = mappingsMap[connKey] || null;

  const targetLocalBase = normalizeLocalRelPath(
    bookmark.localBasePath !== undefined ? bookmark.localBasePath : (savedMapping?.localBasePath || '')
  );
  const targetRemoteBase = normalizeRemotePath(
    bookmark.remoteDir || savedMapping?.remoteBasePath || '/'
  );

  syncState.pendingBookmarkMapping = {
    connKey,
    localBasePath: targetLocalBase,
    remoteBasePath: targetRemoteBase
  };

  // Call requestPermission synchronously within click gesture if we have cached handle
  let handle = cachedHandle;
  if (handle && handle.requestPermission) {
    try {
      let perm = await handle.requestPermission({ mode: 'readwrite' });
      let canWrite = perm === 'granted';
      if (!canWrite) {
        perm = await handle.requestPermission({ mode: 'read' });
      }
      if (perm === 'granted') {
        await activateFsAccessHandle(handle, canWrite, targetLocalBase, false);
        showToast(`Kayıtlı yerel klasör açıldı: ${handle.name}`, 'success');
        return true;
      }
    } catch (_) {
      // Fallback below if async IndexedDB lookup needed or permission denied
    }
  }

  // Fallback async IndexedDB lookup if cache wasn't ready
  if (!handle) {
    handle = (bookmarkKey && await HandlesDB.get(bookmarkKey)) || await HandlesDB.get(connKey);
    if (handle && handle.queryPermission) {
      try {
        const rw = await handle.queryPermission({ mode: 'readwrite' });
        if (rw === 'granted') {
          await activateFsAccessHandle(handle, true, targetLocalBase, false);
          return true;
        }
        const r = await handle.queryPermission({ mode: 'read' });
        if (r === 'granted') {
          await activateFsAccessHandle(handle, false, targetLocalBase, false);
          return true;
        }
      } catch (_) {}

      // Show 1-click reconnect banner if permission still needs gesture
      syncState.pendingReconnectMapping = {
        key: connKey,
        mapping: savedMapping || {
          key: connKey,
          host: bookmark.host,
          port: bookmark.port || 21,
          user: bookmark.user || 'anonymous',
          localFolderName: bookmark.localFolderName || handle.name,
          localBasePath: targetLocalBase,
          remoteBasePath: targetRemoteBase,
          syncBrowsing: true,
          compareEnabled: true
        },
        handle
      };
      const banner = document.getElementById('savedMappingBanner');
      const text = document.getElementById('savedMappingBannerText');
      if (banner && text) {
        const localDisp = targetLocalBase ? `${handle.name}/${targetLocalBase}` : handle.name;
        text.innerHTML = `Kayıtlı eşleme: <strong class="text-emerald-300">${escapeHtml(localDisp)}</strong> ↔ <strong class="text-sky-300">${escapeHtml(targetRemoteBase)}</strong>`;
        banner.classList.remove('hidden');
      }
    }
  }
  return false;
}

async function applyPendingBookmarkMappingOnConnect() {
  if (!syncState.pendingBookmarkMapping || !localState.provider || !currentSession) return false;
  const pending = syncState.pendingBookmarkMapping;
  syncState.pendingBookmarkMapping = null;
  if (pending.connKey && getConnectionMappingKey(currentSession) !== pending.connKey) {
    return false;
  }

  syncState.mapped = true;
  syncState.localBasePath = normalizeLocalRelPath(pending.localBasePath || localState.currentPath);
  syncState.remoteBasePath = normalizeRemotePath(currentPath);
  syncState.syncBrowsing = true;
  syncState.compareEnabled = true;

  await persistCurrentMapping();
  updateSyncToolbarState();
  renderLocalBreadcrumb(localState.currentPath);
  if (typeof renderBreadcrumb === 'function') renderBreadcrumb(currentPath);
  refreshComparisonAndRender();
  addClientLog('success', `Kayıtlı eşleme aktif edildi: "${getLocalDisplayPath(syncState.localBasePath)}" ↔ "${syncState.remoteBasePath}"`);
  return true;
}

function showLocalContextMenu(e, file) {
  const menu = document.getElementById('contextMenu');
  const itemsContainer = document.getElementById('contextMenuItems');
  if (!menu || !itemsContainer) return;

  const safeArg = escapeAttrArg(file.name);
  let html = '';

  if (file.isDirectory) {
    html += `
      <button onclick="loadLocalDirectory(joinLocalPath(localState.currentPath, '${safeArg}')); hideContextMenu()" class="w-full text-left px-3 py-1.5 rounded-lg hover:bg-slate-800 text-slate-200 flex items-center gap-2 transition">
        <i class="fa-solid fa-folder-open text-emerald-400 w-4"></i> Klasörü Aç
      </button>`;
  } else {
    html += `
      <button onclick="openLocalFilePreview('${safeArg}'); hideContextMenu()" class="w-full text-left px-3 py-1.5 rounded-lg hover:bg-slate-800 text-slate-200 flex items-center gap-2 transition">
        <i class="fa-solid fa-pen-to-square text-emerald-400 w-4"></i> Önizle / Düzenle
      </button>`;
  }

  if (currentSession) {
    html += `
      <button onclick="uploadLocalItemToRemote('${safeArg}', ${file.isDirectory}); hideContextMenu()" class="w-full text-left px-3 py-1.5 rounded-lg hover:bg-slate-800 text-sky-300 flex items-center gap-2 transition">
        <i class="fa-solid fa-upload text-sky-400 w-4"></i> FTP'ye Yükle
      </button>`;
  }

  if (localState.canWrite) {
    html += `
      <div class="my-1 border-t border-slate-800"></div>
      <button onclick="deleteLocalItem('${safeArg}', ${file.isDirectory}); hideContextMenu()" class="w-full text-left px-3 py-1.5 rounded-lg hover:bg-rose-950/60 text-rose-400 flex items-center gap-2 transition">
        <i class="fa-solid fa-trash-can w-4"></i> Yerelden Sil
      </button>`;
  }

  itemsContainer.innerHTML = html;
  positionAndShowContextMenu(e, menu);
}

function showLocalEmptyContextMenu(e) {
  const menu = document.getElementById('contextMenu');
  const itemsContainer = document.getElementById('contextMenuItems');
  if (!menu || !itemsContainer) return;

  itemsContainer.innerHTML = `
    ${localState.canWrite ? `
      <button onclick="openModal('localNewFolderModal'); hideContextMenu()" class="w-full text-left px-3 py-1.5 rounded-lg hover:bg-slate-800 text-slate-200 flex items-center gap-2 transition">
        <i class="fa-solid fa-folder-plus text-emerald-400 w-4"></i> Yeni Yerel Klasör
      </button>
      <div class="my-1 border-t border-slate-800"></div>
    ` : ''}
    <button onclick="refreshLocalFiles(); hideContextMenu()" class="w-full text-left px-3 py-1.5 rounded-lg hover:bg-slate-800 text-slate-200 flex items-center gap-2 transition">
      <i class="fa-solid fa-arrows-rotate text-emerald-400 w-4"></i> Yenile
    </button>
    <button onclick="localNavigateUp(); hideContextMenu()" class="w-full text-left px-3 py-1.5 rounded-lg hover:bg-slate-800 text-slate-200 flex items-center gap-2 transition">
      <i class="fa-solid fa-arrow-up text-slate-400 w-4"></i> Üst Dizine Çık
    </button>
    <button onclick="pickLocalFolder(); hideContextMenu()" class="w-full text-left px-3 py-1.5 rounded-lg hover:bg-slate-800 text-slate-200 flex items-center gap-2 transition">
      <i class="fa-solid fa-folder-open text-amber-400 w-4"></i> Başka Klasör Seç
    </button>
  `;

  positionAndShowContextMenu(e, menu);
}

function formatCompactDate(isoStr) {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    return d.toLocaleString('tr-TR', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch (_) {
    return '-';
  }
}
