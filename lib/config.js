// What is saved per site: the servers its database comes from, the columns
// masked on every pull and the tables pulled without rows. One JSON file per
// site in the plugin's data folder, readable by the user alone.
const fs = require('node:fs');
const path = require('node:path');

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// An ssh destination: user@host, a host, or an alias from ~/.ssh/config. A
// leading dash would make it an option, so it may not start with one.
const SSH = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9_][A-Za-z0-9._:-]*$/;
const RULES = ['email', 'name', 'hash', 'null', 'empty', 'password'];

function file(site) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(site) || site.includes('..')) throw new Error(`Bad site name ${site}`);
  return path.join(process.env.LERD_PLUGIN_DATA, 'sites', site + '.json');
}

function load(site) {
  try {
    const cfg = JSON.parse(fs.readFileSync(file(site), 'utf8'));
    return { remotes: {}, default: '', mask: {}, skip: [], ...cfg };
  } catch (e) {
    if (e.code === 'ENOENT') return { remotes: {}, default: '', mask: {}, skip: [] };
    throw e;
  }
}

function save(site, cfg) {
  const f = file(site);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
}

function addRemote(cfg, name, r) {
  if (!NAME.test(name || '')) throw new Error('A server name is lowercase letters, digits and dashes, like staging');
  if (!SSH.test(r.ssh || '')) throw new Error(`${r.ssh || '(empty)'} is not an ssh destination; use user@host or a host from ~/.ssh/config`);
  if (!r.path || !(r.path.startsWith('/') || r.path.startsWith('~/')) || /[\0\n]/.test(r.path)) {
    throw new Error('The app path is the absolute path of the app on the server, like /home/forge/shop.com');
  }
  const port = r.port ? Number(r.port) : 22;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${r.port} is not a port`);
  const env = r.env || '.env';
  if (/[\0\n]/.test(env) || env.startsWith('-')) throw new Error(`${env} is not an env file name`);
  if (r.database && !/^[A-Za-z0-9_$-]{1,64}$/.test(r.database)) throw new Error(`${r.database} is not a database name`);
  if (r.identity && /[\0\n]/.test(r.identity)) throw new Error(`${r.identity} is not a key file`);
  const remote = { ssh: r.ssh, port, path: r.path, env };
  if (r.identity) remote.identity = r.identity;
  if (r.database) remote.database = r.database;
  cfg.remotes[name] = remote;
  if (r.default || !cfg.default || !cfg.remotes[cfg.default]) cfg.default = name;
  return cfg;
}

function removeRemote(cfg, name) {
  if (!cfg.remotes[name]) throw new Error(`No server named ${name} is saved for this site`);
  delete cfg.remotes[name];
  if (cfg.default === name) cfg.default = Object.keys(cfg.remotes)[0] || '';
  return cfg;
}

function setDefault(cfg, name) {
  if (!cfg.remotes[name]) throw new Error(`No server named ${name} is saved for this site`);
  cfg.default = name;
  return cfg;
}

// The server to pull from: the one named, else the site's default.
function pickRemote(cfg, name) {
  const names = Object.keys(cfg.remotes);
  if (!names.length) throw new Error('No server is saved for this site yet: lerd db-pull:add <name> <user@host> <app path>');
  const n = name || cfg.default || names[0];
  if (!cfg.remotes[n]) throw new Error(`No server named ${n}; saved: ${names.join(', ')}`);
  return { name: n, ...cfg.remotes[n] };
}

function setMask(cfg, column, rule) {
  const [table, col, extra] = (column || '').split('.');
  if (!IDENT.test(table || '') || !IDENT.test(col || '') || extra !== undefined) throw new Error(`${column} is not table.column`);
  if (rule === null) {
    delete cfg.mask[column];
    return cfg;
  }
  if (!RULES.includes(rule) && !/^set:/.test(rule || '')) throw new Error(`${rule} is not a rule; use ${RULES.join(', ')} or set:<value>`);
  if (/[\0\n]/.test(rule)) throw new Error('A set: value is a single line');
  cfg.mask[column] = rule;
  return cfg;
}

function setSkip(cfg, tables, on) {
  for (const t of tables) if (!IDENT.test(t)) throw new Error(`${t} is not a table name`);
  const set = new Set(cfg.skip);
  for (const t of tables) on ? set.add(t) : set.delete(t);
  cfg.skip = [...set].sort();
  return cfg;
}

module.exports = { load, save, addRemote, removeRemote, setDefault, pickRemote, setMask, setSkip, RULES };
