"use strict";

// Stats routes: validate -> call -> respond. No business logic lives here.
// Response shapes match the old service exactly (see docs/OLD_REPO_MAP.md §2.2-2.4).

const express = require("express");
const { z } = require("zod");
const { readGithubStats, refreshGithubStats } = require("../stats/github");
const { getLeetcodeStats } = require("../stats/leetcode");
const { requireRefreshSecret, createRefreshLimiter } = require("./auth");

// GitHub's own limit is 39 characters; LeetCode handles are alphanumeric plus _ and -.
const usernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9_-]+$/, "username may only contain letters, digits, '_' and '-'");

function createStatsRouter() {
  const router = express.Router();
  const refreshLimiter = createRefreshLimiter();

  // Returns the cached stats document, or null when a refresh has never run.
  router.get("/github", async (req, res) => {
    res.status(200).json(await readGithubStats());
  });

  router.get("/leetcode/:username", async (req, res) => {
    const parsed = usernameSchema.safeParse(req.params.username);
    if (!parsed.success) {
      return res.status(400).json({
        status: "error",
        message: parsed.error.issues[0].message,
        code: "INVALID_USERNAME",
      });
    }

    return res.status(200).json(await getLeetcodeStats(parsed.data));
  });

  // Rate limit before the secret check so guessing attempts are bounded too.
  router.get("/refresh", refreshLimiter, requireRefreshSecret, async (req, res) => {
    const startedAt = Date.now();

    try {
      const totals = await refreshGithubStats();
      return res.status(200).json({
        status: "success",
        message: "Refresh success",
        elapsed: Date.now() - startedAt,
        ...totals,
      });
    } catch (error) {
      console.error("refresh.failed", { code: error?.code, message: error?.message });
      return res.status(500).json({
        status: "error",
        message: error?.message ?? "Refresh failed",
        elapsed: Date.now() - startedAt,
      });
    }
  });

  return router;
}

module.exports = { createStatsRouter };
