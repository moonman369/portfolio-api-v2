"use strict";

/**
 * Bring the live collection's `$jsonSchema` enums into line with `documents/taxonomy.js`.
 *
 * **Why this exists.** The vocabularies live in two places: the JS file the application
 * validates against, and the `$jsonSchema` validator MongoDB enforces at write time. They
 * were maintained separately, so adding a value to the JS file made the app accept a
 * document the database then rejected with `code: 121, Document failed validation` —
 * which names no field and points at nothing. taxonomy.js is now the source of truth and
 * this script is how the collection learns about a change.
 *
 * **What it touches.** Only the four enum arrays: `category`, `metadata.domain`,
 * `metadata.subcategory` and `metadata.proficiency_level`. Everything else in the
 * validator — bson types, `required`, `additionalProperties`, the embedding and timestamp
 * rules — is read from the live schema and written back untouched. Those are not
 * taxonomy's to own, and regenerating them from scratch would risk silently relaxing a
 * constraint nobody meant to relax.
 *
 * **Widening only, in practice.** Adding a value can never invalidate a stored document.
 * REMOVING one can: this script reports removals loudly, and `--check` treats any drift
 * as a failure, but it will still apply a removal if you ask it to. Check what is in the
 * collection first.
 *
 * Usage:
 *   node --env-file=.env scripts/sync-document-validator.js            # show the diff
 *   node --env-file=.env scripts/sync-document-validator.js --apply    # write it
 *   node --env-file=.env scripts/sync-document-validator.js --check    # exit 1 on drift
 *
 * The previous validator is printed in full before anything is written. That output is
 * the rollback artifact — keep it if you are changing something you might want back.
 */

const { getConfig } = require("../src/config");
const { connect, close } = require("../src/db");
const {
  ALLOWED_CATEGORIES,
  ALLOWED_DOMAINS,
  ALLOWED_SUBCATEGORIES,
  ALLOWED_PROFICIENCY_LEVELS,
} = require("../src/documents/taxonomy");

function parseArgs(argv) {
  const args = { apply: false, check: false };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg === "--check") args.check = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.apply && args.check) {
    throw new Error("--apply and --check are mutually exclusive");
  }
  return args;
}

/**
 * Where each vocabulary lives inside the schema, and what it should hold.
 *
 * `preserveNull` matters for `proficiency_level`: the live enum carries a literal `null`
 * member alongside the four levels, which is how an unset level is expressed. Dropping it
 * while "syncing" would reject every document that has no proficiency.
 */
const BINDINGS = Object.freeze([
  {
    label: "category",
    values: ALLOWED_CATEGORIES,
    read: (schema) => schema.properties.category,
  },
  {
    label: "metadata.domain",
    values: ALLOWED_DOMAINS,
    read: (schema) => schema.properties.metadata.properties.domain,
  },
  {
    label: "metadata.subcategory",
    values: ALLOWED_SUBCATEGORIES,
    read: (schema) => schema.properties.metadata.properties.subcategory.items,
  },
  {
    label: "metadata.proficiency_level",
    values: ALLOWED_PROFICIENCY_LEVELS,
    read: (schema) => schema.properties.metadata.properties.proficiency_level,
    preserveNull: true,
  },
]);

function diffOne(binding, schema) {
  const target = binding.read(schema);
  const live = target?.enum ?? [];
  const liveValues = live.filter((value) => value !== null);
  const hadNull = live.includes(null);

  return {
    label: binding.label,
    target,
    hadNull,
    added: binding.values.filter((value) => !liveValues.includes(value)),
    removed: liveValues.filter((value) => !binding.values.includes(value)),
    next: binding.preserveNull && hadNull ? [...binding.values, null] : [...binding.values],
    liveCount: liveValues.length,
    appCount: binding.values.length,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { mongo } = getConfig();
  const db = await connect();

  const [info] = await db.listCollections({ name: mongo.vectorCollection }).toArray();
  if (!info) {
    throw new Error(`Collection ${mongo.vectorCollection} does not exist`);
  }

  const validator = info.options?.validator;
  const schema = validator?.$jsonSchema;
  if (!schema) {
    // Worth failing on rather than creating one: a collection with no validator is a
    // different situation than a stale one, and adding a strict schema to live data is a
    // decision, not a sync.
    throw new Error(
      `${mongo.vectorCollection} has no $jsonSchema validator. This script updates an ` +
        "existing one; creating the first is a deliberate migration.",
    );
  }

  process.stdout.write(
    `collection: ${mongo.vectorCollection}  |  validationLevel: ${info.options.validationLevel ?? "strict"}` +
      `  |  action: ${info.options.validationAction ?? "error"}\n\n`,
  );

  const diffs = BINDINGS.map((binding) => diffOne(binding, schema));
  let drifted = 0;

  diffs.forEach((diff) => {
    const inSync = diff.added.length === 0 && diff.removed.length === 0;
    if (!inSync) drifted += 1;

    process.stdout.write(
      `${inSync ? "in sync " : "DRIFT   "} ${diff.label.padEnd(28)} db=${String(diff.liveCount).padStart(3)} app=${String(diff.appCount).padStart(3)}\n`,
    );
    if (diff.added.length) {
      process.stdout.write(`           + ${diff.added.join(", ")}\n`);
    }
    if (diff.removed.length) {
      process.stdout.write(`           - ${diff.removed.join(", ")}   <-- REMOVAL, check stored documents first\n`);
    }
  });

  if (drifted === 0) {
    process.stdout.write("\nNothing to do.\n");
    await close();
    process.exit(0);
  }

  if (args.check) {
    process.stdout.write(
      `\n${drifted} vocabulary/ies differ. Run with --apply to bring the collection in line.\n`,
    );
    await close();
    process.exit(1);
  }

  if (!args.apply) {
    process.stdout.write("\nDry run. Re-run with --apply to write these changes.\n");
    await close();
    process.exit(0);
  }

  process.stdout.write("\n--- previous validator, keep this to roll back ---\n");
  process.stdout.write(`${JSON.stringify(validator, null, 2)}\n`);
  process.stdout.write("--- end previous validator ---\n\n");

  // Mutates the object read from the live schema, so every untouched rule survives
  // exactly as it was.
  diffs.forEach((diff) => {
    diff.target.enum = diff.next;
  });

  await db.command({
    collMod: mongo.vectorCollection,
    validator,
    validationLevel: info.options.validationLevel ?? "strict",
    validationAction: info.options.validationAction ?? "error",
  });

  // Read back rather than trusting the write: collMod reports success on a no-op too.
  const [after] = await db.listCollections({ name: mongo.vectorCollection }).toArray();
  const remaining = BINDINGS.map((binding) => diffOne(binding, after.options.validator.$jsonSchema))
    .filter((diff) => diff.added.length || diff.removed.length);

  if (remaining.length) {
    throw new Error(`collMod reported success but ${remaining.map((d) => d.label).join(", ")} still differ`);
  }

  process.stdout.write("applied, and verified by reading the validator back. All vocabularies in sync.\n");
  await close();
  process.exit(0);
}

main().catch(async (error) => {
  console.error(`sync-document-validator failed: ${error.message}`);
  await close().catch(() => {});
  process.exit(1);
});
