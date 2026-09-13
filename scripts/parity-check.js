"use strict";

/**
 * Behaviour parity between the old Portfolio-Stats-API and this rebuild.
 *
 * Calls the same endpoint on both base URLs and deep-diffs the JSON, ignoring fields
 * that are volatile by nature (uptime, elapsed, LeetCode ranking). Ignored fields that
 * differ are reported as notes, not failures.
 *
 * Usage:
 *   node scripts/parity-check.js --old https://old.example --new https://new.example
 *   node scripts/parity-check.js --old ... --new ... --leetcode-user moonman369
 *   node scripts/parity-check.js --old ... --new ... --include-refresh
 *
 * `--include-refresh` mutates the stats document on BOTH services and burns GitHub
 * quota, so it is opt-in. It reads REFRESH_SECRET from the environment rather than a
 * flag, to keep the secret out of shell history and process listings.
 *
 * Exit code 0 when every checked endpoint matches, 1 otherwise.
 */

const DEFAULT_TIMEOUT_MS = 60_000;

// Volatile by design — differing here is expected, not a parity failure.
const IGNORED_PATHS = {
  "/health": ["uptime", "timestamp"],
  refresh: ["elapsed"],
  leetcode: ["ranking"],
};

function parseArgs(argv) {
  const args = { leetcodeUser: "moonman369", includeRefresh: false };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--old") args.old = argv[++i];
    else if (flag === "--new") args.new = argv[++i];
    else if (flag === "--leetcode-user") args.leetcodeUser = argv[++i];
    else if (flag === "--include-refresh") args.includeRefresh = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }

  if (!args.old || !args.new) {
    throw new Error("Both --old <baseUrl> and --new <baseUrl> are required");
  }
  return args;
}

function stripTrailingSlash(url) {
  return url.replace(/\/+$/, "");
}

async function fetchJson(baseUrl, path) {
  const url = `${stripTrailingSlash(baseUrl)}${path}`;
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  const text = await response.text();
  let body;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = { __unparseable: text.slice(0, 200) };
  }

  return { status: response.status, body };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function diff(left, right, path = "", found = []) {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      found.push({ path: path || "(root)", left: `array(${left.length})`, right: `array(${right.length})` });
      return found;
    }
    left.forEach((item, index) => diff(item, right[index], `${path}[${index}]`, found));
    return found;
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
      diff(left[key], right[key], path ? `${path}.${key}` : key, found);
    }
    return found;
  }

  if (left !== right) {
    found.push({ path: path || "(root)", left, right });
  }
  return found;
}

function splitByIgnored(differences, ignoredPaths) {
  const ignore = new Set(ignoredPaths ?? []);
  return {
    failures: differences.filter((d) => !ignore.has(d.path)),
    notes: differences.filter((d) => ignore.has(d.path)),
  };
}

function format(value) {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

async function compare({ name, path, oldBase, newBase, ignoredPaths }) {
  process.stdout.write(`\n${name}\n  ${path}\n`);

  const [oldResult, newResult] = await Promise.all([
    fetchJson(oldBase, path),
    fetchJson(newBase, path),
  ]);

  const differences = [];
  if (oldResult.status !== newResult.status) {
    differences.push({ path: "(http status)", left: oldResult.status, right: newResult.status });
  }
  differences.push(...diff(oldResult.body, newResult.body));

  const { failures, notes } = splitByIgnored(differences, ignoredPaths);

  notes.forEach((note) => {
    process.stdout.write(`  note  ${note.path}: ${format(note.left)} -> ${format(note.right)}\n`);
  });

  if (failures.length === 0) {
    process.stdout.write(`  PASS  no differences (status ${newResult.status})\n`);
    return true;
  }

  failures.forEach((failure) => {
    process.stdout.write(`  FAIL  ${failure.path}: old=${format(failure.left)} new=${format(failure.right)}\n`);
  });
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const checks = [
    { name: "health", path: "/health", ignoredPaths: IGNORED_PATHS["/health"] },
    { name: "github stats", path: "/api/v1/github", ignoredPaths: [] },
    {
      name: "leetcode stats",
      path: `/api/v1/leetcode/${encodeURIComponent(args.leetcodeUser)}`,
      ignoredPaths: IGNORED_PATHS.leetcode,
    },
  ];

  if (args.includeRefresh) {
    const secret = process.env.REFRESH_SECRET;
    if (!secret) {
      throw new Error("--include-refresh requires REFRESH_SECRET in the environment");
    }
    checks.push({
      name: "github refresh (mutating)",
      path: `/api/v1/refresh?secret=${encodeURIComponent(secret)}`,
      ignoredPaths: IGNORED_PATHS.refresh,
    });
  } else {
    process.stdout.write("\n(skipping /refresh - pass --include-refresh to compare it)\n");
  }

  process.stdout.write(`old: ${stripTrailingSlash(args.old)}\nnew: ${stripTrailingSlash(args.new)}\n`);

  const results = [];
  for (const check of checks) {
    results.push(
      await compare({ ...check, oldBase: args.old, newBase: args.new }),
    );
  }

  const failed = results.filter((ok) => !ok).length;
  process.stdout.write(
    `\n${results.length - failed}/${results.length} endpoints match${failed ? ` - ${failed} FAILED` : ""}\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`parity-check failed: ${error.message}`);
  process.exit(1);
});
