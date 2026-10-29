// A pull end to end: dump on the server, then snapshot, replace and mask the
// lerd database through lerd's own commands.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');
const { lerd, target } = require('./lerd');
const config = require('./config');
const { runRemote } = require('./remote');
const { maskSQL } = require('./mask');

const mb = (n) => (n < 1048576 ? Math.max(1, Math.round(n / 1024)) + ' KB' : (n / 1048576).toFixed(1) + ' MB');

// MariaDB writes collations and an sql_mode MySQL refuses; a dump headed for
// a MySQL service gets the nearest MySQL ones.
function mariadbToMysql(line) {
  return line
    .replace(/\butf8mb4_uca1400_\w+/g, 'utf8mb4_0900_ai_ci')
    .replace(/\butf8mb3_uca1400_\w+/g, 'utf8mb3_general_ci')
    .replace(/(sql_mode\s*=\s*'[^']*)/g, (m) => m.replace(/NO_AUTO_CREATE_USER,?|,NO_AUTO_CREATE_USER/g, ''));
}

async function gunzipRewrite(src, dest, fn) {
  const out = fs.createWriteStream(dest, { mode: 0o600 });
  const input = fs.createReadStream(src).pipe(zlib.createGunzip());
  for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
    if (!out.write(fn(line) + '\n')) await new Promise((r) => out.once('drain', r));
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
}

// lerd db:import exits 0 when some statements failed and says so in its
// output, so masking reads that output: a mask that did not apply must stop.
function lerdChecked(args, cwd) {
  const r = spawnSync(process.env.LERD_BIN, args, { cwd, encoding: 'utf8' });
  const text = (r.stdout || '') + (r.stderr || '');
  process.stderr.write(text);
  if (r.status !== 0 || /finished but|^ERROR[\s:]/m.test(text)) throw new Error(`lerd ${args.join(' ')} reported errors`);
}

// log goes to stdout in a terminal or the run modal, to stderr otherwise.
function logger() {
  const quiet = ['mcp', 'api'].includes(process.env.LERD_SURFACE);
  return (msg) => (quiet ? process.stderr : process.stdout).write(msg + '\n');
}

async function pull({ site, branch, remote: remoteName, noMask }) {
  const log = logger();
  const t = await target(site, branch);
  const cfg = config.load(t.site);
  const remote = config.pickRemote(cfg, remoteName);
  if (!t.database) throw new Error(`lerd does not know ${t.label}'s database name; set DB_DATABASE in its .env`);

  const tmp = path.join(process.env.LERD_PLUGIN_DATA, 'tmp');
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const gz = path.join(tmp, `${t.site}.sql.gz`);
  const plain = path.join(tmp, `${t.site}.sql`);
  const maskFile = path.join(tmp, `${t.site}.mask.sql`);

  log(`${t.label}: dumping from ${remote.name} (${remote.ssh}:${remote.path})`);
  try {
    let size = 0;
    let lastLog = Date.now();
    const timer = setInterval(() => {
      let n = 0;
      try { n = fs.statSync(gz).size; } catch {}
      if (Date.now() - lastLog > 4000) {
        lastLog = Date.now();
        log(`  received ${mb(n)} compressed${size ? ` of about ${mb(size)} on the server` : ''}`);
      }
    }, 1000);
    let res;
    try {
      res = await runRemote(remote, { mode: 'dump', skip: cfg.skip }, {
        out: gz,
        onFact(key, value) {
          if (key === 'size') size = Number(value) || 0;
          if (key === 'engine' && value !== t.engine) {
            return new Error(`The server's database is ${value}, but ${t.label} uses ${t.service} in lerd; nothing was imported`);
          }
        },
      });
    } finally {
      clearInterval(timer);
    }
    const { facts, bytes } = res;
    log(`  ${facts.database}: ${mb(bytes)} compressed`);

    let file = gz;
    if (/^mysql(-|$)/.test(t.service)) {
      await gunzipRewrite(gz, plain, mariadbToMysql);
      fs.rmSync(gz, { force: true });
      file = plain;
    }

    lerd(['db:create', t.database, '-s', t.service], t.path);
    lerd(['db:snapshot', 'before-db-pull', '-s', t.service, '-d', t.database], t.path);
    lerd(['db:import', file, '--fresh', '-s', t.service, '-d', t.database], t.path);

    const masked = [];
    if (!noMask && Object.keys(cfg.mask).length) {
      const tables = facts.tables ? facts.tables.split(',').filter(Boolean) : null;
      const sql = maskSQL(t.engine, cfg.mask, tables);
      for (const column of Object.keys(cfg.mask)) {
        if (tables && !tables.includes(column.split('.')[0])) log(`  ${column}: no such table on the server, not masked`);
        else masked.push(column);
      }
      if (sql) {
        fs.writeFileSync(maskFile, sql + '\n', { mode: 0o600 });
        log(`  masking ${masked.join(', ')}`);
        try {
          lerdChecked(['db:import', maskFile, '-s', t.service, '-d', t.database], t.path);
        } catch (e) {
          throw new Error(`Masking failed, so ${t.database} in lerd holds unmasked data from ${remote.name}. Fix the rule (lerd db-pull:remotes) and pull again, or bring the old data back with lerd db:restore before-db-pull. ${e.message}`);
        }
      }
    }

    cfg.last = { remote: remote.name, at: new Date().toISOString(), bytes, masked: masked.length };
    config.save(t.site, cfg);
    log(`${t.label}: ${facts.database} from ${remote.name} is now ${t.database} in lerd's ${t.service}${masked.length ? `, ${masked.length} column(s) masked` : ''}. lerd db:restore before-db-pull brings the old data back.`);
    return { site: t.label, remote: remote.name, database: t.database, service: t.service, bytes, masked, snapshot: 'before-db-pull' };
  } finally {
    for (const f of [gz, plain, maskFile]) fs.rmSync(f, { force: true });
  }
}

async function test({ site, remote: remoteName }) {
  const cfg = config.load(site);
  const remote = config.pickRemote(cfg, remoteName);
  const { facts } = await runRemote(remote, { mode: 'check', skip: cfg.skip });
  const tables = (facts.tables || '').split(',').filter(Boolean);
  return {
    remote: remote.name,
    engine: facts.engine,
    database: facts.database,
    size: Number(facts.size) || null,
    tables: tables.length || null,
    dumper: facts.dumper || '',
  };
}

module.exports = { pull, test, mariadbToMysql, mb };
