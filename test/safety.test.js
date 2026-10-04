const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
    isValidRepoName,
    isValidBranchName,
    isGithubHttpsUrl,
    stripUrlCredentials,
    redactSecrets,
    gitAuthEnv,
    planCommitRewrite
} = require('../lib/safety');

const TOKEN = 'ghp_FAKEtoken1234567890';

// --- helpers -------------------------------------------------------------
const person = (n) => ({ name: n, email: `${n}@example.com`, date: '2026-01-01T00:00:00Z' });
function commit(sha, parentShas, message = `msg ${sha}`) {
    return {
        sha,
        parents: parentShas.map(s => ({ sha: s })),
        commit: { message, tree: { sha: `tree-${sha}` }, author: person('a'), committer: person('c') }
    };
}
const sha = (c) => c.repeat(40);
// Linear history HEAD -> older: d -> c -> b -> a(root)
const linear = [
    commit(sha('d'), [sha('c')]),
    commit(sha('c'), [sha('b')]),
    commit(sha('b'), [sha('a')]),
    commit(sha('a'), [])
];

// --- repo / branch names (F03, F12, path traversal) -----------------------
test('isValidRepoName accepts GitHub-style names', () => {
    for (const n of ['repo', 'my-repo', 'My.Repo_2', 'a'.repeat(100)]) assert.equal(isValidRepoName(n), true, n);
});

test('isValidRepoName rejects HTML, paths and bad lengths', () => {
    for (const n of ['', '.', '..', '<img src=x onerror=alert(1)>', '../evil', 'a/b', 'a\\b', 'a b', 'a'.repeat(101), null, 42]) {
        assert.equal(isValidRepoName(n), false, String(n));
    }
});

test('isValidBranchName', () => {
    for (const n of ['main', 'master', 'feature/x', 'release-1.2']) assert.equal(isValidBranchName(n), true, n);
    for (const n of ['', '-x', '/x', 'x/', 'a..b', 'a//b', 'x.lock', 'a b', 'a~1', 'x.', 'a/.b']) assert.equal(isValidBranchName(n), false, n);
});

// --- token target validation (F04) -----------------------------------------
test('isGithubHttpsUrl only allows https://github.com', () => {
    assert.equal(isGithubHttpsUrl('https://github.com/user/repo.git'), true);
    assert.equal(isGithubHttpsUrl('https://GitHub.com/user/repo'), true);
    for (const u of [
        'https://example.invalid/repo.git',
        'http://github.com/user/repo.git',
        'https://github.com.evil.com/repo.git',
        'https://evil.com/github.com/repo.git',
        'https://github.com:8443/user/repo.git',
        'git@github.com:user/repo.git',
        'ext::sh -c touch% /tmp/pwned',
        'not a url'
    ]) {
        assert.equal(isGithubHttpsUrl(u), false, u);
    }
});

test('stripUrlCredentials removes embedded credentials', () => {
    assert.equal(stripUrlCredentials(`https://${TOKEN}@github.com/u/r.git`), 'https://github.com/u/r.git');
    assert.equal(stripUrlCredentials('https://github.com/u/r.git'), 'https://github.com/u/r.git');
});

// --- secret handling (F05) ------------------------------------------------
test('redactSecrets removes raw token, basic-auth form and URL credentials', () => {
    const b64 = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    const msg = `Command failed: git push https://${TOKEN}@github.com/u/r.git\nAUTHORIZATION: basic ${b64}\nhttps://user:pass@host/x`;
    const out = redactSecrets(msg, [TOKEN]);
    assert.ok(!out.includes(TOKEN));
    assert.ok(!out.includes(b64));
    assert.ok(!out.includes('user:pass'));
});

test('gitAuthEnv keeps the token out of argv and appends to existing GIT_CONFIG_*', () => {
    const env = gitAuthEnv(TOKEN, { PATH: '/bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.x', GIT_CONFIG_VALUE_0: 'y' });
    assert.equal(env.GIT_CONFIG_COUNT, '3');
    assert.equal(env.GIT_CONFIG_KEY_0, 'core.x');
    assert.equal(env.GIT_CONFIG_KEY_1, 'credential.helper');
    assert.equal(env.GIT_CONFIG_VALUE_1, '');
    assert.equal(env.GIT_CONFIG_KEY_2, 'http.https://github.com/.extraheader');
    assert.match(env.GIT_CONFIG_VALUE_2, /^AUTHORIZATION: basic /);
    assert.ok(!env.GIT_CONFIG_VALUE_2.includes(TOKEN), 'raw token must not appear');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
});

test('installed git picks up the auth header from env (GIT_CONFIG_*)', () => {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync('git', ['config', '--get', 'http.https://github.com/.extraheader'], {
        env: gitAuthEnv(TOKEN), encoding: 'utf8'
    }).trim();
    assert.equal(out, `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`);
});

