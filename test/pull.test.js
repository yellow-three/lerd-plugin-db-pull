// A pull end to end against stand-ins: ssh runs the script locally, the
// server's mysqldump and mysql are scripts, and so is lerd, which records
// what it was asked to do.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin');

function write(file, text, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
}

function setup({ env, siteService = 'mysql-8.4', dumpFails = false, maskFails = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'db-pull-'));
  const out = path.join(root, 'out');
  fs.mkdirSync(out);
  write(path.join(root, 'server/app/.env'), env || [
    'APP_NAME=Shop',
    'DB_CONNECTION=mysql',
    'DB_HOST=127.0.0.1',
    'DB_PORT=3306',
    'DB_DATABASE=shop_prod # the live one',
    'DB_USERNAME=forge',
    'DB_PASSWORD="p@ss #word"',
    '',
  ].join('\n'));
  write(path.join(root, 'server/bin/mysqldump'), `#!/bin/sh
case "$1" in --help) echo "  --set-gtid-purged=name"; exit 0 ;; --version) echo "mysqldump  Ver 8.4.3"; exit 0 ;; esac
cnf=\${1#--defaults-extra-file=}
cp "$cnf" "${out}/cnf"
echo "$*" >> "${out}/dump-args"
case "$*" in
  *--no-data*) echo "CREATE TABLE sessions (id int);" ;;
  *) echo "CREATE TABLE users (email varchar(9)) COLLATE=utf8mb4_uca1400_ai_ci;"
     echo "INSERT INTO users VALUES ('a@b.c');"
     ${dumpFails ? 'exit 2' : ''} ;;
esac
`, 0o755);
  write(path.join(root, 'server/bin/mysql'), `#!/bin/sh
cp "\${1#--defaults-extra-file=}" "${out}/client-cnf"
case "$*" in
  *"SHOW TABLES"*) printf 'users\\nsessions\\n' ;;
  *information_schema*) echo 1048576 ;;
esac
`, 0o755);
  write(path.join(root, 'ssh'), `#!/bin/sh
echo "$*" > "${out}/ssh-args"
PATH="${root}/server/bin:$PATH" exec sh -s
`, 0o755);
  write(path.join(root, 'lerd'), `#!/bin/sh
echo "$*" >> "${out}/lerd"
if [ "$1" = db:import ]; then
  n=$(ls "${out}" | grep -c '^import-' || true)
  case "$2" in *.gz) gzip -dc "$2" ;; *) cat "$2" ;; esac > "${out}/import-$n.sql"
  case "$2" in *mask*) ${maskFails ? 'echo "ERROR 1054 (42S22): Unknown column"; echo "import finished but 1 error"; exit 0' : ':'} ;; esac
  echo "import complete"
fi
`, 0o755);
  const data = path.join(root, 'data');
  const site = { name: 'shop', path: path.join(root, 'site'), db_database: 'shop', services: ['redis', siteService], worktrees: [] };
  fs.mkdirSync(site.path);
  return { root, out, data, site, read: (f) => fs.readFileSync(path.join(out, f), 'utf8') };
}

