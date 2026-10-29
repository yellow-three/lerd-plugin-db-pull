// Everything that happens on the server. A POSIX shell script goes to the
// server over ssh on stdin, reads the app's own env file there and runs the
// dump, so the server's database password never leaves the server.
const { spawn } = require('node:child_process');
const fs = require('node:fs');

const q = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'";

// The server-side script. mode is check (report what would be pulled) or dump
// (write the gzipped dump to stdout). Facts go to stderr as db-pull:key=value.
function script({ mode, path, env, database, skip }) {
  const appPath = path.startsWith('~/') ? `"$HOME"/${q(path.slice(2))}` : q(path);
  return `set -eu
MODE=${q(mode)}
APP_PATH=${appPath}
ENV_FILE=${q(env)}
DB_OVERRIDE=${q(database || '')}
SKIP=${q((skip || []).join(' '))}
cnf= st=
trap 'rm -f "$cnf" "$st"' EXIT
say() { printf 'db-pull:%s\\n' "$1" >&2; }
fail() { printf '%s\\n' "$1" >&2; exit 3; }

cd "$APP_PATH" 2>/dev/null || fail "There is no folder $APP_PATH on the server."
[ -r "$ENV_FILE" ] || fail "There is no readable $ENV_FILE in $APP_PATH on the server."

# The last KEY= line of the env file, quotes and trailing comments removed.
envval() {
  v=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$ENV_FILE" | tail -n 1 | tr -d '\\r') || true
  v=\${v#*=}
  v=$(printf '%s' "$v" | sed 's/^[[:space:]]*//')
  case $v in
    \\"*) v=\${v#\\"}; v=\${v%%\\"*} ;;
    \\'*) v=\${v#\\'}; v=\${v%%\\'*} ;;
    *) v=$(printf '%s' "$v" | sed 's/[[:space:]]#.*$//; s/[[:space:]]*$//') ;;
  esac
  printf '%s' "$v"
}

conn=$(envval DB_CONNECTION); host=$(envval DB_HOST); port=$(envval DB_PORT)
db=$(envval DB_DATABASE); user=$(envval DB_USERNAME); pass=$(envval DB_PASSWORD)
url=$(envval DB_URL); [ -n "$url" ] || url=$(envval DATABASE_URL)
if [ -n "$url" ] && [ -z "$db" ]; then
  conn=\${url%%://*}; rest=\${url#*://}
  case $rest in *@*) cred=\${rest%@*}; rest=\${rest##*@}; user=\${cred%%:*}; case $cred in *:*) pass=\${cred#*:} ;; esac ;; esac
  hp=\${rest%%/*}; db=\${rest#*/}; db=\${db%%\\?*}
  host=\${hp%%:*}; case $hp in *:*) port=\${hp#*:} ;; esac
fi
[ -z "$DB_OVERRIDE" ] || db=$DB_OVERRIDE

case $conn in
  mysql|mariadb|mysqli|pdo_mysql|mysql2) engine=mysql ;;
  pgsql|postgres|postgresql|pdo_pgsql) engine=postgres ;;
  '') fail "$ENV_FILE on the server sets neither DB_CONNECTION nor DB_URL." ;;
  *) fail "db-pull copies MySQL, MariaDB and PostgreSQL databases; the server's app uses $conn." ;;
esac
[ -n "$db" ] || fail "$ENV_FILE on the server names no database (DB_DATABASE)."
case $db in *[!A-Za-z0-9_\\$-]*) fail "db-pull does not handle the database name $db." ;; esac
command -v gzip >/dev/null || fail "gzip is not installed on the server."
say "engine=$engine"
say "database=$db"

if [ "$engine" = mysql ]; then
  dump=$(command -v mysqldump || command -v mariadb-dump || true)
  client=$(command -v mysql || command -v mariadb || true)
  [ -n "$dump" ] || fail "Neither mysqldump nor mariadb-dump is installed on the server."
  # The credentials go in an option file, so they never show in ps.
  cnf=$(mktemp); chmod 600 "$cnf"
  esc() { printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g'; }
  {
    echo '[client]'
    if [ -n "$user" ]; then echo "user=\\"$(esc "$user")\\""; fi
    if [ -n "$pass" ]; then echo "password=\\"$(esc "$pass")\\""; fi
    if [ -n "$host" ]; then echo "host=\\"$(esc "$host")\\""; fi
    if [ -n "$port" ]; then echo "port=$port"; fi
  } > "$cnf"
  sql() { "$client" --defaults-extra-file="$cnf" -N -B -e "$1" "$db"; }
  extra=
  help=$("$dump" --help 2>/dev/null || true)
  case $help in *--set-gtid-purged*) extra="$extra --set-gtid-purged=OFF" ;; esac
  case $help in *--column-statistics*) extra="$extra --column-statistics=0" ;; esac
  tables=
  if [ -n "$client" ]; then
    tables=$(sql 'SHOW TABLES') || fail "Could not connect to the database $db on the server."
    say "size=$(sql "SELECT COALESCE(SUM(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = DATABASE()" || echo 0)"
  fi
  ignore= keep=
  for t in $SKIP; do
    if [ -z "$client" ] || printf '%s\\n' "$tables" | grep -qx "$t"; then ignore="$ignore --ignore-table=$db.$t"; keep="$keep $t"; fi
  done
  run_dump() {
    "$dump" --defaults-extra-file="$cnf" --single-transaction --quick --no-tablespaces $extra $ignore "$db" &&
    if [ -n "$keep" ]; then "$dump" --defaults-extra-file="$cnf" --no-data --no-tablespaces $extra "$db" $keep; fi
  }
else
  dump=$(command -v pg_dump || true)
  [ -n "$dump" ] || fail "pg_dump is not installed on the server."
  [ -z "$host" ] || export PGHOST="$host"
  [ -z "$port" ] || export PGPORT="$port"
  [ -z "$user" ] || export PGUSER="$user"
  [ -z "$pass" ] || export PGPASSWORD="$pass"
  export PGDATABASE="$db"
  tables=
  if command -v psql >/dev/null; then
    tables=$(psql -Atc "SELECT tablename FROM pg_tables WHERE schemaname = ANY (current_schemas(false))") || fail "Could not connect to the database $db on the server."
    say "size=$(psql -Atc 'SELECT pg_database_size(current_database())' || echo 0)"
  fi
  excl=
  for t in $SKIP; do excl="$excl --exclude-table-data=$t"; done
  run_dump() { "$dump" --no-owner --no-acl $excl "$db"; }
fi
say "tables=$(printf '%s' "$tables" | tr '\\n' ',')"
say "dumper=$("$dump" --version 2>/dev/null | head -n 1)"
[ "$MODE" = dump ] || exit 0

# A plain pipe would hide a dump that died halfway, so its status is kept apart.
st=$(mktemp)
{ run_dump || echo failed > "$st"; } | gzip -c
[ ! -s "$st" ] || fail "The dump stopped with an error on the server, so nothing was imported."
`;
}

