# db-pull

Pulls a site's database from its staging or production server into lerd over SSH, and masks the personal data you choose on the way in, so a copy of real data never sits on your machine with real email addresses and passwords in it.

The dump runs on the server, reading the database settings from the app's own `.env` there, so the server's database password never leaves the server and you never type it into lerd. The server is only read.

## Add a server

Inside the project:

```bash
lerd db-pull:add staging forge@203.0.113.10 /home/forge/shop.com
lerd db-pull:test
```

`test` connects, reads the `.env` and shows which database a pull would copy, how big it is and which dump tool the server has, without dumping anything.

| Option | Meaning |
|---|---|
| `--port` | SSH port, 22 by default |
| `--identity` | The SSH key to use, when it is not in ssh-agent |
| `--env` | The env file in the app folder, `.env` by default |
| `--database` | The database to dump, when it is not the one the env file names |
| `--default` | Make this the server a plain `pull` uses; the first one saved is the default |

A site can have several servers, `staging` and `production` say. `lerd db-pull:remotes` lists them, and `lerd db-pull:remove <name>` forgets one.

### What the server needs

- SSH access with a key. db-pull never asks for a password: the key has to be loaded in ssh-agent, or saved with `--identity`, and the server has to be in `~/.ssh/known_hosts` (connect to it once with `ssh` to add it). When you pull from the dashboard, the dashboard's background service has to reach your ssh-agent too; if it cannot, save the key with `--identity`.
- `mysqldump` or `mariadb-dump` for MySQL and MariaDB, `pg_dump` for PostgreSQL, and `gzip`. The `mysql` or `psql` client is optional; with it, `test` shows the size and masking skips tables the server does not have.
- An env file with `DB_CONNECTION`, `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME` and `DB_PASSWORD`, as Laravel writes it, or a `DB_URL` / `DATABASE_URL` such as `mysql://user:pass@host:3306/db`. A password in a URL is used as written, without decoding `%` escapes.

## Pull

| Where | How |
|---|---|
| Terminal, inside a project | `lerd db-pull:pull` for the default server, `lerd db-pull:pull production` for another |
| Dashboard | the site's **Commands** menu, **Pull database from server**, or the **Pull** button on the site's **DB Pull** tab |
| AI assistant | `db-pull_pull` |

A pull:

1. dumps the database on the server, compressed, and streams it to your machine. A dump that fails halfway is thrown away and nothing changes in lerd;
2. takes a `before-db-pull` snapshot of the site's lerd database, so `lerd db:restore before-db-pull` brings the old data back;
3. replaces the site's lerd database with the dump;
4. runs the masking rules.

A worktree picked in the dashboard's Commands menu pulls into the worktree's own database. A dump from MariaDB headed for a MySQL service has its MariaDB-only collations swapped for MySQL ones. A server on another engine than the site, PostgreSQL into MySQL say, is refused before anything is imported.

The dashboard stops a pull after 10 minutes, and the Commands menu after an hour; the terminal has no limit, so pull a big database from there.

## Mask personal data

Rules are saved per site and run on every pull:

```bash
lerd db-pull:mask users.email email
lerd db-pull:mask users.name name
lerd db-pull:mask users.password password
lerd db-pull:mask users.phone null
lerd db-pull:mask users.remember_token null
lerd db-pull:mask users.email --off
```

| Rule | The column becomes |
|---|---|
| `email` | `<12 hex chars>@example.test`, different for every address and the same on every pull |
| `name` | `User <6 hex chars>` |
| `hash` | 16 hex chars |
| `password` | the bcrypt hash of `password`, so you can log in as anyone with that password |
| `null` | NULL |
| `empty` | an empty string |
| `set:<value>` | that value, like `set:redacted` |

A NULL stays NULL under every rule. A rule for a table the server does not have is reported and skipped. If a rule fails, for a column that does not exist say, the pull fails and says so, since the data in lerd is then unmasked: fix the rule and pull again, or `lerd db:restore before-db-pull`. `lerd db-pull:pull --no-mask` skips masking for one pull from the terminal; an assistant cannot.

## Skip rows of big tables

Sessions, queued jobs, logs and Telescope entries are rarely worth copying:

```bash
lerd db-pull:skip sessions jobs failed_jobs telescope_entries
lerd db-pull:skip jobs --off
```

A skipped table arrives empty, with its structure, so the app keeps working.

## Where settings are kept

In lerd's data folder for this plugin, one file per site, readable by you alone. Removing the plugin keeps them. No password is saved: only the server's address and the app's folder.
