import assert from "node:assert/strict";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AutoModelConfig } from "./config.ts";
import {
	availableRecoveryTiers,
	getAdjacentTiers,
	getFallbackTier,
	hasPriorPromptOrRoute,
	resolveTierModel,
	ROUTE_ENTRY_TYPE,
	selectableModels,
} from "./router.ts";

function model(provider: string, id: string): Model<Api> {
	return { provider, id } as Model<Api>;
}

const config: AutoModelConfig = {
	version: 1,
	enabled: true,
	classifier: { provider: "test", model: "classifier", thinkingLevel: "low" },
	tiers: [
		{ name: "simple", provider: "test", model: "small", thinkingLevel: "high" },
		{ name: "complex", provider: "test", model: "large", thinkingLevel: "medium" },
	],
};

test("only empty branches are eligible for first-prompt routing", () => {
	assert.equal(hasPriorPromptOrRoute([]), false);
	assert.equal(
		hasPriorPromptOrRoute([{ type: "message", message: { role: "assistant" } }]),
		false,
	);
	assert.equal(hasPriorPromptOrRoute([{ type: "message", message: { role: "user" } }]), true);
	assert.equal(hasPriorPromptOrRoute([{ type: "custom", customType: ROUTE_ENTRY_TYPE }]), true);
});

test("uses all available models without a scope", () => {
	const available = [model("test", "small"), model("test", "large")];
	assert.deepEqual(selectableModels(available, []), available);
});

test("honors scoped models and filters unavailable scoped entries", () => {
	const small = model("test", "small");
	const unavailable = model("test", "missing");
	assert.deepEqual(selectableModels([small], [{ model: small }, { model: unavailable }]), [small]);
	assert.equal(resolveTierModel(config.tiers[1], [small], [{ model: small }]), undefined);
});

test("resolves an available target and defaults fallback to simple", () => {
	const large = model("test", "large");
	assert.equal(resolveTierModel(config.tiers[1], [large], []), large);
	assert.equal(getFallbackTier(config).name, "simple");
});

test("offers only immediate lower and higher tiers around standard", () => {
	const threeTierConfig: AutoModelConfig = {
		...config,
		tiers: [
			config.tiers[0],
			{ name: "standard", provider: "test", model: "middle", thinkingLevel: "medium" },
			config.tiers[1],
		],
	};
	assert.deepEqual(
		getAdjacentTiers(threeTierConfig, "standard").map(({ direction, tier }) => [direction, tier.name]),
		[["lower", "simple"], ["higher", "complex"]],
	);
});

test("recovery candidates exclude unavailable, scoped-out, and failed models", () => {
	const threeTierConfig: AutoModelConfig = {
		...config,
		tiers: [
			config.tiers[0],
			{ name: "standard", provider: "test", model: "middle", thinkingLevel: "medium" },
			config.tiers[1],
		],
	};
	const small = model("test", "small");
	const large = model("test", "large");
	assert.deepEqual(
		availableRecoveryTiers(
			threeTierConfig,
			[small, large],
			[{ model: small }, { model: large }],
			new Set(["test/large"]),
			"standard",
		).map(({ direction, tier }) => [direction, tier.name]),
		[["lower", "simple"]],
	);
});