function sshArgs(r) {
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-p', String(r.port || 22)];
  if (r.identity) args.push('-i', r.identity.replace(/^~\//, require('node:os').homedir() + '/'), '-o', 'IdentitiesOnly=yes');
  return [...args, '--', r.ssh, 'sh -s'];
}

// Runs the script on the server. With out, stdout (the dump) goes to that
// file; onFact sees each db-pull:key=value line and may return an error to
// stop early. Other stderr lines go to ours.
function runRemote(remote, opts, { out, onFact } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.DB_PULL_SSH || 'ssh', sshArgs(remote), { stdio: ['pipe', 'pipe', 'pipe'] });
    const facts = {};
    const tail = [];
    let stopped = null;
    let bytes = 0;
    const sink = out ? fs.createWriteStream(out, { mode: 0o600 }) : null;
    const sinkDone = sink ? new Promise((r, j) => sink.on('finish', r).on('error', j)) : Promise.resolve();
    child.stdout.on('data', (b) => (bytes += b.length));
    if (sink) child.stdout.pipe(sink);
    else child.stdout.resume();

    let buf = '';
    child.stderr.on('data', (b) => {
      buf += b.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = /^db-pull:(\w+)=(.*)$/.exec(line);
        if (m) {
          facts[m[1]] = m[2];
          const err = onFact && onFact(m[1], m[2], facts);
          if (err && !stopped) {
            stopped = err;
            child.kill();
          }
          continue;
        }
        tail.push(line);
        if (tail.length > 20) tail.shift();
        process.stderr.write(line + '\n');
      }
    });
    child.on('error', reject);
    child.on('close', async (code) => {
      await sinkDone.catch(() => {});
      if (stopped) return reject(stopped);
      if (code === 255) {
        return reject(new Error(`Could not reach ${remote.ssh} over ssh. db-pull never asks for a password, so the key has to be in ssh-agent or saved with --identity, and the host in ~/.ssh/known_hosts.`));
      }
      if (code !== 0) {
        // The server's own message is already on stderr; repeat it only in the error's text.
        const last = tail.filter(Boolean).pop();
        return reject(Object.assign(new Error(last || `The server's script exited with ${code}`), { shown: !!last }));
      }
      resolve({ facts, bytes });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(script({ ...opts, path: remote.path, env: remote.env, database: remote.database }));
  });
}

module.exports = { script, sshArgs, runRemote };