// --- commit rewrite planning (F02, F13) -----------------------------------
test('planCommitRewrite rewrites from the oldest target up to HEAD', () => {
    const plan = planCommitRewrite(linear, [{ sha: sha('b').slice(0, 7), newMessage: 'fixed b' }]);
    assert.equal(plan.ok, true);
    assert.equal(plan.headSha, sha('d'));
    assert.deepEqual(plan.baseParents, [sha('a')]);
    assert.deepEqual(plan.steps.map(s => s.message), ['fixed b', 'msg ' + sha('c'), 'msg ' + sha('d')]);
    // metadata source is carried along for author/committer preservation
    assert.equal(plan.steps[0].original.commit.author.name, 'a');
});

test('planCommitRewrite supports rewriting the root commit', () => {
    const plan = planCommitRewrite(linear, [{ sha: sha('a'), newMessage: 'root' }]);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.baseParents, []);
    assert.equal(plan.steps.length, 4);
});

test('planCommitRewrite fails when ANY requested SHA is missing (no partial success)', () => {
    const plan = planCommitRewrite(linear, [
        { sha: sha('c'), newMessage: 'ok' },
        { sha: 'deadbee', newMessage: 'missing' }
    ]);
    assert.equal(plan.ok, false);
    assert.match(plan.error, /deadbee/);
});

test('planCommitRewrite rejects merge commits in the rewritten range', () => {
    const withMerge = [
        commit(sha('d'), [sha('c')]),
        commit(sha('c'), [sha('b'), sha('e')]), // merge
        commit(sha('b'), [sha('a')]),
        commit(sha('a'), [])
    ];
    const plan = planCommitRewrite(withMerge, [{ sha: sha('b'), newMessage: 'x' }]);
    assert.equal(plan.ok, false);
    assert.match(plan.error, /merge/i);
});

test('planCommitRewrite allows merges older than the rewritten range', () => {
    const oldMerge = [
        commit(sha('d'), [sha('c')]),
        commit(sha('c'), [sha('b'), sha('e')]) // merge below the target
    ];
    const plan = planCommitRewrite(oldMerge, [{ sha: sha('d'), newMessage: 'x' }]);
    assert.equal(plan.ok, true);
    assert.deepEqual(plan.baseParents, [sha('c')]);
});

test('planCommitRewrite rejects non-linear listings, bad SHAs and empty messages', () => {
    const gap = [commit(sha('d'), [sha('x')]), commit(sha('c'), [sha('b')])];
    assert.equal(planCommitRewrite(gap, [{ sha: sha('c'), newMessage: 'x' }]).ok, false);
    assert.equal(planCommitRewrite(linear, [{ sha: 'abc', newMessage: 'x' }]).ok, false);
    assert.equal(planCommitRewrite(linear, [{ sha: sha('c'), newMessage: '   ' }]).ok, false);
    assert.equal(planCommitRewrite([], [{ sha: sha('c'), newMessage: 'x' }]).ok, false);
});

// --- static regression guards ---------------------------------------------
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('F01: publish never deletes a .git directory', () => {
    assert.ok(!/rmSync\s*\(/.test(mainSrc), 'main.js must not call fs.rmSync');
});

test('F05: token is never interpolated into a URL', () => {
    assert.ok(!/https:\/\/\$\{token\}@/.test(mainSrc));
});

test('F08: secrets are never persisted with enc:false', () => {
    assert.ok(!/enc:\s*false/.test(mainSrc));
});

test('F03: recent operations escape repoName', () => {
    const fn = htmlSrc.slice(htmlSrc.indexOf('function renderRecentOps'), htmlSrc.indexOf('function opBadge'));
    assert.ok(fn.includes('escHtml(op.repoName'), 'renderRecentOps must escape op.repoName');
    assert.ok(!/\$\{op\.repoName/.test(fn));
});

test('no native alert/confirm/prompt in the renderer', () => {
    assert.ok(!/(?<![\w.])(alert|confirm|prompt)\s*\(/.test(htmlSrc.replace(/showConfirm\(/g, '')));
});

test('auto update: installer name has no spaces so latest.yml matches the uploaded asset', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const artifact = pkg.build.nsis.artifactName;
    assert.ok(artifact && !/\s/.test(artifact), 'nsis.artifactName must not contain spaces');
    assert.ok(pkg.build.publish.some(p => p.provider === 'github' && p.repo === 'github-repo-cleaner-ai'));
    assert.ok(pkg.dependencies && pkg.dependencies['electron-updater'], 'electron-updater must be a runtime dependency');
    const release = fs.readFileSync(path.join(__dirname, '..', 'release.sh'), 'utf8');
    const expected = artifact.replace('${version}', '${VERSION}').replace('${ext}', 'exe');
    assert.ok(release.includes(`EXE="dist/${expected}"`), 'release.sh must upload the same file name');
    assert.ok(/--publish never/.test(pkg.scripts.build), 'local builds must not auto-publish');
});
