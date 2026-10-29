// Small helpers over what lerd hands every plugin process: its API and its CLI.
const { spawnSync } = require('node:child_process');

async function api(path) {
  const res = await fetch(process.env.LERD_API_URL + path, {
    headers: { 'X-Lerd-Plugin-Token': process.env.LERD_API_TOKEN },
  });
  if (!res.ok) throw new Error(`lerd API ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// Runs a lerd command in a site's folder. In a terminal or the run modal its
// progress lines are shown as they come; for an assistant or the dashboard's
// API they go to stderr, so stdout stays the answer.
function lerd(args, cwd) {
  const quiet = ['mcp', 'api'].includes(process.env.LERD_SURFACE);
  const r = spawnSync(process.env.LERD_BIN, args, { cwd, stdio: ['ignore', quiet ? 2 : 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error(`lerd ${args.join(' ')} failed`);
}

// The engine a lerd service speaks, from its name.
function engineOf(service) {
  if (/^(mysql|mariadb)(-|$)/.test(service)) return 'mysql';
  if (/^postgres(-|$)/.test(service)) return 'postgres';
  return null;
}

// Where a pull lands: the site, or the worktree picked for it, with the lerd
// service and database it uses.
async function target(name, branch) {
  if (!name) throw new Error('No site given: run this inside a linked project or pass --site <name>');
  const sites = await api('/api/sites');
  const site = sites.find((s) => s.name === name);
  if (!site) throw new Error(`No lerd site named ${name}`);
  const t = { site: site.name, label: site.name, path: site.path, database: site.db_database };
  if (branch) {
    const wt = (site.worktrees || []).find((w) => w.branch === branch || w.git_branch === branch);
    if (wt) Object.assign(t, { label: `${site.name} (${branch})`, path: wt.path, database: wt.db_database || t.database });
  }
  t.service = (site.services || []).find((s) => engineOf(s));
  if (!t.service) throw new Error(`${site.name} uses no MySQL, MariaDB or PostgreSQL service in lerd`);
  t.engine = engineOf(t.service);
  return t;
}

module.exports = { api, lerd, engineOf, target };
