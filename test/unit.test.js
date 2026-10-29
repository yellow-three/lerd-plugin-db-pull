const test = require('node:test');
const assert = require('node:assert');
const config = require('../lib/config');
const { maskSQL } = require('../lib/mask');
const { sshArgs } = require('../lib/remote');
const { mariadbToMysql } = require('../lib/pull');
const { parseArgs } = require('../lib/args');

const empty = () => ({ remotes: {}, default: '', mask: {}, skip: [] });

test('the first server saved becomes the default, --default moves it', () => {
  let cfg = config.addRemote(empty(), 'staging', { ssh: 'forge@1.2.3.4', path: '/home/forge/shop' });
  assert.equal(cfg.default, 'staging');
  assert.deepEqual(cfg.remotes.staging, { ssh: 'forge@1.2.3.4', port: 22, path: '/home/forge/shop', env: '.env' });
  cfg = config.addRemote(cfg, 'prod', { ssh: 'prod-box', path: '~/shop', port: '2222' });
  assert.equal(cfg.default, 'staging');
  cfg = config.addRemote(cfg, 'prod', { ssh: 'prod-box', path: '~/shop', default: true });
  assert.equal(cfg.default, 'prod');
  cfg = config.removeRemote(cfg, 'prod');
  assert.equal(cfg.default, 'staging');
});

test('addRemote refuses what would become an ssh option or a bad path', () => {
  const add = (r) => () => config.addRemote(empty(), 'staging', { path: '/srv/app', ...r });
  assert.throws(add({ ssh: '-oProxyCommand=sh' }), /ssh destination/);
  assert.throws(add({ ssh: 'a b' }), /ssh destination/);
  assert.throws(add({ ssh: 'h', path: 'relative/app' }), /absolute path/);
  assert.throws(add({ ssh: 'h', port: '70000' }), /not a port/);
  assert.throws(add({ ssh: 'h', database: "x'; drop" }), /database name/);
  assert.throws(() => config.addRemote(empty(), 'Staging!', { ssh: 'h', path: '/a' }), /server name/);
});

test('pickRemote takes the named server, else the default', () => {
  const cfg = config.addRemote(config.addRemote(empty(), 'staging', { ssh: 'a', path: '/a' }), 'prod', { ssh: 'b', path: '/b' });
  assert.equal(config.pickRemote(cfg).name, 'staging');
  assert.equal(config.pickRemote(cfg, 'prod').ssh, 'b');
  assert.throws(() => config.pickRemote(cfg, 'qa'), /saved: staging, prod/);
  assert.throws(() => config.pickRemote(empty()), /No server is saved/);
});

test('setMask checks the column and the rule', () => {
  const cfg = config.setMask(empty(), 'users.email', 'email');
  assert.deepEqual(cfg.mask, { 'users.email': 'email' });
  config.setMask(cfg, 'users.note', 'set:hidden');
  config.setMask(cfg, 'users.email', null);
  assert.deepEqual(cfg.mask, { 'users.note': 'set:hidden' });
  assert.throws(() => config.setMask(empty(), 'users', 'email'), /table.column/);
  assert.throws(() => config.setMask(empty(), 'users.e`mail', 'email'), /table.column/);
  assert.throws(() => config.setMask(empty(), 'users.email', 'scramble'), /not a rule/);
});

test('setSkip adds and removes table names', () => {
  const cfg = config.setSkip(empty(), ['sessions', 'jobs'], true);
  assert.deepEqual(cfg.skip, ['jobs', 'sessions']);
  assert.deepEqual(config.setSkip(cfg, ['jobs'], false).skip, ['sessions']);
  assert.throws(() => config.setSkip(empty(), ['a;b'], true), /table name/);
});

test('maskSQL writes one UPDATE per table that keeps NULLs', () => {
  const rules = { 'users.email': 'email', 'users.password': 'password', 'users.phone': 'null', 'orders.note': "set:it's" };
  assert.equal(
    maskSQL('mysql', rules),
    "UPDATE `users` SET `email` = CASE WHEN `email` IS NULL THEN NULL ELSE CONCAT(LEFT(MD5(`email`), 12), '@example.test') END, " +
      "`password` = CASE WHEN `password` IS NULL THEN NULL ELSE '$2y$12$iJmc9auoAJvrYGEy90/9LOtrlFukdZZ7cbDYu7pVBstd6IppKBn.G' END, `phone` = NULL;\n" +
      "UPDATE `orders` SET `note` = CASE WHEN `note` IS NULL THEN NULL ELSE 'it''s' END;",
  );
  assert.equal(
    maskSQL('postgres', { 'users.name': 'name' }),
    `UPDATE "users" SET "name" = CASE WHEN "name" IS NULL THEN NULL ELSE 'User ' || left(md5("name"::text), 6) END;`,
  );
  assert.equal(maskSQL('mysql', { 'x.y': 'set:a\\b' }), "UPDATE `x` SET `y` = CASE WHEN `y` IS NULL THEN NULL ELSE 'a\\\\b' END;");
});

test('maskSQL leaves out tables the dump does not have', () => {
  assert.equal(maskSQL('postgres', { 'users.email': 'email', 'gone.x': 'null' }, ['users']).includes('gone'), false);
});

test('sshArgs never asks for a password and ends options before the host', () => {
  assert.deepEqual(sshArgs({ ssh: 'forge@h', port: 2222 }), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-p', '2222', '--', 'forge@h', 'sh -s']);
  assert.ok(sshArgs({ ssh: 'h', identity: '/k' }).includes('IdentitiesOnly=yes'));
});

test('mariadbToMysql swaps MariaDB collations for MySQL ones', () => {
  assert.equal(mariadbToMysql('COLLATE=utf8mb4_uca1400_ai_ci;'), 'COLLATE=utf8mb4_0900_ai_ci;');
  assert.equal(mariadbToMysql("SET sql_mode = 'STRICT_TRANS_TABLES,NO_AUTO_CREATE_USER'"), "SET sql_mode = 'STRICT_TRANS_TABLES'");
});

test('parseArgs reads values and flags', () => {
  assert.deepEqual(parseArgs(['staging', '--no-mask', '--site=shop'], ['no-mask']), { _: ['staging'], 'no-mask': true, site: 'shop' });
});
