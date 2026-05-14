const fs = require('fs');
const path = require('path');
const { TASK_DIR, FILES_DIR, TASKS_DIR, LOG_FILE, TASK_CACHE_TTL_MS } = require('./config');

function createCacheMaintenance({ log }) {
  function isPathInside(parent, candidate) {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
  }
  
  function directorySize(targetPath) {
    if (!fs.existsSync(targetPath)) return 0;
    const stat = fs.statSync(targetPath);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    return fs.readdirSync(targetPath).reduce((total, entry) => total + directorySize(path.join(targetPath, entry)), 0);
  }
  
  function removeTaskCachePath(targetPath) {
    const resolved = path.resolve(targetPath);
    if (resolved === path.resolve(TASK_DIR) || !isPathInside(TASK_DIR, resolved)) {
      throw new Error(`拒绝删除任务缓存目录外路径: ${targetPath}`);
    }
    const bytes = directorySize(resolved);
    fs.rmSync(resolved, { recursive: true, force: true });
    return bytes;
  }
  
  function touchIfExists(targetPath) {
    if (!fs.existsSync(targetPath)) return;
    const now = new Date();
    fs.utimesSync(targetPath, now, now);
  }
  
  function removeStaleChildren(baseDir, cutoffMs, protectedNames = new Set()) {
    if (!fs.existsSync(baseDir)) return { removed: 0, freedBytes: 0 };
    let removed = 0;
    let freedBytes = 0;
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (protectedNames.has(entry.name)) continue;
      const fullPath = path.join(baseDir, entry.name);
      const stat = fs.statSync(fullPath);
      if (stat.mtimeMs >= cutoffMs) continue;
      freedBytes += removeTaskCachePath(fullPath);
      removed += 1;
    }
    return { removed, freedBytes };
  }
  
  function cleanupOldTaskCache() {
    try {
      fs.mkdirSync(FILES_DIR, { recursive: true });
      fs.mkdirSync(TASKS_DIR, { recursive: true });
      const cutoffMs = Date.now() - TASK_CACHE_TTL_MS;
      const protectedRootNames = new Set(['files', 'tasks', path.basename(LOG_FILE)]);
      const files = removeStaleChildren(FILES_DIR, cutoffMs);
      const taskRuns = removeStaleChildren(TASKS_DIR, cutoffMs);
      const legacy = removeStaleChildren(TASK_DIR, cutoffMs, protectedRootNames);
      log('info', 'task_cache_cleanup_finished', {
        ttlHours: Math.round(TASK_CACHE_TTL_MS / 3600000),
        removed: files.removed + taskRuns.removed + legacy.removed,
        freedBytes: files.freedBytes + taskRuns.freedBytes + legacy.freedBytes,
        filesRemoved: files.removed,
        taskRunsRemoved: taskRuns.removed,
        legacyRemoved: legacy.removed,
      });
    } catch (error) {
      log('warn', 'task_cache_cleanup_failed', { error: error.message });
    }
  }

  return {
    isPathInside,
    directorySize,
    removeTaskCachePath,
    touchIfExists,
    removeStaleChildren,
    cleanupOldTaskCache,
  };
}

module.exports = { createCacheMaintenance };
