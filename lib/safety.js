// Pure safety helpers used by main.js. No Electron imports, so they can be
// unit-tested with `node --test`.

const REPO_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;

// GitHub repository names: letters, digits, '.', '_', '-' (max 100).
// Also guarantees the name is a single path segment (no traversal).
function isValidRepoName(name) {
    return typeof name === 'string' && REPO_NAME_RE.test(name) && name !== '.' && name !== '..';
}

// Conservative subset of `git check-ref-format --branch`.
function isValidBranchName(name) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 100) return false;
    if (!/^[A-Za-z0-9._\/-]+$/.test(name)) return false;
    if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/')) return false;
    if (name.endsWith('.') || name.endsWith('.lock')) return false;
    if (name.includes('..') || name.includes('//') || name.includes('/.')) return false;
    return true;
}

// Only https://github.com/... is allowed to receive the GitHub token.
function isGithubHttpsUrl(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && u.hostname.toLowerCase() === 'github.com' && !u.port;
    } catch (e) {
        return false;
    }
}

function stripUrlCredentials(url) {
    return String(url).replace(/^(https?:\/\/)[^@/]+@/i, '$1');
}

function basicAuthValue(token) {
    return Buffer.from(`x-access-token:${token}`).toString('base64');
}

// Remove tokens (raw and as Basic auth) and URL credentials from any text
// that may reach the UI or logs.
function redactSecrets(text, secrets = []) {
    let out = String(text == null ? '' : text);
    for (const s of secrets) {
        if (!s) continue;
        out = out.split(s).join('***');
        out = out.split(basicAuthValue(s)).join('***');
    }
    return out.replace(/(https?:\/\/)[^@\s/]+@/gi, '$1***@');
}

// Env for a git child process that authenticates to github.com with the token
// WITHOUT putting it in argv or .git/config (GIT_CONFIG_* needs git >= 2.31).
function gitAuthEnv(token, baseEnv = process.env) {
    const env = { ...baseEnv, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
    let n = parseInt(env.GIT_CONFIG_COUNT || '0', 10) || 0;
    // Reset credential helpers so a cached credential for another account is never used.
    env[`GIT_CONFIG_KEY_${n}`] = 'credential.helper';
    env[`GIT_CONFIG_VALUE_${n}`] = '';
    n++;
    env[`GIT_CONFIG_KEY_${n}`] = 'http.https://github.com/.extraheader';
    env[`GIT_CONFIG_VALUE_${n}`] = `AUTHORIZATION: basic ${basicAuthValue(token)}`;
    n++;
    env.GIT_CONFIG_COUNT = String(n);
    return env;
}

// Validate a commit-message rewrite against a GitHub commit list (HEAD -> older).
// Every requested SHA must resolve to exactly one commit, and the rewritten range
// must be a linear first-parent chain without merge commits (rewriting merges
// through the REST API would flatten the DAG).
function planCommitRewrite(commits, fixes) {
    if (!Array.isArray(commits) || commits.length === 0) {
        return { ok: false, error: 'No commits found on the default branch.' };
    }
    if (!Array.isArray(fixes) || fixes.length === 0) {
        return { ok: false, error: 'No commit fixes were provided.' };
    }

    const messages = new Map(); // index -> new message
    const missing = [];
    for (const fix of fixes) {
        const sha = String((fix && fix.sha) || '').toLowerCase();
        const msg = fix && typeof fix.newMessage === 'string' ? fix.newMessage.trim() : '';
        if (!/^[0-9a-f]{7,40}$/.test(sha)) {
            return { ok: false, error: `Invalid commit SHA: "${sha}"` };
        }
        if (!msg) {
            return { ok: false, error: `Empty commit message for ${sha.slice(0, 7)}` };
        }
        const matches = [];
        commits.forEach((c, i) => { if (c.sha.toLowerCase().startsWith(sha)) matches.push(i); });
        if (matches.length === 0) { missing.push(sha.slice(0, 7)); continue; }
        if (matches.length > 1) {
            return { ok: false, error: `Ambiguous commit SHA: ${sha}` };
        }
        messages.set(matches[0], msg);
    }
    if (missing.length > 0) {
        return {
            ok: false,
            error: `Commit(s) not found in the last ${commits.length} commits: ${missing.join(', ')}. Nothing was changed.`
        };
    }

    const startIndex = Math.max(...messages.keys());
    for (let i = 0; i <= startIndex; i++) {
        const parents = commits[i].parents || [];
        if (parents.length > 1) {
            return {
                ok: false,
                error: `Commit ${commits[i].sha.slice(0, 7)} is a merge commit. Rewriting history that contains merges is not supported. Nothing was changed.`
            };
        }
        if (i < startIndex && (parents.length === 0 || parents[0].sha !== commits[i + 1].sha)) {
            return { ok: false, error: 'History is not linear in the selected range. Nothing was changed.' };
        }
    }

    const steps = [];
    for (let i = startIndex; i >= 0; i--) {
        steps.push({ original: commits[i], message: messages.has(i) ? messages.get(i) : commits[i].commit.message });
    }
    return {
        ok: true,
        headSha: commits[0].sha,
        baseParents: (commits[startIndex].parents || []).map(p => p.sha),
        steps
    };
}

module.exports = {
    isValidRepoName,
    isValidBranchName,
    isGithubHttpsUrl,
    stripUrlCredentials,
    redactSecrets,
    gitAuthEnv,
    planCommitRewrite
};
