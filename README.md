# db-pull for Lerd

> Pull a site's database from your staging or production server into
> [Lerd](https://lerd.sh) over SSH, with personal data masked on the way in.

```bash
lerd plugin install https://github.com/yellow-three/lerd-plugin-db-pull
cd ~/code/shop
lerd db-pull:add staging forge@203.0.113.10 /home/forge/shop.com
lerd db-pull:mask users.email email
lerd db-pull:skip sessions telescope_entries
lerd db-pull:pull
```

The dump runs on the server and reads the database settings from the app's own `.env` there, so the server's database password never leaves it and Lerd never asks for one. Before replacing anything, the site's Lerd database is snapshotted as `before-db-pull`, so `lerd db:restore before-db-pull` undoes a pull. A dump that fails halfway is thrown away, and a masking rule that fails fails the pull, so unmasked data is never left behind silently.

It works from the terminal, from the site's **Commands** menu and **DB Pull** tab in the dashboard, and for AI assistants through Lerd's MCP server as `db-pull_remotes` and `db-pull_pull`. MySQL, MariaDB and PostgreSQL are supported.

The full instructions are in [DOCS.md](DOCS.md), which Lerd also shows on the plugin's **Documentation** tab.

## Requirements

- Lerd 1.38 or newer, on Linux or macOS (Windows through WSL)
- Node.js and `ssh` on your machine
- On the server: SSH access with a key, `mysqldump`/`mariadb-dump` or `pg_dump`, and `gzip`

## Development

```bash
npm test
lerd plugin install .
```

Everything it runs is plain Node.js and a POSIX shell script sent to the server, with no dependencies.

## License

MIT
