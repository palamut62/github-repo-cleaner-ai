const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const https = require('https');
const fs = require('fs');
const { execSync, execFileSync, spawn } = require('child_process');

let mainWindow;
let tray = null;
let currentUser = null; // To cache user info

// Network timeouts so a stuck connection never hangs the app forever
const GITHUB_TIMEOUT_MS = 30000;
const OPENROUTER_TIMEOUT_MS = 120000;

// Use userData for writable config, __dirname for dev
function getEnvPath() {
    if (app.isPackaged) {
        return path.join(app.getPath('userData'), '.env');
    }
    return path.join(__dirname, '.env');
}

// Prevent app crash on unhandled errors
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

function getIconPath() {
    // In production (asar), use resourcesPath; in dev, use __dirname
    const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
    const devPath = path.join(__dirname, 'assets', iconName);
    if (fs.existsSync(devPath)) return devPath;
    return path.join(process.resourcesPath, 'assets', iconName);
}

function createWindow() {
    const iconPath = getIconPath();

    mainWindow = new BrowserWindow({
        width: 1000,
        height: 750,
        frame: false, // Custom Title Bar
        titleBarStyle: 'hidden',
        icon: iconPath,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        }
    });

    // Block window.open and in-app navigation away from the bundled UI
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());

    mainWindow.loadFile('index.html');

    // Minimize to tray instead of closing
    mainWindow.on('close', (e) => {
        if (!app.isQuitting) {
            e.preventDefault();
            mainWindow.hide();
        }
    });
}

function createTray() {
    const iconPath = getIconPath();
    tray = new Tray(iconPath);

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Open GitHub Repo Organizer',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                    mainWindow.focus();
                }
            }
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                app.isQuitting = true;
                app.quit();
            }
        }
    ]);

    tray.setToolTip('GitHub Repo Organizer');
    tray.setContextMenu(contextMenu);

    tray.on('double-click', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
        }
    });
}

// Check if launched at startup (--hidden flag or login item)
const launchedAtStartup = process.argv.includes('--hidden') || app.getLoginItemSettings().wasOpenedAtLogin;

app.whenReady().then(() => {
    createWindow();
    createTray();

    // If launched at startup, keep window hidden (tray only)
    if (launchedAtStartup) {
        mainWindow.hide();
    }

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    // Don't quit - keep running in tray
});

// Helper for HTTP requests
function githubRequest(path, method, token, body = null, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.github.com',
            path: path,
            method: method,
            headers: {
                'User-Agent': 'GitHub-Repo-Organizer',
                'Authorization': `token ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                ...extraHeaders
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        resolve(data ? JSON.parse(data) : null);
                    } catch (e) {
                        resolve(null); // No content (204)
                    }
                } else {
                    reject(new Error(`GitHub API Error: ${res.statusCode} - ${data}`));
                }
            });
        });

        req.on('error', (e) => {
            reject(e);
        });

        // Never hang forever: abort the request after a fixed timeout.
        req.setTimeout(GITHUB_TIMEOUT_MS, () => {
            req.destroy(new Error(`GitHub isteği zaman aşımına uğradı (${GITHUB_TIMEOUT_MS / 1000}s)`));
        });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

// 1. Get Repos Handler
ipcMain.handle('getRepos', async (event, token) => {
    try {
        // First, verify/cache user info to know who we are acting as
        if (!currentUser) {
            currentUser = await githubRequest('/user', 'GET', token);
        }

        let allRepos = [];
        let page = 1;
        let hasMore = true;

        // Fetch all pages (100 per page)
        while (hasMore) {
            const repos = await githubRequest(`/user/repos?per_page=100&page=${page}&sort=updated`, 'GET', token);
            if (repos && repos.length > 0) {
                allRepos = allRepos.concat(repos);
                if (repos.length < 100) hasMore = false;
                page++;
            } else {
                hasMore = false;
            }
        }

        return { success: true, data: allRepos };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// 2. Delete Repos Handler
ipcMain.handle('deleteRepos', async (event, { token, repos }) => {
    const results = [];

    for (const repoFullName of repos) {
        try {
            // DELETE /repos/:owner/:repo
            // repoFullName is already "owner/repo"
            await githubRequest(`/repos/${repoFullName}`, 'DELETE', token);
            results.push({ name: repoFullName, status: 'deleted', ok: true });
        } catch (error) {
            results.push({ name: repoFullName, status: 'error', ok: false, error: error.message });
        }
    }
    return results;
});

// 4. Token Management handlers
// Secrets are stored OS-encrypted (DPAPI/Keychain/libsecret) via safeStorage.
// Legacy plaintext .env values are migrated on first read.
const { safeStorage } = require('electron');

function getSecretsPath() {
    if (app.isPackaged) {
        return path.join(app.getPath('userData'), 'secrets.json');
    }
    return path.join(__dirname, 'secrets.json');
}

function loadSecretsFile() {
    try {
        return JSON.parse(fs.readFileSync(getSecretsPath(), 'utf-8'));
    } catch (e) {
        return {};
    }
}

function writeSecret(name, value) {
    const secrets = loadSecretsFile();
    if (safeStorage.isEncryptionAvailable()) {
        secrets[name] = { enc: true, data: safeStorage.encryptString(String(value)).toString('base64') };
    } else {
        secrets[name] = { enc: false, data: String(value) };
    }
    fs.writeFileSync(getSecretsPath(), JSON.stringify(secrets, null, 2));
}

function readEnvSecret(envKey) {
    try {
        const envPath = getEnvPath();
        if (!fs.existsSync(envPath)) return '';
        const match = fs.readFileSync(envPath, 'utf-8').match(new RegExp(`${envKey}=(.+)`));
        return match ? match[1].trim() : '';
    } catch (e) {
        return '';
    }
}

function scrubEnvSecret(envKey) {
    try {
        const envPath = getEnvPath();
        if (!fs.existsSync(envPath)) return;
        const content = fs.readFileSync(envPath, 'utf-8')
            .split('\n').filter(line => !line.startsWith(`${envKey}=`)).join('\n').trim();
        fs.writeFileSync(envPath, content);
    } catch (e) { /* best effort */ }
}

function readSecret(name, legacyEnvKey) {
    const entry = loadSecretsFile()[name];
    if (entry) {
        try {
            if (entry.enc) return safeStorage.decryptString(Buffer.from(entry.data, 'base64'));
            return entry.data;
        } catch (e) {
            console.error(`Secret decrypt failed for ${name}:`, e);
        }
    }
    // Legacy migration: plaintext .env → encrypted secrets.json
    const legacy = readEnvSecret(legacyEnvKey);
    if (legacy) {
        try {
            writeSecret(name, legacy);
            scrubEnvSecret(legacyEnvKey);
        } catch (e) { /* keep using legacy value */ }
    }
    return legacy;
}

ipcMain.handle('getToken', async () => {
    try {
        return readSecret('githubToken', 'GITHUB_TOKEN');
    } catch (e) {
        console.error('Token read error:', e);
        return '';
    }
});

ipcMain.handle('saveToken', async (event, token) => {
    try {
        writeSecret('githubToken', token);
        scrubEnvSecret('GITHUB_TOKEN');
        // Identity cache belongs to the old token — drop it so the next
        // request re-resolves /user for the newly saved account.
        currentUser = null;
        return true;
    } catch (e) {
        console.error('Token save error:', e);
        return false;
    }
});

// 5. Router Key Management
ipcMain.handle('getRouterKey', async () => {
    try {
        return readSecret('routerKey', 'ROUTER_KEY');
    } catch (e) {
        return '';
    }
});

ipcMain.handle('saveRouterKey', async (event, key) => {
    try {
        writeSecret('routerKey', key);
        scrubEnvSecret('ROUTER_KEY');
        return true;
    } catch (e) {
        return false;
    }
});

// ─── Fetch OpenRouter Models ─────────────────────────────────────────────────
ipcMain.handle('fetchOpenRouterModels', async (event, routerKey) => {
    return new Promise((resolve) => {
        const options = {
            hostname: 'openrouter.ai',
            path: '/api/v1/models',
            method: 'GET',
            headers: routerKey ? { 'Authorization': `Bearer ${routerKey}` } : {}
        };
        const req = require('https').request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const models = (json.data || [])
                        .map(m => ({
                            id: m.id,
                            name: m.name || m.id,
                            context_length: m.context_length || 0,
                            pricing: m.pricing || {},
                            free: (m.pricing?.prompt === '0' && m.pricing?.completion === '0')
                        }))
                        .reverse();
                    resolve({ success: true, models });
                } catch (e) {
                    resolve({ success: false, error: e.message, models: [] });
                }
            });
        });
        req.on('error', (e) => resolve({ success: false, error: e.message, models: [] }));
        req.setTimeout(15000, () => { req.destroy(); resolve({ success: false, error: 'Timeout', models: [] }); });
        req.end();
    });
});

// 6. AI & Rename Logic Helpers
function getAIModel() {
    try {
        const config = loadConfig();
        return config.aiModel || 'moonshotai/kimi-k2.5';
    } catch (e) {
        return 'moonshotai/kimi-k2.5';
    }
}
async function getReadmeContent(token, owner, repo) {
    try {
        const data = await githubRequest(`/repos/${owner}/${repo}/readme`, 'GET', token);
        if (data && data.content) {
            return Buffer.from(data.content, 'base64').toString('utf-8');
        }
        return null;
    } catch (e) {
        return null; // No readme
    }
}

function openRouterRequest(apiKey, readmeContent) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            model: getAIModel(),
            messages: [
                {
                    "role": "system",
                    "content": "You are a helpful assistant that suggests repository names usually in kebab-case based on README content. Output ONLY the suggested name, nothing else."
                },
                {
                    "role": "user",
                    "content": `Analyze this README and suggest a concise, kebab-case (or snake_case if appropriate) repository name. Content:\n\n${readmeContent.substring(0, 3000)}`
                }
            ]
        });

        const req = https.request({
            hostname: 'openrouter.ai',
            path: '/api/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData) // Important for some APIs
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const json = JSON.parse(data);
                        resolve(json.choices[0].message.content.trim());
                    } catch (e) {
                        resolve(null);
                    }
                } else {
                    console.error('OpenRouter Error:', data);
                    resolve(null);
                }
            });
        });

        req.on('error', (e) => resolve(null));
        req.setTimeout(OPENROUTER_TIMEOUT_MS, () => req.destroy(new Error('OpenRouter timeout')));
        req.write(postData);
        req.end();
    });
}

ipcMain.handle('analyzeReposAI', async (event, { token, routerKey, repos }) => {
    const results = [];

    for (const fullName of repos) { // repos is array of "owner/repo" strings
        const [owner, repoName] = fullName.split('/');

        // 1. Get Readme
        const readme = await getReadmeContent(token, owner, repoName);

        let proposedName = '';
        if (readme) {
            // 2. Ask AI
            proposedName = await openRouterRequest(routerKey, readme);
        }

        // Fallback or Clean up
        if (!proposedName) proposedName = repoName;

        // Clean potential garbage (AI sometimes adds quotes or explanation)
        proposedName = proposedName.replace(/["`]/g, '').split('\n')[0].trim();

        results.push({
            original: fullName,
            currentName: repoName,
            proposed: proposedName
        });
    }
    return results;
});

