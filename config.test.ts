import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, saveConfig, validateConfig, type AutoModelConfig } from "./config.ts";

const validConfig: AutoModelConfig = {
	version: 1,
	enabled: true,
	classifier: { provider: "opencode", model: "free-fast", thinkingLevel: "low" },
	tiers: [
		{ name: "simple", provider: "openai-codex", model: "gpt-5.6-luna", thinkingLevel: "high" },
		{ name: "complex", provider: "openai-codex", model: "gpt-5.6-sol", thinkingLevel: "medium" },
	],
};

test("validates a two-tier configuration", () => {
	assert.deepEqual(validateConfig(validConfig), validConfig);
});

test("requires the canonical tier order", () => {
	assert.throws(
		() => validateConfig({ ...validConfig, tiers: [...validConfig.tiers].reverse() }),
		/tier 1 must be named simple/,
	);
});

test("ignores removed legacy routing settings", () => {
	assert.deepEqual(
		validateConfig({ ...validConfig, fallbackTier: "complex", sensitivity: "aggressive" }),
		validConfig,
	);
});

test("migrates legacy configuration to use the simple tier as classifier", () => {
	const { classifier: _classifier, ...legacy } = validConfig;
	assert.deepEqual(validateConfig(legacy).classifier, {
		provider: "openai-codex",
		model: "gpt-5.6-luna",
		thinkingLevel: "high",
	});
});

test("saves and reloads configuration atomically", async () => {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-auto-model-"));
	const configPath = path.join(directory, "nested", "auto-model.json");
	try {
		await saveConfig(configPath, validConfig);
		assert.deepEqual(await loadConfig(configPath), { config: validConfig });
		assert.deepEqual(
			(await fs.promises.readdir(path.dirname(configPath))).sort(),
			["auto-model.json"],
		);
	} finally {
		await fs.promises.rm(directory, { recursive: true, force: true });
	}
});

test("reports malformed JSON without throwing", async () => {
	const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-auto-model-"));
	const configPath = path.join(directory, "auto-model.json");
	try {
		await fs.promises.writeFile(configPath, "{", "utf8");
		const result = await loadConfig(configPath);
		assert.equal(result.config, undefined);
		assert.match(result.warning ?? "", /Could not load/);
	} finally {
		await fs.promises.rm(directory, { recursive: true, force: true });
	}
});
