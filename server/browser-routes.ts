import express from "express";
import { clearBrowserSettingsCache, getBrowserSettings } from "./runtime-config.js";
import {
  closeLocalBrowser,
  getBrowserStatus,
  installPatchrightChrome,
  launchLocalBrowser,
} from "./browser/launcher.js";

function readUrl(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function browserErrorStatus(err: unknown): number {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("Local browser use is disabled") ? 409 : 500;
}

export function createBrowserRouter(): express.Router {
  const router = express.Router();

  router.get("/status", async (_req, res) => {
    try {
      res.json(await getBrowserStatus());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/launch", async (req, res) => {
    clearBrowserSettingsCache();
    try {
      const result = await launchLocalBrowser({
        url: readUrl(req.body?.url),
        forceVisible: req.body?.forceVisible === true,
        relaunch: req.body?.relaunch === true,
      });
      res.json(result);
    } catch (err) {
      res.status(browserErrorStatus(err)).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.post("/login", async (req, res) => {
    clearBrowserSettingsCache();
    try {
      const settings = await getBrowserSettings();
      if (!settings.enabled) {
        res.status(409).json({
          ok: false,
          error: "Local browser use is off. Turn it on in Settings first.",
        });
        return;
      }
      if (!settings.loginHandoffEnabled) {
        res.status(409).json({
          ok: false,
          error: "Login handoff is off. Turn on \"Spawn an instance to log in\" first.",
        });
        return;
      }
      const result = await launchLocalBrowser({
        url: readUrl(req.body?.url),
        forceVisible: true,
        relaunch: req.body?.relaunch === true,
      });
      res.json({
        ...result,
        message: "I need you to log in first. I’ve spawned an instance on your machine.",
      });
    } catch (err) {
      res.status(browserErrorStatus(err)).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  router.post("/close", async (_req, res) => {
    try {
      await closeLocalBrowser();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/install", async (_req, res) => {
    try {
      const result = await installPatchrightChrome();
      res.json(result);
    } catch (err) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