ipcMain.handle('executeRenames', async (event, { token, renames }) => {
    // renames = [{ owner, repo, newName }, ...]
    const results = [];

    for (const item of renames) {
        try {
            await githubRequest(`/repos/${item.owner}/${item.repo}`, 'PATCH', token, {
                name: item.newName
            });
            results.push({ name: `${item.owner}/${item.repo}`, status: 'Success' });
        } catch (e) {
            results.push({ name: `${item.owner}/${item.repo}`, status: `Error: ${e.message}` });
        }
    }
    return results;
});


// Window Controls
ipcMain.on('app:minimize', () => {
    mainWindow.minimize();
});

ipcMain.on('app:maximize', () => {
    if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow.maximize();
    }
});

ipcMain.on('app:close', () => {
    mainWindow.close();
});

ipcMain.on('open-external', (event, url) => {
    // Only allow http/https — blocks file://, smb:// and custom protocol abuse
    try {
        const parsed = new URL(String(url));
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
            require('electron').shell.openExternal(parsed.href);
        }
    } catch (e) { /* invalid URL — ignore */ }
});

// 7. AI Description Generator
function openRouterDescriptionRequest(apiKey, readmeContent) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            model: getAIModel(),
            messages: [
                {
                    "role": "system",
                    "content": "You are a helpful assistant that creates short, professional GitHub repository descriptions. Output ONLY the description text (max 100 characters), nothing else. No quotes, no explanations."
                },
                {
                    "role": "user",
                    "content": `Create a short, professional GitHub description for this repository based on the README:\n\n${readmeContent.substring(0, 3000)}`
                }
            ]
        });

        const req = https.request({
            hostname: 'openrouter.ai',
            path: '/api/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const json = JSON.parse(data);
                        resolve(json.choices[0].message.content.trim());
                    } catch (e) {
                        resolve(null);
                    }
                } else {
                    resolve(null);
                }
            });
        });

        req.on('error', () => resolve(null));
        req.setTimeout(OPENROUTER_TIMEOUT_MS, () => req.destroy(new Error('OpenRouter timeout')));
        req.write(postData);
        req.end();
    });
}

ipcMain.handle('generateDescription', async (event, { token, routerKey, repos }) => {
    const results = [];

    for (const fullName of repos) {
        const [owner, repoName] = fullName.split('/');
        const readme = await getReadmeContent(token, owner, repoName);

        let description = '';
        if (readme) {
            description = await openRouterDescriptionRequest(routerKey, readme);
        }

        if (!description) description = 'No description available.';
        description = description.replace(/[\"`]/g, '').split('\n')[0].trim().substring(0, 100);

        results.push({
            fullName,
            repoName,
            description
        });
    }
    return results;
});

// 8. Update Repository Description
ipcMain.handle('updateDescription', async (event, { token, owner, repo, description }) => {
    try {
        await githubRequest(`/repos/${owner}/${repo}`, 'PATCH', token, { description });
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 9. AI README Generator
function openRouterReadmeRequest(apiKey, repoName, files) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            model: getAIModel(),
            messages: [
                {
                    "role": "system",
                    "content": "You are a helpful assistant that creates professional README.md files for GitHub repositories. Output ONLY the markdown content, no explanations."
                },
                {
                    "role": "user",
                    "content": `Create a professional README.md for a repository named "${repoName}" with these files:\n${files.join(', ')}\n\nInclude: Title, Description, Installation, Usage, Technologies, and License sections.`
                }
            ]
        });

        const req = https.request({
            hostname: 'openrouter.ai',
            path: '/api/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const json = JSON.parse(data);
                        resolve(json.choices[0].message.content.trim());
                    } catch (e) {
                        resolve(null);
                    }
                } else {
                    resolve(null);
                }
            });
        });

        req.on('error', () => resolve(null));
        req.setTimeout(OPENROUTER_TIMEOUT_MS, () => req.destroy(new Error('OpenRouter timeout')));
        req.write(postData);
        req.end();
    });
}

async function getRepoFiles(token, owner, repo) {
    try {
        const data = await githubRequest(`/repos/${owner}/${repo}/contents`, 'GET', token);
        if (data && Array.isArray(data)) {
            return data.map(f => f.name);
        }
        return [];
    } catch (e) {
        return [];
    }
}

ipcMain.handle('generateReadme', async (event, { token, routerKey, fullName }) => {
    const [owner, repoName] = fullName.split('/');
    const files = await getRepoFiles(token, owner, repoName);

    if (files.length === 0) {
        return { success: false, readme: null, error: 'No files found in repository.' };
    }

    const readme = await openRouterReadmeRequest(routerKey, repoName, files);

    if (!readme) {
        return { success: false, readme: null, error: 'AI could not generate README.' };
    }

    return { success: true, readme, files };
});

