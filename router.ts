import type { Api, Model } from "@earendil-works/pi-ai";
import type { AutoModelConfig, ModelSelection, ModelTier, TierName } from "./config.ts";

export const ROUTE_ENTRY_TYPE = "auto-model-route";

interface SessionEntryLike {
	type?: string;
	customType?: string;
	message?: { role?: string };
}

interface ScopedModelLike {
	model: Model<Api>;
}

export function hasPriorPromptOrRoute(entries: readonly SessionEntryLike[]): boolean {
	return entries.some(
		(entry) =>
			(entry.type === "message" && entry.message?.role === "user") ||
			(entry.type === "custom" && entry.customType === ROUTE_ENTRY_TYPE),
	);
}

export function getTier(config: AutoModelConfig, name: TierName): ModelTier | undefined {
	return config.tiers.find((tier) => tier.name === name);
}

export function getFallbackTier(config: AutoModelConfig): ModelTier {
	return config.tiers[0];
}

export function selectableModels(
	available: readonly Model<Api>[],
	scoped: readonly ScopedModelLike[],
): Model<Api>[] {
	if (scoped.length === 0) return [...available];
	const availableKeys = new Set(available.map(modelKey));
	return scoped.map((item) => item.model).filter((model) => availableKeys.has(modelKey(model)));
}

export function resolveConfiguredModel(
	selection: ModelSelection,
	available: readonly Model<Api>[],
): Model<Api> | undefined {
	return available.find(
		(model) => model.provider === selection.provider && model.id === selection.model,
	);
}

export function resolveTierModel(
	tier: ModelTier,
	available: readonly Model<Api>[],
	scoped: readonly ScopedModelLike[],
): Model<Api> | undefined {
	return resolveConfiguredModel(tier, selectableModels(available, scoped));
}

export function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}
