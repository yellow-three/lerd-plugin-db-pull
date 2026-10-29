// `--key value` and bare `--flag` options, everything else positional.
function parseArgs(argv, booleans = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const [key, inline] = a.slice(2).split(/=(.*)/s);
    if (booleans.includes(key)) out[key] = true;
    else if (inline !== undefined) out[key] = inline;
    else if (i + 1 < argv.length) out[key] = argv[++i];
    else throw new Error(`--${key} needs a value`);
  }
  return out;
}

// MCP tools and API endpoints get their input as JSON on stdin, the CLI on argv.
function jsonInput() {
  if (!['mcp', 'api'].includes(process.env.LERD_SURFACE)) return null;
  if (process.env.LERD_SURFACE === 'api' && process.env.LERD_METHOD === 'GET') return {};
  const raw = require('node:fs').readFileSync(0, 'utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

// Runs main and turns a thrown error into a message and a failing exit.
function run(main) {
  main().catch((e) => {
    if (!e.shown) console.error(e.message);
    process.exit(1);
  });
}

module.exports = { parseArgs, jsonInput, run };