async function serve(sites) {
  const server = http.createServer((req, res) => {
    if (req.headers['x-lerd-plugin-token'] !== 'tok') return res.writeHead(401).end();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(sites));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

function run(cmd, args, env, stdin) {
  return new Promise((resolve) => {
    const child = spawn(path.join(BIN, cmd), args, { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b));
    child.stderr.on('data', (b) => (stderr += b));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin || '');
  });
}

async function withSetup(opts, fn) {
  const s = setup(opts);
  const server = await serve([s.site]);
  const env = {
    LERD_SURFACE: 'cli',
    LERD_SITE: 'shop',
    LERD_PLUGIN_DATA: s.data,
    LERD_BIN: path.join(s.root, 'lerd'),
    LERD_API_URL: `http://127.0.0.1:${server.address().port}`,
    LERD_API_TOKEN: 'tok',
    DB_PULL_SSH: path.join(s.root, 'ssh'),
  };
  try {
    await run('add', ['staging', 'forge@shop.example', path.join(s.root, 'server/app')], env);
    await fn(s, env);
  } finally {
    server.close();
    fs.rmSync(s.root, { recursive: true, force: true });
  }
}

test('pull dumps on the server, then snapshots, replaces and masks in lerd', () =>
  withSetup({}, async (s, env) => {
    await run('mask', ['users.email', 'email'], env);
    await run('mask', ['gone.secret', 'null'], env);
    await run('skip', ['sessions', 'missing'], env);
    const r = await run('pull', [], env);
    assert.equal(r.code, 0, r.stderr);

    assert.match(s.read('ssh-args'), /BatchMode=yes .*-- forge@shop\.example sh -s/);
    assert.equal(s.read('cnf'), '[client]\nuser="forge"\npassword="p@ss #word"\nhost="127.0.0.1"\nport=3306\n');
    const dumps = s.read('dump-args').trim().split('\n');
    assert.match(dumps[0], /--ignore-table=shop_prod\.sessions shop_prod$/);
    assert.doesNotMatch(dumps[0], /missing/);
    assert.match(dumps[1], /--no-data .*shop_prod sessions$/);

    const lerd = s.read('lerd').trim().split('\n');
    assert.equal(lerd[0], 'db:create shop -s mysql-8.4');
    assert.equal(lerd[1], 'db:snapshot before-db-pull -s mysql-8.4 -d shop');
    assert.match(lerd[2], /^db:import .*shop\.sql --fresh -s mysql-8\.4 -d shop$/);
    assert.match(lerd[3], /^db:import .*shop\.mask\.sql -s mysql-8\.4 -d shop$/);

    const imported = s.read('import-0.sql');
    assert.match(imported, /COLLATE=utf8mb4_0900_ai_ci/);
    assert.match(imported, /CREATE TABLE sessions/);
    assert.match(s.read('import-1.sql'), /^UPDATE `users` SET `email` = /);
    assert.doesNotMatch(s.read('import-1.sql'), /gone/);
    assert.match(r.stdout, /gone\.secret: no such table on the server, not masked/);
    assert.deepEqual(fs.readdirSync(path.join(s.data, 'tmp')), []);
  }));

test('a dump that dies halfway imports nothing', () =>
  withSetup({ dumpFails: true }, async (s, env) => {
    const r = await run('pull', [], env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /dump stopped with an error/);
    assert.equal(fs.existsSync(path.join(s.out, 'lerd')), false);
  }));

test('a server on another engine than the site is refused before importing', () =>
  withSetup({ env: 'DB_CONNECTION=pgsql\nDB_DATABASE=shop\n' }, async (s, env) => {
    const r = await run('pull', [], env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /server's database is postgres, but shop uses mysql-8\.4/);
    assert.equal(fs.existsSync(path.join(s.out, 'lerd')), false);
  }));

test('a mask that fails is reported as unmasked data', () =>
  withSetup({ maskFails: true }, async (s, env) => {
    await run('mask', ['users.email', 'email'], env);
    const r = await run('pull', [], env);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Masking failed, so shop in lerd holds unmasked data/);
  }));

test('DATABASE_URL is read when DB_DATABASE is not set', () =>
  withSetup({ env: 'DATABASE_URL="mysql://app:s3cret@db.internal:3307/shop_live?serverVersion=8"\n' }, async (s, env) => {
    const r = await run('test', [], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /staging: mysql database shop_live, about 1\.0 MB, 2 tables/);
    assert.equal(s.read('client-cnf'), '[client]\nuser="app"\npassword="s3cret"\nhost="db.internal"\nport=3307\n');
    assert.equal(fs.existsSync(path.join(s.out, 'dump-args')), false);
  }));

test('the assistant gets JSON and cannot skip masking', () =>
  withSetup({}, async (s, env) => {
    await run('mask', ['users.email', 'email'], env);
    const r = await run('pull', [], { ...env, LERD_SURFACE: 'mcp' }, JSON.stringify({ site: 'shop', no_mask: true, noMask: true }));
    assert.equal(r.code, 0, r.stderr);
    const res = JSON.parse(r.stdout);
    assert.deepEqual(res.masked, ['users.email']);
    assert.equal(res.snapshot, 'before-db-pull');
  }));

test('the dashboard reads and changes settings through the config endpoint', () =>
  withSetup({}, async (s, env) => {
    const api = { ...env, LERD_SURFACE: 'api', LERD_METHOD: 'POST' };
    let r = await run('config', [], api, JSON.stringify({ action: 'mask', column: 'users.name', rule: 'name' }));
    assert.equal(r.code, 0, r.stderr);
    r = await run('config', [], api, JSON.stringify({ action: 'add-remote', name: 'prod', ssh: 'p', path: '/srv/shop', default: true }));
    r = await run('config', [], { ...api, LERD_METHOD: 'GET' });
    const cfg = JSON.parse(r.stdout);
    assert.equal(cfg.default, 'prod');
    assert.deepEqual(cfg.mask, { 'users.name': 'name' });
    r = await run('config', [], api, JSON.stringify({ action: 'nope' }));
    assert.equal(r.code, 1);
  }));
