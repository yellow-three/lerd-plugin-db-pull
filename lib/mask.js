// Turns a site's masking rules into the UPDATE statements run on the pulled
// database. The md5-based rules keep values distinct, so unique indexes hold,
// and keep the same input giving the same output across pulls.
const BCRYPT_PASSWORD = '$2y$12$iJmc9auoAJvrYGEy90/9LOtrlFukdZZ7cbDYu7pVBstd6IppKBn.G';

const DIALECTS = {
  mysql: {
    id: (s) => '`' + s + '`',
    str: (s) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'",
    md5: (c, n) => `LEFT(MD5(${c}), ${n})`,
    cat: (...p) => `CONCAT(${p.join(', ')})`,
  },
  postgres: {
    id: (s) => '"' + s + '"',
    str: (s) => "'" + s.replace(/'/g, "''") + "'",
    md5: (c, n) => `left(md5(${c}::text), ${n})`,
    cat: (...p) => p.join(' || '),
  },
};

function expression(d, col, rule) {
  switch (rule) {
    case 'email': return d.cat(d.md5(col, 12), d.str('@example.test'));
    case 'name': return d.cat(d.str('User '), d.md5(col, 6));
    case 'hash': return d.md5(col, 16);
    case 'null': return 'NULL';
    case 'empty': return d.str('');
    case 'password': return d.str(BCRYPT_PASSWORD);
  }
  if (rule.startsWith('set:')) return d.str(rule.slice(4));
  throw new Error(`Unknown masking rule ${rule}`);
}

// Columns of one table go in one UPDATE, so a row is rewritten once.
function maskSQL(engine, rules, tables) {
  const d = DIALECTS[engine];
  if (!d) throw new Error(`Cannot mask a ${engine} database`);
  const byTable = {};
  for (const [column, rule] of Object.entries(rules)) {
    const [table, col] = column.split('.');
    if (tables && !tables.includes(table)) continue;
    (byTable[table] ||= []).push([col, rule]);
  }
  return Object.entries(byTable).map(([table, cols]) => {
    // NULL stays NULL, so a masked column never gains values it did not have.
    const sets = cols.map(([c, r]) => {
      const col = d.id(c);
      const expr = expression(d, col, r);
      return r === 'null' ? `${col} = NULL` : `${col} = CASE WHEN ${col} IS NULL THEN NULL ELSE ${expr} END`;
    });
    return `UPDATE ${d.id(table)} SET ${sets.join(', ')};`;
  }).join('\n');
}

module.exports = { maskSQL, BCRYPT_PASSWORD };
