const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // API to fetch repositories
    getRepos: (token) => ipcRenderer.invoke('getRepos', token),

    // API to perform delete
    deleteRepos: (data) => ipcRenderer.invoke('deleteRepos', data),

    // Token Management
    getToken: () => ipcRenderer.invoke('getToken'),
    saveToken: (token) => ipcRenderer.invoke('saveToken', token),

    // AI & Rename
    getRouterKey: () => ipcRenderer.invoke('getRouterKey'),
    saveRouterKey: (key) => ipcRenderer.invoke('saveRouterKey', key),
    fetchOpenRouterModels: (key) => ipcRenderer.invoke('fetchOpenRouterModels', key),
    analyzeReposAI: (data) => ipcRenderer.invoke('analyzeReposAI', data),
    executeRenames: (data) => ipcRenderer.invoke('executeRenames', data),

    // AI Description & README
    generateDescription: (data) => ipcRenderer.invoke('generateDescription', data),
    updateDescription: (data) => ipcRenderer.invoke('updateDescription', data),
    generateReadme: (data) => ipcRenderer.invoke('generateReadme', data),
    createReadmeInRepo: (data) => ipcRenderer.invoke('createReadmeInRepo', data),
    getRepoDetails: (data) => ipcRenderer.invoke('getRepoDetails', data),
    getCloneStats: (data) => ipcRenderer.invoke('getCloneStats', data),

    // Detailed Repo Info & Fork Sync
    getDetailedRepoInfo: (data) => ipcRenderer.invoke('getDetailedRepoInfo', data),
    syncFork: (data) => ipcRenderer.invoke('syncFork', data),
    checkForkStatus: (data) => ipcRenderer.invoke('checkForkStatus', data),

    // Repo Organization (Visibility, Topics, License)
    changeVisibility: (data) => ipcRenderer.invoke('changeVisibility', data),
    updateTopics: (data) => ipcRenderer.invoke('updateTopics', data),
    getRepoTopics: (data) => ipcRenderer.invoke('getRepoTopics', data),
    addLicense: (data) => ipcRenderer.invoke('addLicense', data),
    checkLicense: (data) => ipcRenderer.invoke('checkLicense', data),

    // Analysis & Cleanup
    analyzeAllRepos: (data) => ipcRenderer.invoke('analyzeAllRepos', data),

    // External Repo Analyzer
    analyzeExternalRepo: (data) => ipcRenderer.invoke('analyzeExternalRepo', data),

    // AI Commits
    analyzeCommitsAI: (token, routerKey, repoFullName) => ipcRenderer.invoke('analyzeCommitsAI', { token, routerKey, repoFullName }),
    applyCommitFix: (token, repoFullName, sha, newMessage) => ipcRenderer.invoke('applyCommitFix', { token, repoFullName, sha, newMessage }),
    applyBulkCommitFixes: (token, repoFullName, fixes) => ipcRenderer.invoke('applyBulkCommitFixes', { token, repoFullName, fixes }),

    // Window Controls
    minimize: () => ipcRenderer.send('app:minimize'),
    maximize: () => ipcRenderer.send('app:maximize'),
    close: () => ipcRenderer.send('app:close'),

    // External Links
    openExternal: (url) => ipcRenderer.send('open-external', url),

    // ── Multi-Repo Publisher (PRD) ────────────────────────────────────────────
    selectFolders: (opts) => ipcRenderer.invoke('selectFolders', opts),
    createAndPushRepos: (data) => ipcRenderer.invoke('createAndPushRepos', data),
    onPublishProgress: (cb) => ipcRenderer.on('publish-progress', (_, data) => cb(data)),
    removePublishProgress: () => ipcRenderer.removeAllListeners('publish-progress'),

    // Operation History
    getOperationHistory: () => ipcRenderer.invoke('getOperationHistory'),
    clearOperationHistory: () => ipcRenderer.invoke('clearOperationHistory'),

    // Dashboard Stats
    getDashboardStats: (token) => ipcRenderer.invoke('getDashboardStats', token),

    // Bulk Fork Sync
    syncForkBulk: (data) => ipcRenderer.invoke('syncForkBulk', data),

    // .gitignore & Project Type
    detectProjectType: (folderPath) => ipcRenderer.invoke('detectProjectType', folderPath),

    // Local Git Status & Quick Push
    checkLocalGitStatus: (data) => ipcRenderer.invoke('checkLocalGitStatus', data),
    quickPush: (data) => ipcRenderer.invoke('quickPush', data),

    // App Config (commit templates, defaults)
    getAppConfig: () => ipcRenderer.invoke('getAppConfig'),
    saveAppConfig: (update) => ipcRenderer.invoke('saveAppConfig', update),

    // System
    setAutoStart: (enabled) => ipcRenderer.invoke('setAutoStart', enabled),

    // GitHub Explore
    searchRepos: (data) => ipcRenderer.invoke('searchRepos', data),
    starRepo: (data) => ipcRenderer.invoke('starRepo', data),
    unstarRepo: (data) => ipcRenderer.invoke('unstarRepo', data),
    forkRepo: (data) => ipcRenderer.invoke('forkRepo', data),
    getExploreRepoDetail: (data) => ipcRenderer.invoke('getExploreRepoDetail', data),

    // Clone
    selectClonePath: () => ipcRenderer.invoke('selectClonePath'),
    cloneRepo: (data) => ipcRenderer.invoke('cloneRepo', data)
});
