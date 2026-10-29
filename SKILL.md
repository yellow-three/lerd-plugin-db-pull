---
name: lerd-db-pull
description: Pull a lerd site's database from its staging or production server over SSH, with personal data masked. Use when the user wants real or fresh data from a server in their local site.
---

Call `db-pull_remotes` with the site first: it lists the servers saved for it, which one is the default, the columns masked on every pull and the tables pulled without rows.

`db-pull_pull` with the site, and `remote` when it should not be the default, replaces the site's lerd database with the server's. Say so before running it, and name the server. It snapshots the lerd database first as `before-db-pull`, which `db` `restore` brings back, and masks the columns the user set up. It answers with the database, the service and the columns it masked.

When no server is saved, or a pull fails because ssh could not connect, ask the user to run `lerd db-pull:add <name> <user@host> <app path>` and `lerd db-pull:test` in the project themselves; never guess a host or a key. When nothing is masked and the server is a production one, point out `lerd db-pull:mask` before pulling, for example `lerd db-pull:mask users.email email`, rather than adding rules on the user's behalf.