// 10. Get Repository Details (for clone URL and setup info)
ipcMain.handle('getRepoDetails', async (event, { token, fullName }) => {
    try {
        const [owner, repo] = fullName.split('/');
        const data = await githubRequest(`/repos/${owner}/${repo}`, 'GET', token);
        return {
            success: true,
            data: {
                name: data.name,
                fullName: data.full_name,
                description: data.description,
                cloneUrl: data.clone_url,
                sshUrl: data.ssh_url,
                htmlUrl: data.html_url,
                defaultBranch: data.default_branch,
                language: data.language,
                private: data.private
            }
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 10b. Get clone/traffic stats for repositories (GitHub Traffic API, last 14 days)
// Requires push access to each repo; repos without access are skipped silently.
ipcMain.handle('getCloneStats', async (event, { token, repos }) => {
    try {
        if (!Array.isArray(repos) || repos.length === 0) {
            return { success: true, total: 0, totalUniques: 0, perRepo: [], skipped: 0 };
        }

        const results = [];
        let skipped = 0;
        const CONCURRENCY = 5;

        // Fetch in small batches to stay within rate limits
        for (let i = 0; i < repos.length; i += CONCURRENCY) {
            const batch = repos.slice(i, i + CONCURRENCY);
            const batchResults = await Promise.all(batch.map(async (fullName) => {
                try {
                    const [owner, repo] = fullName.split('/');
                    const data = await githubRequest(`/repos/${owner}/${repo}/traffic/clones`, 'GET', token);
                    return {
                        fullName,
                        count: data && typeof data.count === 'number' ? data.count : 0,
                        uniques: data && typeof data.uniques === 'number' ? data.uniques : 0,
                        accessible: true
                    };
                } catch (e) {
                    // 403 = no push access (can't read traffic), 404 = gone. Skip.
                    return { fullName, count: 0, uniques: 0, accessible: false };
                }
            }));
            results.push(...batchResults);
        }

        const accessible = results.filter(r => r.accessible);
        skipped = results.length - accessible.length;
        const total = accessible.reduce((s, r) => s + r.count, 0);
        const totalUniques = accessible.reduce((s, r) => s + r.uniques, 0);

        return {
            success: true,
            total,
            totalUniques,
            skipped,
            perRepo: accessible.sort((a, b) => b.count - a.count)
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 11. Create/Update README file in repository
ipcMain.handle('createReadmeInRepo', async (event, { token, fullName, content }) => {
    const [owner, repo] = fullName.split('/');

    try {
        // Check if README exists
        let sha = null;
        try {
            const existing = await githubRequest(`/repos/${owner}/${repo}/contents/README.md`, 'GET', token);
            sha = existing.sha;
        } catch (e) {
            // README doesn't exist, that's fine
        }

        const body = {
            message: sha ? 'Update README.md via GitHub Repo Organizer' : 'Create README.md via GitHub Repo Organizer',
            content: Buffer.from(content).toString('base64')
        };

        if (sha) body.sha = sha;

        await githubRequest(`/repos/${owner}/${repo}/contents/README.md`, 'PUT', token, body);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 12. Get Detailed Repository Info (for double-click modal)
ipcMain.handle('getDetailedRepoInfo', async (event, { token, fullName }) => {
    try {
        const [owner, repo] = fullName.split('/');
        const data = await githubRequest(`/repos/${owner}/${repo}`, 'GET', token);

        // Get languages
        let languages = {};
        try {
            languages = await githubRequest(`/repos/${owner}/${repo}/languages`, 'GET', token);
        } catch (e) {
            // ignore
        }

        // Get recent commits
        let recentCommits = [];
        try {
            const commits = await githubRequest(`/repos/${owner}/${repo}/commits?per_page=5`, 'GET', token);
            recentCommits = commits.map(c => ({
                sha: c.sha.substring(0, 7),
                message: c.commit.message.split('\n')[0].substring(0, 50),
                date: c.commit.author.date,
                author: c.commit.author.name
            }));
        } catch (e) {
            // ignore
        }

        // Get parent info if fork
        let parentInfo = null;
        if (data.fork && data.parent) {
            parentInfo = {
                fullName: data.parent.full_name,
                htmlUrl: data.parent.html_url,
                defaultBranch: data.parent.default_branch,
                updatedAt: data.parent.updated_at
            };
        }

        // Check if fork is behind parent
        let syncStatus = null;
        if (data.fork && data.parent) {
            try {
                const comparison = await githubRequest(
                    `/repos/${owner}/${repo}/compare/${data.default_branch}...${data.parent.owner.login}:${data.parent.default_branch}`,
                    'GET',
                    token
                );
                syncStatus = {
                    behind: comparison.behind_by,
                    ahead: comparison.ahead_by,
                    status: comparison.status
                };
            } catch (e) {
                // Comparison might fail
            }
        }

        return {
            success: true,
            data: {
                name: data.name,
                fullName: data.full_name,
                description: data.description,
                cloneUrl: data.clone_url,
                sshUrl: data.ssh_url,
                htmlUrl: data.html_url,
                defaultBranch: data.default_branch,
                language: data.language,
                languages: languages,
                private: data.private,
                fork: data.fork,
                stargazersCount: data.stargazers_count,
                forksCount: data.forks_count,
                watchersCount: data.watchers_count,
                openIssuesCount: data.open_issues_count,
                createdAt: data.created_at,
                updatedAt: data.updated_at,
                pushedAt: data.pushed_at,
                size: data.size,
                topics: data.topics || [],
                parentInfo: parentInfo,
                syncStatus: syncStatus,
                recentCommits: recentCommits
            }
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 13. Sync Fork with Upstream (Parent)
ipcMain.handle('syncFork', async (event, { token, fullName }) => {
    try {
        const [owner, repo] = fullName.split('/');

        // Resolve the fork's real default branch instead of guessing main/master
        let branch = 'main';
        try {
            const info = await githubRequest(`/repos/${owner}/${repo}`, 'GET', token);
            if (info && info.default_branch) branch = info.default_branch;
        } catch (e) { /* fall back to main */ }

        // Use GitHub's merge-upstream API
        const result = await githubRequest(
            `/repos/${owner}/${repo}/merge-upstream`,
            'POST',
            token,
            { branch }
        );

        return { success: true, message: result.message || 'Fork synced successfully!' };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 13b. Check fork behind/ahead status
ipcMain.handle('checkForkStatus', async (event, { token, fullName }) => {
    try {
        const [owner, repo] = fullName.split('/');
        const repoInfo = await githubRequest(`/repos/${owner}/${repo}`, 'GET', token);

        if (!repoInfo.fork || !repoInfo.parent) {
            return { success: false, error: 'Not a fork or no parent info' };
        }

        const defaultBranch = repoInfo.default_branch || 'main';
        const parentOwner = repoInfo.parent.owner.login;
        const parentRepo = repoInfo.parent.name;
        const parentBranch = repoInfo.parent.default_branch || 'main';

        // Compare: upstream...fork
        const comparison = await githubRequest(
            `/repos/${parentOwner}/${parentRepo}/compare/${parentOwner}:${parentBranch}...${owner}:${defaultBranch}`,
            'GET',
            token
        );

        return {
            success: true,
            behind: comparison.behind_by || 0,
            ahead: comparison.ahead_by || 0,
            status: comparison.status, // "diverged", "ahead", "behind", "identical"
            parentFullName: repoInfo.parent.full_name
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 14. Change Repository Visibility (Public/Private)
ipcMain.handle('changeVisibility', async (event, { token, repos, visibility }) => {
    const results = [];

    for (const fullName of repos) {
        const [owner, repo] = fullName.split('/');
        try {
            await githubRequest(`/repos/${owner}/${repo}`, 'PATCH', token, {
                private: visibility === 'private'
            });
            results.push({ name: fullName, status: 'success' });
        } catch (e) {
            results.push({ name: fullName, status: 'error', error: e.message });
        }
    }

    return results;
});

// 15. Update Repository Topics
ipcMain.handle('updateTopics', async (event, { token, repos, topics, action }) => {
    const results = [];

    for (const fullName of repos) {
        const [owner, repo] = fullName.split('/');
        try {
            // Get current topics first
            const repoData = await githubRequest(`/repos/${owner}/${repo}`, 'GET', token);
            let currentTopics = repoData.topics || [];

            let newTopics;
            if (action === 'add') {
                // Add new topics without duplicates
                newTopics = [...new Set([...currentTopics, ...topics])];
            } else if (action === 'remove') {
                // Remove specified topics
                newTopics = currentTopics.filter(t => !topics.includes(t));
            } else if (action === 'replace') {
                // Replace all topics
                newTopics = topics;
            }

            // Update topics using the correct endpoint
            await githubRequest(`/repos/${owner}/${repo}/topics`, 'PUT', token, {
                names: newTopics
            });

            results.push({ name: fullName, status: 'success', topics: newTopics });
        } catch (e) {
            results.push({ name: fullName, status: 'error', error: e.message });
        }
    }

    return results;
});

// 16. Get Repository Topics
ipcMain.handle('getRepoTopics', async (event, { token, fullName }) => {
    try {
        const [owner, repo] = fullName.split('/');
        const data = await githubRequest(`/repos/${owner}/${repo}/topics`, 'GET', token);
        return { success: true, topics: data.names || [] };
    } catch (e) {
        return { success: false, error: e.message, topics: [] };
    }
});

// 17. Add License File to Repository
const LICENSE_TEMPLATES = {
    'MIT': `MIT License

Copyright (c) [year] [fullname]

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,

    'Apache-2.0': `                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.`,

    'GPL-3.0': `                    GNU GENERAL PUBLIC LICENSE
                       Version 3, 29 June 2007

 Copyright (C) 2007 Free Software Foundation, Inc. <https://fsf.org/>
 Everyone is permitted to copy and distribute verbatim copies
 of this license document, but changing it is not allowed.

                            Preamble

  The GNU General Public License is a free, copyleft license for
software and other kinds of works.

[Full GPL-3.0 text available at https://www.gnu.org/licenses/gpl-3.0.txt]`,

    'ISC': `ISC License

Copyright (c) [year] [fullname]

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`
};

ipcMain.handle('addLicense', async (event, { token, repos, licenseType, authorName }) => {
    const results = [];
    const year = new Date().getFullYear();

    let licenseContent = LICENSE_TEMPLATES[licenseType] || LICENSE_TEMPLATES['MIT'];
    licenseContent = licenseContent.replace('[year]', year).replace('[fullname]', authorName || 'Author');

    for (const fullName of repos) {
        const [owner, repo] = fullName.split('/');

        try {
            // Check if LICENSE already exists
            let sha = null;
            try {
                const existing = await githubRequest(`/repos/${owner}/${repo}/contents/LICENSE`, 'GET', token);
                sha = existing.sha;
            } catch (e) {
                // LICENSE doesn't exist, that's fine
            }

            const body = {
                message: sha ? `Update LICENSE to ${licenseType}` : `Add ${licenseType} LICENSE`,
                content: Buffer.from(licenseContent).toString('base64')
            };

            if (sha) body.sha = sha;

            await githubRequest(`/repos/${owner}/${repo}/contents/LICENSE`, 'PUT', token, body);
            results.push({ name: fullName, status: 'success' });
        } catch (e) {
            results.push({ name: fullName, status: 'error', error: e.message });
        }
    }

    return results;
});

// 18. Check if repos have LICENSE
ipcMain.handle('checkLicense', async (event, { token, repos }) => {
    const results = [];

    for (const fullName of repos) {
        const [owner, repo] = fullName.split('/');
        try {
            await githubRequest(`/repos/${owner}/${repo}/contents/LICENSE`, 'GET', token);
            results.push({ name: fullName, hasLicense: true });
        } catch (e) {
            results.push({ name: fullName, hasLicense: false });
        }
    }

    return results;
});

// 19. Analyze All Repos (Stale, Size, Unchanged Forks)
ipcMain.handle('analyzeAllRepos', async (event, { token }) => {
    try {
        // First, verify/cache user info
        if (!currentUser) {
            currentUser = await githubRequest('/user', 'GET', token);
        }

        let allRepos = [];
        let page = 1;
        let hasMore = true;

        // Fetch all pages
        while (hasMore) {
            const repos = await githubRequest(`/user/repos?per_page=100&page=${page}&sort=updated`, 'GET', token);
            if (repos && repos.length > 0) {
                allRepos = allRepos.concat(repos);
                if (repos.length < 100) hasMore = false; // last page — don't waste an extra API call
                page++;
            } else {
                hasMore = false;
            }
        }

        const now = new Date();
        const sixMonthsAgo = new Date(now.getTime() - (180 * 24 * 60 * 60 * 1000));

        const analysis = {
            totalRepos: allRepos.length,
            totalSize: 0,
            staleRepos: [],
            largeRepos: [],
            unchangedForks: [],
            noStarsRepos: [],
            sizeByLanguage: {}
        };

        for (const repo of allRepos) {
            const updatedAt = new Date(repo.updated_at);
            const pushedAt = new Date(repo.pushed_at);

            // Total size
            analysis.totalSize += repo.size || 0;

            // Size by language
            if (repo.language) {
                if (!analysis.sizeByLanguage[repo.language]) {
                    analysis.sizeByLanguage[repo.language] = 0;
                }
                analysis.sizeByLanguage[repo.language] += repo.size || 0;
            }

            // Stale repos (not updated in 6 months)
            if (pushedAt < sixMonthsAgo) {
                analysis.staleRepos.push({
                    name: repo.name,
                    fullName: repo.full_name,
                    lastPush: repo.pushed_at,
                    lastUpdate: repo.updated_at,
                    stars: repo.stargazers_count,
                    size: repo.size
                });
            }

            // No stars repos
            if (repo.stargazers_count === 0 && !repo.fork) {
                analysis.noStarsRepos.push({
                    name: repo.name,
                    fullName: repo.full_name,
                    lastPush: repo.pushed_at,
                    size: repo.size
                });
            }

            // Large repos (over 50MB)
            if (repo.size > 50000) {
                analysis.largeRepos.push({
                    name: repo.name,
                    fullName: repo.full_name,
                    size: repo.size,
                    sizeFormatted: formatSize(repo.size)
                });
            }

            // Unchanged forks
            if (repo.fork) {
                analysis.unchangedForks.push({
                    name: repo.name,
                    fullName: repo.full_name,
                    lastPush: repo.pushed_at,
                    size: repo.size,
                    stars: repo.stargazers_count
                });
            }
        }

        // Sort large repos by size
        analysis.largeRepos.sort((a, b) => b.size - a.size);

        // Sort stale repos by last push date
        analysis.staleRepos.sort((a, b) => new Date(a.lastPush) - new Date(b.lastPush));

        return { success: true, analysis };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

function formatSize(sizeKB) {
    if (sizeKB < 1024) return `${sizeKB} KB`;
    if (sizeKB < 1024 * 1024) return `${(sizeKB / 1024).toFixed(1)} MB`;
    return `${(sizeKB / (1024 * 1024)).toFixed(2)} GB`;
}

// 19. Analyze All Repos (Stale, Size, Unchanged Forks)

// Parse GitHub URL to get owner and repo
function parseGitHubUrl(url) {
    const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)/);
    if (match) {
        return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
    }
    return null;
}

// Get repository tree (file structure)
async function getRepoTree(token, owner, repo) {
    try {
        // Get default branch first
        const repoData = await githubRequest(`/repos/${owner}/${repo}`, 'GET', token);
        const defaultBranch = repoData.default_branch;

        // Get tree recursively
        const tree = await githubRequest(`/repos/${owner}/${repo}/git/trees/${defaultBranch}?recursive=1`, 'GET', token);
        return tree.tree || [];
    } catch (e) {
        return [];
    }
}

// Get file content from repo
async function getFileContent(token, owner, repo, path) {
    try {
        const data = await githubRequest(`/repos/${owner}/${repo}/contents/${path}`, 'GET', token);
        if (data && data.content) {
            return Buffer.from(data.content, 'base64').toString('utf-8');
        }
        return null;
    } catch (e) {
        return null;
    }
}

// AI Analysis Request
function openRouterAnalysisRequest(apiKey, analysisData) {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify({
            model: getAIModel(),
            messages: [
                {
                    "role": "system",
                    "content": `You are an expert software architect and code analyst. Analyze the given repository data and create a comprehensive project analysis document in Markdown format.

The document should include:
1. **Overview** - What the project does, its purpose
2. **Tech Stack** - Technologies, frameworks, languages used
3. **Project Structure** - Key directories and their purposes
4. **Dependencies** - Main dependencies and what they're used for
5. **Architecture** - How the project is structured, design patterns
6. **Key Features** - Main features and how they're implemented
7. **How to Build Similar** - Step-by-step guide to create a similar project
8. **Notes** - Important observations, best practices used

Write in a clear, educational tone. Be thorough but concise. Output ONLY the markdown content.`
                },
                {
                    "role": "user",
                    "content": `Analyze this repository:\n\n${JSON.stringify(analysisData, null, 2)}`
                }
            ]
        });

        const req = https.request({
            hostname: 'openrouter.ai',
            path: '/api/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const json = JSON.parse(data);
                        resolve(json.choices[0].message.content.trim());
                    } catch (e) {
                        resolve(null);
                    }
                } else {
                    console.error('OpenRouter Error:', data);
                    resolve(null);
                }
            });
        });

        req.on('error', (e) => resolve(null));
        req.setTimeout(OPENROUTER_TIMEOUT_MS, () => req.destroy(new Error('OpenRouter timeout')));
        req.write(postData);
        req.end();
    });
}

// Main Repo Analyzer Handler
ipcMain.handle('analyzeExternalRepo', async (event, { token, routerKey, repoUrl }) => {
    try {
        // Parse URL
        const parsed = parseGitHubUrl(repoUrl);
        if (!parsed) {
            return { success: false, error: 'Invalid GitHub URL' };
        }

        const { owner, repo } = parsed;

        // Get repo info
        const repoData = await githubRequest(`/repos/${owner}/${repo}`, 'GET', token);

        // Get file tree
        const tree = await getRepoTree(token, owner, repo);

        // Build file structure string
        const fileStructure = tree
            .filter(f => f.type === 'blob')
            .map(f => f.path)
            .slice(0, 100) // Limit to 100 files
            .join('\n');

        // Get important files
        const importantFiles = ['package.json', 'requirements.txt', 'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'composer.json', 'Gemfile', 'setup.py', 'pyproject.toml'];
        let dependencies = null;

        for (const file of importantFiles) {
            const content = await getFileContent(token, owner, repo, file);
            if (content) {
                dependencies = { file, content: content.substring(0, 3000) };
                break;
            }
        }

        // Get README
        const readme = await getReadmeContent(token, owner, repo);

        // Get main source files (sample)
        const sourceExtensions = ['.js', '.ts', '.py', '.go', '.rs', '.java', '.rb', '.php'];
        const sourceFiles = tree
            .filter(f => f.type === 'blob' && sourceExtensions.some(ext => f.path.endsWith(ext)))
            .slice(0, 5);

        let sourceSamples = [];
        for (const file of sourceFiles) {
            const content = await getFileContent(token, owner, repo, file.path);
            if (content) {
                sourceSamples.push({
                    path: file.path,
                    content: content.substring(0, 2000) // Limit content
                });
            }
        }

        // Prepare analysis data
        const analysisData = {
            name: repoData.name,
            fullName: repoData.full_name,
            description: repoData.description,
            language: repoData.language,
            languages: await githubRequest(`/repos/${owner}/${repo}/languages`, 'GET', token).catch(() => ({})),
            stars: repoData.stargazers_count,
            forks: repoData.forks_count,
            topics: repoData.topics || [],
            fileStructure: fileStructure,
            dependencies: dependencies,
            readme: readme ? readme.substring(0, 4000) : null,
            sourceSamples: sourceSamples
        };

        // Call AI
        const analysis = await openRouterAnalysisRequest(routerKey, analysisData);

        if (!analysis) {
            return { success: false, error: 'AI analysis failed. Please try again.' };
        }

        return {
            success: true,
            data: {
                repoName: repoData.name,
                repoFullName: repoData.full_name,
                repoUrl: repoData.html_url,
                analysis: analysis
            }
        };

    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 25. AI Commit Fixer Logic
function openRouterCommitRequest(apiKey, commits) {
    return new Promise((resolve, reject) => {
        const commitText = commits.map(c => `SHA: ${c.sha.substring(0, 7)}\nMsg: ${c.message}`).join('\n---\n');

        const postData = JSON.stringify({
            model: getAIModel(),
            messages: [
                {
                    "role": "system",
                    "content": "You are an expert developer. Rewrite the following commit messages to follow the Conventional Commits standard (e.g., 'feat: add new feature', 'fix: resolve issue'). Keep them concise and professional. Return a JSON array of objects with 'sha' and 'suggestion' keys. Do NOT output markdown code blocks, just raw JSON."
                },
                {
                    "role": "user",
                    "content": `Rewrite these commit messages:\n\n${commitText}`
                }
            ]
        });

        const req = https.request({
            hostname: 'openrouter.ai',
            path: '/api/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        const json = JSON.parse(data);
                        let content = json.choices[0].message.content.trim();
                        // Clean up markdown code blocks if AI adds them
                        content = content.replace(/```json/g, '').replace(/```/g, '').trim();
                        const suggestions = JSON.parse(content);
                        resolve(suggestions);
                    } catch (e) {
                        console.error('AI Parse Error:', e);
                        resolve([]);
                    }
                } else {
                    resolve([]);
                }
            });
        });

        req.on('error', () => resolve([]));
        req.setTimeout(OPENROUTER_TIMEOUT_MS, () => req.destroy(new Error('OpenRouter timeout')));
        req.write(postData);
        req.end();
    });
}

ipcMain.handle('analyzeCommitsAI', async (event, { token, routerKey, repoFullName }) => {
    try {
        const [owner, repo] = repoFullName.split('/');
        // 1. Get recent commits (last 10)
        let recentCommits = [];
        try {
            const commits = await githubRequest(`/repos/${owner}/${repo}/commits?per_page=10`, 'GET', token);
            recentCommits = commits.map(c => ({
                sha: c.sha,
                message: c.commit.message.split('\n')[0] // Only first line
            }));
        } catch (e) {
            return [];
        }

        if (recentCommits.length === 0) return [];

        // 2. Ask AI to improve them
        const suggestions = await openRouterCommitRequest(routerKey, recentCommits);

        // 3. Merge results
        const results = recentCommits.map(c => {
            const suggestion = suggestions.find(s => c.sha === s.sha || c.sha.startsWith(s.sha) || s.sha.startsWith(c.sha.substring(0, 7)));
            return {
                sha: c.sha,
                original: c.message,
                suggestion: suggestion ? suggestion.suggestion : 'No suggestion available'
            };
        });

        return results;

    } catch (e) {
        return [];
    }
});

// 26. APPLY COMMIT FIX (REWRITE HISTORY)
ipcMain.handle('applyCommitFix', async (event, { token, repoFullName, sha, newMessage }) => {
    try {
        const [owner, repo] = repoFullName.split('/');

        // 1. Get the current Branch Head to know where to force push later
        const defaultBranchData = await githubRequest(`/repos/${owner}/${repo}`, 'GET', token);
        const defaultBranch = defaultBranchData.default_branch;
        const refData = await githubRequest(`/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`, 'GET', token);
        // const branchHeadSha = refData.object.sha; // Unused, we use commits array instead

        // 2. We need to find the commit chain from TARGET (sha) to HEAD
        // Getting all commits is expensive, so we get last 50 and hope target is in there.
        // If not, we fail safely.
        const commits = await githubRequest(`/repos/${owner}/${repo}/commits?per_page=50&sha=${defaultBranch}`, 'GET', token);

        // Commits are returned HEAD -> OLDER.
        // We need to find our target SHA index.
        const targetIndex = commits.findIndex(c => c.sha.startsWith(sha) || c.sha === sha);

        if (targetIndex === -1) {
            return { success: false, error: 'Commit not found in recent history (last 50). Cannot rewrite older history safely.' };
        }

        // 3. Rebuild the chain
        // We need to iterate from TARGET (oldest) -> HEAD (newest)
        // commits[targetIndex] is our Target.
        // commits[0] is HEAD.

        let previousCommitSha = null;

        // Handle the Target Commit first
        const targetCommit = commits[targetIndex];
        // const targetParentSha = targetCommit.parents.length > 0 ? targetCommit.parents[0].sha : null; 

        // Create the new Target Commit
        // POST /repos/:owner/:repo/git/commits
        const newTargetCommitData = {
            message: newMessage,
            tree: targetCommit.commit.tree.sha,
            parents: targetCommit.parents.map(p => p.sha)
        };

        const newTargetResponse = await githubRequest(`/repos/${owner}/${repo}/git/commits`, 'POST', token, newTargetCommitData);
        previousCommitSha = newTargetResponse.sha;

        // Now replay subsequent commits on top of this new one
        // Loop from targetIndex - 1 (next newer) down to 0 (HEAD)
        for (let i = targetIndex - 1; i >= 0; i--) {
            const current = commits[i];
            const newCommitData = {
                message: current.commit.message,
                tree: current.commit.tree.sha,
                parents: [previousCommitSha] // Linearize history: point to the new previous commit
            };

            const response = await githubRequest(`/repos/${owner}/${repo}/git/commits`, 'POST', token, newCommitData);
            previousCommitSha = response.sha;
        }

        // 4. Force Update the Ref
        // PATCH /repos/:owner/:repo/git/refs/heads/:branch
        const updateRefData = {
            sha: previousCommitSha,
            force: true
        };

        await githubRequest(`/repos/${owner}/${repo}/git/refs/heads/${defaultBranch}`, 'PATCH', token, updateRefData);

        return { success: true };

    } catch (e) {
        console.error('Apply Fix Error:', e);
        return { success: false, error: e.message };
    }
});

// 27. BULK APPLY COMMIT FIXES (OPTIMIZED HISTORY REWRITE)
ipcMain.handle('applyBulkCommitFixes', async (event, { token, repoFullName, fixes }) => {
    try {
        // fixes is array of { sha, newMessage }
        if (!fixes || fixes.length === 0) return { success: true };

        const [owner, repo] = repoFullName.split('/');

        // 1. Get info to start
        const defaultBranchData = await githubRequest(`/repos/${owner}/${repo}`, 'GET', token);
        const defaultBranch = defaultBranchData.default_branch;

        // 2. Get recent history (50)
        const commits = await githubRequest(`/repos/${owner}/${repo}/commits?per_page=50&sha=${defaultBranch}`, 'GET', token);

        // 3. Find the OLDEST commit in our fixes list to know where to start rebuilding
        // We want to touch history as little as possible.
        // Commits are HEAD(0) -> OLDER(N)

        let deepestIndex = -1;

        // Map fixes to a lookup object for speed: { sha: newMessage }
        const fixMap = {};
        for (const fix of fixes) {
            fixMap[fix.sha] = fix.newMessage;
            const index = commits.findIndex(c => c.sha.startsWith(fix.sha) || c.sha === fix.sha);
            if (index > deepestIndex) {
                deepestIndex = index;
            }
        }

        if (deepestIndex === -1) {
            return { success: false, error: 'None of the target commits were found in recent history (last 50).' };
        }

        // 4. Start rebuilding from data[deepestIndex] up to data[0]
        let previousCommitSha = null;

        // Initialize parent for the FIRST rebuilt commit (the oldest one we touch)
        // If oldest touch is at index K, its parent is at index K+1 (if exists)
        // If K is the last one fetched, we need its parent from 'parents' array.
        const oldestTouch = commits[deepestIndex];
        const initialParentSha = oldestTouch.parents.length > 0 ? oldestTouch.parents[0].sha : null;

        // We will assign previousCommitSha iteratively.
        // For the very first iteration, we pretend we just 'made' the parent.
        previousCommitSha = initialParentSha;

        // Iterate backwards from Oldest -> Newest (deepestIndex -> 0)
        for (let i = deepestIndex; i >= 0; i--) {
            const currentOriginal = commits[i];
            const currentSha = currentOriginal.sha;

            // Check if we have a new message for this specific commit
            // Use short SHA matching if needed, though exact is better
            let messageToUse = currentOriginal.commit.message;

            // Check full SHA or short SHA match
            if (fixMap[currentSha]) {
                messageToUse = fixMap[currentSha];
            } else {
                // Try finding by prefix
                const shortSha = currentSha.substring(0, 7);
                const foundKey = Object.keys(fixMap).find(k => k.startsWith(shortSha) || maxShaMatch(k, currentSha));
                if (foundKey) messageToUse = fixMap[foundKey];
            }

            const newCommitData = {
                message: messageToUse,
                tree: currentOriginal.commit.tree.sha,
                parents: previousCommitSha ? [previousCommitSha] : []
                // Note: If previousCommitSha is null (it's a root commit), pass empty array or null? 
                // GitHub API expects array.
            };

            // Create this new commit
            const response = await githubRequest(`/repos/${owner}/${repo}/git/commits`, 'POST', token, newCommitData);
            previousCommitSha = response.sha;
        }

        // 5. Force Update Ref
        const updateRefData = {
            sha: previousCommitSha,
            force: true
        };

        await githubRequest(`/repos/${owner}/${repo}/git/refs/heads/${defaultBranch}`, 'PATCH', token, updateRefData);

        return { success: true };

    } catch (e) {
        console.error('Bulk Fix Error:', e);
        return { success: false, error: e.message };
    }
});

function maxShaMatch(a, b) {
    return a.includes(b) || b.includes(a);
}

// ─── Operation History ────────────────────────────────────────────────────────
const historyFilePath = app.isPackaged ? path.join(app.getPath('userData'), 'operation-history.json') : path.join(__dirname, 'operation-history.json');

function loadHistory() {
    try {
        if (fs.existsSync(historyFilePath)) {
            return JSON.parse(fs.readFileSync(historyFilePath, 'utf-8'));
        }
    } catch (e) {}
    return [];
}

function saveHistory(history) {
    try {
        fs.writeFileSync(historyFilePath, JSON.stringify(history, null, 2));
    } catch (e) {
        console.error('History save error:', e);
    }
}

function addToHistory(entry) {
    const history = loadHistory();
    history.unshift({ ...entry, id: Date.now() });
    if (history.length > 500) history.length = 500;
    saveHistory(history);
}

// 28. Select Folders (single or multiple)
ipcMain.handle('selectFolders', async (event, { multiple }) => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: multiple
            ? ['openDirectory', 'multiSelections']
            : ['openDirectory'],
        title: multiple ? 'Select Multiple Project Folders' : 'Select Project Folder'
    });

    if (result.canceled) return [];

    return result.filePaths.map(folderPath => {
        const folderName = path.basename(folderPath);
        const hasGit = fs.existsSync(path.join(folderPath, '.git'));
        const suggestedName = folderName
            .toLowerCase()
            .replace(/[^a-z0-9-_.]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '') || 'my-project';

        return { folderPath, folderName, hasGit, suggestedName };
    });
});

// 29. Create GitHub repos and push local folders
ipcMain.handle('createAndPushRepos', async (event, { token, repos }) => {
    const results = [];

    for (const repo of repos) {
        const result = {
            folderPath: repo.folderPath,
            repoName: repo.repoName,
            steps: [],
            status: 'processing',
            error: null,
            repoUrl: null
        };

        try {
            event.sender.send('publish-progress', {
                repoName: repo.repoName,
                message: 'Creating GitHub repository…',
                status: 'processing'
            });

            // 1. Create GitHub repo
            let githubRepo;
            try {
                githubRepo = await githubRequest('/user/repos', 'POST', token, {
                    name: repo.repoName,
                    description: repo.description || '',
                    private: repo.visibility === 'private',
                    auto_init: false
                });
                result.steps.push({ step: 'GitHub repository created', status: 'success' });
            } catch (e) {
                if (e.message.includes('422') || e.message.toLowerCase().includes('already exists')) {
                    throw new Error(`Repository "${repo.repoName}" already exists on GitHub.`);
                }
                throw e;
            }

            // 2. Ensure we have user info for git config
            if (!currentUser) {
                currentUser = await githubRequest('/user', 'GET', token);
            }

            // 3. Git init if needed
            event.sender.send('publish-progress', {
                repoName: repo.repoName,
                message: 'Preparing local repository…',
                status: 'processing'
            });

            const gitDir = path.join(repo.folderPath, '.git');
            if (fs.existsSync(gitDir)) {
                // Check if large/ignored files are baked into git history
                let trackedLarge = '';
                try {
                    trackedLarge = execSync(
                        'git log --all --diff-filter=A --name-only --format="" -- "node_modules/*" "*.exe"',
                        { cwd: repo.folderPath, stdio: ['pipe','pipe','pipe'], timeout: 10000 }
                    ).toString().trim();
                } catch (e) {
                    // Probe failed (corrupt git? weird state?) — NEVER destroy user
                    // history because of a failed check; proceed with existing .git.
                    console.warn(`[createAndPushRepos] Dirty-history probe failed, keeping existing .git:`, e.message);
                    result.steps.push({ step: 'History check skipped (probe failed)', status: 'info' });
                }
                if (trackedLarge.length > 0) {
                    // Large files in history — nuke .git and start fresh
                    fs.rmSync(gitDir, { recursive: true, force: true });
                    console.log(`[createAndPushRepos] Removed dirty .git history (had large files in commits)`);
                    result.steps.push({ step: 'Cleaned dirty git history (large files detected)', status: 'success' });
                }
            }
            if (!fs.existsSync(gitDir)) {
                execSync('git init', { cwd: repo.folderPath, stdio: 'pipe' });
                try {
                    execSync('git checkout -b main', { cwd: repo.folderPath, stdio: 'pipe' });
                } catch (e) { /* branch may already exist */ }
                result.steps.push({ step: 'Git initialised (clean)', status: 'success' });
            } else {
                result.steps.push({ step: 'Git already initialised', status: 'info' });
            }

            // 4. Set local git user config
            const userEmail = currentUser.email || `${currentUser.login}@users.noreply.github.com`;
            const userName = currentUser.name || currentUser.login;
            execFileSync('git', ['config', 'user.email', userEmail], { cwd: repo.folderPath, stdio: 'pipe' });
            execFileSync('git', ['config', 'user.name', userName], { cwd: repo.folderPath, stdio: 'pipe' });

            // 4b. Auto-generate .gitignore (unless user opted out) to prevent large files like node_modules
            if (repo.autoGitignore !== false) {
                const detectedType = repo.detectedType || detectProjectType(repo.folderPath);
                const gitignorePath = path.join(repo.folderPath, '.gitignore');
                const content = getGitignore(detectedType);
                if (!fs.existsSync(gitignorePath)) {
                    fs.writeFileSync(gitignorePath, content, 'utf-8');
                    event.sender.send('publish-progress', {
                        repoName: repo.repoName,
                        message: 'Generating .gitignore…',
                        status: 'processing'
                    });
                    result.steps.push({ step: `.gitignore created (${detectedType})`, status: 'success' });
                } else {
                    // Ensure node_modules is in existing .gitignore
                    const existing = fs.readFileSync(gitignorePath, 'utf-8');
                    if (!existing.includes('node_modules')) {
                        fs.appendFileSync(gitignorePath, '\n# Auto-added\nnode_modules/\n');
                        result.steps.push({ step: 'node_modules/ added to existing .gitignore', status: 'success' });
                    } else {
                        result.steps.push({ step: '.gitignore already exists', status: 'info' });
                    }
                }
            }

            // 4c. Remove ignored dirs from git index (even if freshly staged)
            {
                const ignoredDirs = ['node_modules', '.next', '__pycache__', '.venv', 'venv', '.output', '.nuxt'];
                for (const dir of ignoredDirs) {
                    const dirPath = path.join(repo.folderPath, dir);
                    if (fs.existsSync(dirPath)) {
                        try {
                            execFileSync('git', ['rm', '-r', '--cached', dir], { cwd: repo.folderPath, stdio: 'pipe' });
                            console.log(`[createAndPushRepos] Removed ${dir} from git index`);
                            result.steps.push({ step: `Removed ${dir}/ from git index`, status: 'success' });
                        } catch (e) {
                            // Not in index — good
                        }
                    }
                }
            }

            // 4d. Scan for files > 100MB and auto-add to .gitignore
            {
                const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
                const gitignorePath = path.join(repo.folderPath, '.gitignore');
                const largeFiles = [];

                function scanForLargeFiles(dir, relative) {
                    try {
                        const entries = fs.readdirSync(dir, { withFileTypes: true });
                        for (const entry of entries) {
                            const fullPath = path.join(dir, entry.name);
                            const relPath = relative ? `${relative}/${entry.name}` : entry.name;
                            if (entry.name === '.git' || entry.name === 'node_modules') continue;
                            if (entry.isDirectory()) {
                                scanForLargeFiles(fullPath, relPath);
                            } else if (entry.isFile()) {
                                try {
                                    const stat = fs.statSync(fullPath);
                                    if (stat.size > MAX_FILE_SIZE) {
                                        largeFiles.push(relPath);
                                    }
                                } catch (e) {}
                            }
                        }
                    } catch (e) {}
                }
                scanForLargeFiles(repo.folderPath, '');

                if (largeFiles.length > 0) {
                    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
                    const toAdd = largeFiles.filter(f => !existing.includes(f));
                    if (toAdd.length > 0) {
                        fs.appendFileSync(gitignorePath, '\n# Auto-excluded (>100MB)\n' + toAdd.join('\n') + '\n');
                        console.log(`[createAndPushRepos] Auto-excluded large files: ${toAdd.join(', ')}`);
                        result.steps.push({ step: `Excluded ${toAdd.length} large file(s) (>100MB)`, status: 'success' });
                    }
                    // Also remove from index if tracked
                    for (const f of largeFiles) {
                        try {
                            execFileSync('git', ['rm', '--cached', f], { cwd: repo.folderPath, stdio: 'pipe' });
                        } catch (e) {}
                    }
                }
            }

            // 5. Stage all files
            event.sender.send('publish-progress', {
                repoName: repo.repoName,
                message: 'Staging files…',
                status: 'processing'
            });
            execSync('git add .', { cwd: repo.folderPath, stdio: 'pipe' });
            // Check how many files were staged
            const stagedFiles = execSync('git diff --cached --name-only', { cwd: repo.folderPath }).toString().trim();
            const stagedCount = stagedFiles ? stagedFiles.split('\n').length : 0;
            console.log(`[createAndPushRepos] Staged ${stagedCount} file(s) in ${repo.folderPath}`);
            if (stagedCount > 0) {
                console.log(`[createAndPushRepos] Files: ${stagedFiles.split('\n').slice(0, 10).join(', ')}${stagedCount > 10 ? '...' : ''}`);
            } else {
                // List what's in the folder to understand why nothing staged
                const dirContents = fs.readdirSync(repo.folderPath).filter(f => f !== '.git');
                console.log(`[createAndPushRepos] WARNING: 0 files staged! Folder contents: ${dirContents.join(', ') || '(empty)'}`);
                if (fs.existsSync(path.join(repo.folderPath, '.gitignore'))) {
                    const gi = fs.readFileSync(path.join(repo.folderPath, '.gitignore'), 'utf8');
                    console.log(`[createAndPushRepos] .gitignore contents:\n${gi}`);
                }
            }
            result.steps.push({ step: `Files staged (${stagedCount} files)`, status: stagedCount > 0 ? 'success' : 'warning' });
            event.sender.send('publish-progress', {
                repoName: repo.repoName,
                message: stagedCount > 0 ? `${stagedCount} file(s) staged` : '⚠️ No files staged! Check .gitignore',
                status: stagedCount > 0 ? 'processing' : 'error'
            });

            // 6. Commit (if needed)
            event.sender.send('publish-progress', {
                repoName: repo.repoName,
                message: 'Creating initial commit…',
                status: 'processing'
            });

            // Build commit message — use execFileSync with array args to avoid shell injection
            const rawMsg = (repo.commitMessage || 'Initial commit').replace(/{{project_name}}/g, repo.repoName);

            let hasCommits = false;
            try {
                execSync('git log --oneline -1', { cwd: repo.folderPath, stdio: 'pipe' });
                hasCommits = true;
            } catch (e) {}

            if (!hasCommits) {
                const statusOut = execSync('git status --porcelain', { cwd: repo.folderPath }).toString().trim();
                if (statusOut.length > 0) {
                    execFileSync('git', ['commit', '-m', rawMsg], { cwd: repo.folderPath, stdio: 'pipe' });
                    result.steps.push({ step: `Commit created: "${rawMsg}"`, status: 'success' });
                } else {
                    execFileSync('git', ['commit', '--allow-empty', '-m', rawMsg], { cwd: repo.folderPath, stdio: 'pipe' });
                    result.steps.push({ step: 'Empty initial commit created', status: 'info' });
                }
            } else {
                // Even with existing commits, commit any new staged changes
                const statusOut2 = execSync('git status --porcelain', { cwd: repo.folderPath }).toString().trim();
                if (statusOut2.length > 0) {
                    execFileSync('git', ['commit', '-m', rawMsg], { cwd: repo.folderPath, stdio: 'pipe' });
                    result.steps.push({ step: `New changes committed: "${rawMsg}"`, status: 'success' });
                } else {
                    result.steps.push({ step: 'Using existing commits (no new changes)', status: 'info' });
                }
            }

            // 7. Add remote
            event.sender.send('publish-progress', {
                repoName: repo.repoName,
                message: 'Adding remote origin…',
                status: 'processing'
            });
            try {
                execSync('git remote remove origin', { cwd: repo.folderPath, stdio: 'pipe' });
            } catch (e) {}
            const cloneUrl = githubRepo.clone_url;
            execFileSync('git', ['remote', 'add', 'origin', cloneUrl], { cwd: repo.folderPath, stdio: 'pipe' });
            result.steps.push({ step: 'Remote origin added', status: 'success' });

            // 8. Push
            event.sender.send('publish-progress', {
                repoName: repo.repoName,
                message: 'Pushing to GitHub…',
                status: 'processing'
            });

            let branchName = 'main';
            try {
                branchName = execSync('git branch --show-current', { cwd: repo.folderPath }).toString().trim() || 'main';
            } catch (e) {}

            // Push via a one-shot authenticated URL argument instead of writing
            // the token into .git/config with `remote set-url`. The token only
            // lives in the child process argv for the duration of the push.
            const pushUrl = cloneUrl.replace('https://', `https://${token}@`);
            try {
                const pushOutput = execFileSync(
                    'git',
                    ['push', pushUrl, `refs/heads/${branchName}:refs/heads/${branchName}`],
                    {
                        cwd: repo.folderPath,
                        timeout: 120000,
                        encoding: 'utf8',
                        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }
                    }
                );
                console.log(`[createAndPushRepos] Push output: ${pushOutput}`);
            } catch (pushErr) {
                const errMsg = pushErr.stderr || pushErr.stdout || pushErr.message;
                console.error(`[createAndPushRepos] Push FAILED:`, errMsg);
                throw new Error(`Push failed: ${errMsg}`);
            }

            result.steps.push({ step: 'Pushed to GitHub', status: 'success' });

            // 9. Auto-generate AI README if routerKey is available
            if (repo.autoReadme !== false) {
                try {
                    const routerKey = repo.routerKey || '';
                    if (routerKey) {
                        event.sender.send('publish-progress', {
                            repoName: repo.repoName,
                            message: 'Generating AI README…',
                            status: 'processing'
                        });

                        const fullName = githubRepo.full_name;
                        const [owner, repoN] = fullName.split('/');

                        // Check if README already exists
                        let hasReadme = false;
                        try {
                            await githubRequest(`/repos/${owner}/${repoN}/contents/README.md`, 'GET', token);
                            hasReadme = true;
                        } catch (e) {}

                        if (!hasReadme) {
                            const files = await getRepoFiles(token, owner, repoN);
                            if (files.length > 0) {
                                const readme = await openRouterReadmeRequest(routerKey, repo.repoName, files);
                                if (readme) {
                                    await githubRequest(`/repos/${owner}/${repoN}/contents/README.md`, 'PUT', token, {
                                        message: 'Create README.md via AI',
                                        content: Buffer.from(readme).toString('base64')
                                    });
                                    result.steps.push({ step: 'AI README created', status: 'success' });
                                } else {
                                    result.steps.push({ step: 'AI README: generation failed, skipped', status: 'info' });
                                }
                            }
                        } else {
                            result.steps.push({ step: 'README already exists, skipped', status: 'info' });
                        }
                    }
                } catch (readmeErr) {
                    result.steps.push({ step: `AI README failed: ${readmeErr.message}`, status: 'info' });
                }
            }

            result.status = 'success';
            result.repoUrl = githubRepo.html_url;

        } catch (e) {
            result.status = 'error';
            result.error = e.message;
            result.steps.push({ step: `Error: ${e.message}`, status: 'error' });
        }

        results.push(result);

        addToHistory({
            type: 'publish',
            repoName: repo.repoName,
            folderPath: repo.folderPath,
            status: result.status,
            error: result.error || null,
            repoUrl: result.repoUrl || null,
            timestamp: new Date().toISOString()
        });

        event.sender.send('publish-progress', {
            repoName: repo.repoName,
            message: result.status === 'success' ? 'Done!' : `Failed: ${result.error}`,
            status: result.status
        });
    }

    return results;
});

// 30. Get operation history
ipcMain.handle('getOperationHistory', async () => {
    return loadHistory();
});

// 31. Clear operation history
ipcMain.handle('clearOperationHistory', async () => {
    saveHistory([]);
    return true;
});

// 32. Dashboard stats
ipcMain.handle('getDashboardStats', async (event, token) => {
    try {
        if (!currentUser) {
            currentUser = await githubRequest('/user', 'GET', token);
        }

        let allRepos = [];
        let page = 1;
        let hasMore = true;
        while (hasMore) {
            const repos = await githubRequest(
                `/user/repos?per_page=100&page=${page}&sort=updated`, 'GET', token
            );
            if (repos && repos.length > 0) {
                allRepos = allRepos.concat(repos);
                if (repos.length < 100) hasMore = false;
                page++;
            } else {
                hasMore = false;
            }
        }

        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

        // Language stats
        const langMap = {};
        allRepos.forEach(r => {
            if (r.language) langMap[r.language] = (langMap[r.language] || 0) + 1;
        });
        const topLanguages = Object.entries(langMap)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([name, count]) => ({ name, count }));

        const totalStars = allRepos.reduce((s, r) => s + (r.stargazers_count || 0), 0);
        const totalSize = allRepos.reduce((s, r) => s + (r.size || 0), 0);

        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);
        const recentlyUpdated = allRepos
            .filter(r => new Date(r.updated_at) >= weekAgo)
            .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
            .slice(0, 5)
            .map(r => ({ name: r.name, updated: r.updated_at, language: r.language, visibility: r.private ? 'private' : 'public' }));

        const archived = allRepos.filter(r => r.archived).length;

        return {
            success: true,
            stats: {
                totalRepos: allRepos.length,
                sources: allRepos.filter(r => !r.fork).length,
                forks: allRepos.filter(r => r.fork).length,
                privateRepos: allRepos.filter(r => r.private).length,
                publicRepos: allRepos.filter(r => !r.private).length,
                stale: allRepos.filter(r => new Date(r.updated_at) < sixMonthsAgo).length,
                username: currentUser.login,
                avatar: currentUser.avatar_url,
                topLanguages,
                totalStars,
                totalSizeMB: Math.round(totalSize / 1024),
                recentlyUpdated,
                archived
            },
            recentHistory: loadHistory().slice(0, 5)
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// 33. Bulk fork sync
ipcMain.handle('syncForkBulk', async (event, { token, repos }) => {
    const results = [];

    for (const repoFullName of repos) {
        const [owner, repo] = repoFullName.split('/');

        // First, get the repo info to determine default branch
        let defaultBranch = 'main';
        try {
            const repoInfo = await githubRequest(`/repos/${owner}/${repo}`, 'GET', token);
            defaultBranch = repoInfo.default_branch || 'main';
        } catch (e) {}

        try {
            const data = await githubRequest(
                `/repos/${owner}/${repo}/merge-upstream`,
                'POST',
                token,
                { branch: defaultBranch }
            );
            results.push({
                repo: repoFullName,
                status: 'synced',
                message: data.message || 'Synced successfully'
            });
        } catch (e) {
            let status = 'error';
            let message = e.message;
            if (e.message.includes('409')) {
                status = 'conflict';
                message = 'Merge conflict with upstream — manual resolution required';
            } else if (e.message.includes('422')) {
                status = 'not-eligible';
                message = 'Not eligible for automatic sync';
            } else if (e.message.includes('403')) {
                status = 'permission-error';
                message = 'Permission denied — check token scopes';
            }
            results.push({ repo: repoFullName, status, message });
        }

        addToHistory({
            type: 'fork-sync',
            repoName: repoFullName,
            status: results[results.length - 1].status,
            message: results[results.length - 1].message,
            timestamp: new Date().toISOString()
        });
    }

    return results;
});

// ─── Local Git Status Check ───────────────────────────────────────────────────
ipcMain.handle('checkLocalGitStatus', async (event, { folderPath }) => {
    try {
        if (!fs.existsSync(path.join(folderPath, '.git'))) {
            return { success: false, error: 'Not a git repository' };
        }

        // Check for uncommitted changes
        const statusOut = execSync('git status --porcelain', { cwd: folderPath, timeout: 10000 }).toString().trim();
        const uncommitted = statusOut.length > 0 ? statusOut.split('\n').length : 0;

        // Check for unpushed commits
        let unpushed = 0;
        try {
            const logOut = execSync('git log --oneline @{u}..HEAD', { cwd: folderPath, timeout: 10000 }).toString().trim();
            unpushed = logOut.length > 0 ? logOut.split('\n').length : 0;
        } catch (e) {
            // No upstream set
            try {
                const logAll = execSync('git log --oneline', { cwd: folderPath, timeout: 10000 }).toString().trim();
                if (logAll.length > 0) unpushed = -1; // -1 means no remote tracking
            } catch (e2) {}
        }

        // Get current branch
        let branch = 'main';
        try {
            branch = execSync('git branch --show-current', { cwd: folderPath, timeout: 5000 }).toString().trim() || 'main';
        } catch (e) {}

        return {
            success: true,
            uncommitted,
            unpushed,
            branch,
            needsPush: uncommitted > 0 || unpushed > 0
        };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('quickPush', async (event, { folderPath, token, commitMessage }) => {
    try {
        const cwd = folderPath;

        // Ensure .gitignore exists to prevent pushing large files
        const qpGitignorePath = path.join(cwd, '.gitignore');
        if (!fs.existsSync(qpGitignorePath)) {
            const qpType = detectProjectType(cwd);
            const qpContent = getGitignore(qpType);
            fs.writeFileSync(qpGitignorePath, qpContent, 'utf-8');
        } else {
            const qpExisting = fs.readFileSync(qpGitignorePath, 'utf-8');
            if (!qpExisting.includes('node_modules') && fs.existsSync(path.join(cwd, 'node_modules'))) {
                fs.appendFileSync(qpGitignorePath, '\n# Auto-added\nnode_modules/\n');
            }
        }

        // Remove ignored dirs from git index
        const qpIgnoredDirs = ['node_modules', '.next', '__pycache__', '.venv', 'venv'];
        for (const dir of qpIgnoredDirs) {
            if (fs.existsSync(path.join(cwd, dir))) {
                try { execFileSync('git', ['rm', '-r', '--cached', dir], { cwd, stdio: 'pipe' }); } catch (e) {}
            }
        }

        // Stage & commit if there are changes
        const statusOut = execSync('git status --porcelain', { cwd, timeout: 10000 }).toString().trim();
        if (statusOut.length > 0) {
            execSync('git add .', { cwd, stdio: 'pipe' });
            execFileSync('git', ['commit', '-m', commitMessage || 'Update changes'], { cwd, stdio: 'pipe' });
        }

        // Get remote URL and push
        let remoteUrl = '';
        try {
            remoteUrl = execSync('git remote get-url origin', { cwd, timeout: 5000 }).toString().trim();
        } catch (e) {
            return { success: false, error: 'No remote origin set' };
        }

        // Sanitize any credentials an older version may have baked into .git/config
        const cleanUrl = remoteUrl.replace(/^https:\/\/[^@/]+@/, 'https://');
        if (cleanUrl !== remoteUrl) {
            try {
                execFileSync('git', ['remote', 'set-url', 'origin', cleanUrl], { cwd, stdio: 'pipe' });
                console.log('[quickPush] Stripped leaked credentials from origin URL');
            } catch (e) {}
            remoteUrl = cleanUrl;
        }

        const branch = execSync('git branch --show-current', { cwd, timeout: 5000 }).toString().trim() || 'main';

        // Auth push via one-shot URL argument — the token never touches .git/config
        const pushUrl = remoteUrl.replace('https://', `https://${token}@`);
        execFileSync(
            'git',
            ['push', pushUrl, `refs/heads/${branch}:refs/heads/${branch}`],
            {
                cwd,
                timeout: 120000,
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }
            }
        );

        return { success: true, message: 'Pushed successfully!' };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// ─── App Config (commit templates, defaults) ──────────────────────────────────
const configFilePath = app.isPackaged ? path.join(app.getPath('userData'), 'app-config.json') : path.join(__dirname, 'app-config.json');

function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(configFilePath, 'utf-8'));
    } catch (e) {}
    return {};
}

function saveConfig(update) {
    try {
        const current = loadConfig();
        fs.writeFileSync(configFilePath, JSON.stringify({ ...current, ...update }, null, 2));
        return true;
    } catch (e) {
        return false;
    }
}

ipcMain.handle('getAppConfig', async () => loadConfig());
ipcMain.handle('saveAppConfig', async (event, update) => saveConfig(update));

// ─── Clone Repo ──────────────────────────────────────────────────────────────
ipcMain.handle('selectClonePath', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Select Clone Directory'
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

ipcMain.handle('cloneRepo', async (event, { cloneUrl, clonePath, repoName }) => {
    try {
        if (!clonePath) return { success: false, error: 'Clone path not set. Please set it in Settings.' };
        if (!fs.existsSync(clonePath)) {
            fs.mkdirSync(clonePath, { recursive: true });
        }
        const dest = path.join(clonePath, repoName);
        if (fs.existsSync(dest)) {
            return { success: false, error: `Directory already exists: ${repoName}` };
        }
        return new Promise((resolve) => {
            const proc = spawn('git', ['clone', cloneUrl, dest], { stdio: ['ignore', 'pipe', 'pipe'] });
            let stderr = '';
            proc.stderr.on('data', (d) => { stderr += d.toString(); });
            proc.on('close', (code) => {
                if (code === 0) resolve({ success: true, path: dest });
                else resolve({ success: false, error: stderr || `git clone exited with code ${code}` });
            });
            proc.on('error', (err) => {
                resolve({ success: false, error: err.message });
            });
        });
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('setAutoStart', async (event, enabled) => {
    try {
        app.setLoginItemSettings({
            openAtLogin: enabled,
            args: ['--hidden']
        });
        return true;
    } catch (e) {
        console.error('Failed to set auto start:', e);
        return false;
    }
});

ipcMain.handle('getAppVersion', async () => {
    try {
        return app.getVersion();
    } catch (e) {
        return null;
    }
});

// ─── Project Type Detection ────────────────────────────────────────────────────
function detectProjectType(folderPath) {
    let files = [];
    try { files = fs.readdirSync(folderPath).map(f => f.toLowerCase()); } catch (e) { return 'generic'; }

    if (files.includes('package.json')) {
        try {
            const pkg = JSON.parse(fs.readFileSync(path.join(folderPath, 'package.json'), 'utf-8'));
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };
            if (deps['react'] || deps['react-dom'] || deps['next']) return 'react';
            if (deps['vue'] || deps['nuxt'])    return 'vue';
            if (deps['@angular/core'])          return 'angular';
            if (deps['svelte'])                 return 'svelte';
            if (deps['electron'])               return 'electron';
        } catch (e) {}
        return 'node';
    }
    if (files.some(f => ['requirements.txt','setup.py','pipfile','pyproject.toml','setup.cfg'].includes(f))) return 'python';
    if (files.includes('pom.xml'))                                 return 'java';
    if (files.includes('build.gradle') || files.includes('build.gradle.kts')) return 'java';
    if (files.includes('go.mod'))                                  return 'go';
    if (files.includes('cargo.toml'))                              return 'rust';
    if (files.includes('gemfile'))                                 return 'ruby';
    if (files.includes('composer.json'))                           return 'php';
    if (files.includes('cmakelists.txt') ||
        files.some(f => f.endsWith('.c') || f.endsWith('.cpp') || f.endsWith('.h'))) return 'cpp';
    if (files.some(f => f.endsWith('.xcodeproj') || f.endsWith('.xcworkspace'))) return 'swift';
    if (files.includes('projectsettings') ||
        files.some(f => f.endsWith('.unity'))) return 'unity';
    return 'generic';
}

ipcMain.handle('detectProjectType', async (event, folderPath) => {
    try {
        return { success: true, type: detectProjectType(folderPath) };
    } catch (e) {
        return { success: false, type: 'generic', error: e.message };
    }
});

// ── GitHub Explore ──────────────────────────────────────────────────────────
ipcMain.handle('searchRepos', async (event, { token, query, language, sort, order, page }) => {
    try {
        let q = query || 'stars:>100';
        if (language) q += ` language:${language}`;
        const s = sort || 'stars';
        const o = order || 'desc';
        const p = page || 1;
        const result = await githubRequest(
            `/search/repositories?q=${encodeURIComponent(q)}&sort=${s}&order=${o}&per_page=30&page=${p}`,
            'GET', token
        );
        return result;
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('starRepo', async (event, { token, fullName }) => {
    try {
        await githubRequest(`/user/starred/${fullName}`, 'PUT', token);
        return { success: true };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('unstarRepo', async (event, { token, fullName }) => {
    try {
        await githubRequest(`/user/starred/${fullName}`, 'DELETE', token);
        return { success: true };
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('forkRepo', async (event, { token, fullName }) => {
    try {
        const result = await githubRequest(`/repos/${fullName}/forks`, 'POST', token);
        return result;
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('getExploreRepoDetail', async (event, { token, fullName }) => {
    try {
        const [repo, languages, commits, readme, starred] = await Promise.allSettled([
            githubRequest(`/repos/${fullName}`, 'GET', token),
            githubRequest(`/repos/${fullName}/languages`, 'GET', token),
            githubRequest(`/repos/${fullName}/commits?per_page=5`, 'GET', token),
            githubRequest(`/repos/${fullName}/readme`, 'GET', token),
            githubRequest(`/user/starred/${fullName}`, 'GET', token)
        ]);

        return {
            repo: repo.status === 'fulfilled' ? repo.value : null,
            languages: languages.status === 'fulfilled' ? languages.value : {},
            commits: commits.status === 'fulfilled' ? commits.value : [],
            readme: readme.status === 'fulfilled' ? readme.value : null,
            starred: starred.status === 'fulfilled'
        };
    } catch (e) {
        return { error: e.message };
    }
});

// ─── Built-in .gitignore Templates ────────────────────────────────────────────
const GITIGNORE_COMMON_SUFFIX = `
# ─── IDE & Editors ───
.vscode/
.idea/
*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?
*.swp
*.swo
*~

# ─── AI Tools & Agents ───
.claude/
.claude_memory/
.cursorrules
.cursorignore
.cursor/
.aider*
.codeium/
.continue/
.codex/
.tabnine/
copilot-*.md
.github/copilot/

# ─── OS Files ───
.DS_Store
.DS_Store?
._*
Thumbs.db
ehthumbs.db
desktop.ini
$RECYCLE.BIN/
*.lnk

# ─── Logs ───
*.log
logs/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.pnpm-debug.log*

# ─── Environment & Secrets ───
.env
.env.*
!.env.example
*.pem
*.key
`;

function getGitignore(type) {
    const base = GITIGNORE_TEMPLATES[type] || GITIGNORE_TEMPLATES.generic;
    return base.trimEnd() + '\n' + GITIGNORE_COMMON_SUFFIX;
}

const GITIGNORE_TEMPLATES = {
    node: `# Dependencies
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
.pnpm-debug.log*

# Build output
dist/
build/
out/
.output/

# Environment variables
.env
.env.local
.env.*.local

# Editor
.vscode/
.idea/
*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?

# OS
.DS_Store
Thumbs.db
`,
    react: `# Dependencies
node_modules/
npm-debug.log*
yarn-debug.log*

# Build
build/
dist/
.next/
out/

# Environment
.env
.env.local
.env.development.local
.env.test.local
.env.production.local

# Testing
coverage/

# Editor
.vscode/
.idea/

# OS
.DS_Store
Thumbs.db
`,
    vue: `# Dependencies
node_modules/
npm-debug.log*
yarn-debug.log*

# Build
dist/
.output/
.nuxt/

# Environment
.env
.env.local
.env.*.local

# Editor
.vscode/
.idea/

# OS
.DS_Store
Thumbs.db
`,
    angular: `# Dependencies
node_modules/
npm-debug.log*
yarn-debug.log*

# Build
dist/
tmp/
out-tsc/

# Environment
.env
.env.local

# Editor
.vscode/
.idea/

# OS
.DS_Store
Thumbs.db
`,
    electron: `# Dependencies
node_modules/
npm-debug.log*
yarn-debug.log*

# Build
dist/
build/
out/
release/

# Environment
.env
.env.local

# Editor
.vscode/
.idea/

# OS
.DS_Store
Thumbs.db
`,
    python: `# Byte-compiled / optimized / DLL files
__pycache__/
*.py[cod]
*$py.class

# Virtual environments
venv/
env/
.venv/
.env/

# Distribution / packaging
dist/
build/
*.egg-info/
*.egg

# Environment
.env
.env.local

# Testing
.pytest_cache/
.coverage
htmlcov/

# Jupyter
.ipynb_checkpoints/

# Editor
.vscode/
.idea/

# OS
.DS_Store
Thumbs.db
`,
    java: `# Compiled class files
*.class

# Log files
*.log

# BlueJ files
*.ctxt

# Mobile Tools for Java (J2ME)
.mtj.tmp/

# Package Files
*.jar
*.war
*.nar
*.ear
*.zip
*.tar.gz
*.rar

# Build output
target/
build/
out/

# Maven
.mvn/timing.properties
.mvn/wrapper/maven-wrapper.jar

# Gradle
.gradle/
gradle-wrapper.jar

# IDE
.idea/
*.iml
.vscode/
*.eclipse

# OS
.DS_Store
Thumbs.db
`,
    go: `# Binaries
*.exe
*.exe~
*.dll
*.so
*.dylib

# Test binary
*.test

# Output
*.out
dist/
bin/

# Go workspace
go.work

# Environment
.env

# Editor
.vscode/
.idea/

# OS
.DS_Store
Thumbs.db
`,
    rust: `# Compiled files
target/
Cargo.lock

# Environment
.env

# Editor
.vscode/
.idea/

# OS
.DS_Store
Thumbs.db
`,
    ruby: `# Ruby/Rails
*.gem
*.rbc
/.config
/coverage/
/InstalledFiles
/pkg/
/spec/reports/
/test/tmp/
/test/version_tmp/
/tmp/

# Bundler
.bundle/
vendor/bundle

# Rails
log/
tmp/
db/*.sqlite3
public/system
public/uploads

# Environment
.env
.env.local

# Editor
.vscode/
.idea/

# OS
.DS_Store
Thumbs.db
`,
    php: `# Composer
vendor/
composer.lock

# Laravel / Symfony
.env
.env.local
.env.*.local
storage/logs/
storage/framework/cache/
storage/framework/sessions/
storage/framework/views/
bootstrap/cache/

# Build
dist/
build/

# Editor
.vscode/
.idea/

# OS
.DS_Store
Thumbs.db
`,
    cpp: `# Build output
build/
dist/
*.o
*.obj
*.exe
*.dll
*.so
*.a
*.lib
*.out
*.app
CMakeFiles/
CMakeCache.txt
cmake_install.cmake
Makefile

# IDE
.vscode/
.idea/
*.vcxproj.user
*.suo
*.sdf
*.opensdf

# OS
.DS_Store
Thumbs.db
`,
    swift: `# Xcode
*.xcodeproj/xcuserdata/
*.xcworkspace/xcuserdata/
*.xcworkspace/contents.xcworkspacedata
DerivedData/
*.hmap
*.ipa
*.xcarchive
build/

# Swift Package Manager
.build/
Packages/
Package.pins
Package.resolved
*.xcodeproj

# Environment
.env

# OS
.DS_Store
Thumbs.db
`,
    unity: `# Unity generated
[Ll]ibrary/
[Tt]emp/
[Oo]bj/
[Bb]uild/
[Bb]uilds/
[Ll]ogs/
[Uu]ser[Ss]ettings/

# Visual Studio
.vs/
ExportedObj/
*.csproj
*.unityproj
*.sln
*.suo
*.tmp
*.user
*.userprefs
*.pidb
*.booproj

# OS
.DS_Store
Thumbs.db
`,
    generic: `# Build output
dist/
build/
out/

# Dependencies
vendor/
node_modules/

# Environment
.env
.env.local
.env.*.local

# Logs
*.log
logs/

# Editor
.vscode/
.idea/
*.suo
*.swp
*.swo

# OS
.DS_Store
Thumbs.db
desktop.ini
`
};
