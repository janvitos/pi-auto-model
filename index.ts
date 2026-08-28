import type { Api, Model } from "@earendil-works/pi-ai";
import { BorderedLoader, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyPrompt } from "./classifier.ts";
import { getConfigPath, loadConfig, type AutoModelConfig, type TierName } from "./config.ts";
import {
	getFallbackTier,
	getTier,
	hasPriorPromptOrRoute,
	resolveConfiguredModel,
	resolveTierModel,
	ROUTE_ENTRY_TYPE,
} from "./router.ts";
import { handleAutoModelCommand } from "./ui.ts";

export default function autoModel(pi: ExtensionAPI): void {
	const configPath = getConfigPath(getAgentDir());
	let config: AutoModelConfig | undefined;
	let routed = false;
	let routing = false;

	pi.registerCommand("automodel", {
		description: "Configure automatic first-prompt model routing",
		handler: async (args, ctx) => {
			try {
				config = await handleAutoModelCommand(args, ctx, configPath, config);
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Auto model configuration failed: ${message}`, "error");
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const loaded = await loadConfig(configPath);
		config = loaded.config;
		routed = hasPriorPromptOrRoute(ctx.sessionManager.getBranch());
		routing = false;
		if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
		ctx.ui.setStatus(
			"automodel",
			config?.enabled ? ctx.ui.theme.fg("dim", "auto:model") : undefined,
		);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!config?.enabled || routed || routing) return;
		if (hasPriorPromptOrRoute(ctx.sessionManager.getBranch())) {
			routed = true;
			return;
		}
		routing = true;
		routed = true;

		let selectedName: TierName = config.tiers[0].name;
		let classificationError: string | undefined;
		try {
			const classifierConfig = config.classifier;
			const classifierModel = resolveConfiguredModel(
				classifierConfig,
				ctx.modelRegistry.getAvailable(),
			);
			if (!classifierModel) {
				throw new Error(`Classifier model ${classifierConfig.provider}/${classifierConfig.model} is unavailable`);
			}
			const classify = (signal: AbortSignal | undefined) => classifyPrompt(
				(model, context, options) =>
					ctx.modelRegistry.complete(model as Model<Api>, context, options),
				{
					model: classifierModel,
					prompt: event.prompt,
					imageCount: event.images?.length ?? 0,
					config,
					thinkingLevel: classifierConfig.thinkingLevel,
					signal,
				},
			);

			if (ctx.mode === "tui") {
				const outcome = await ctx.ui.custom<{ tier?: TierName; error?: string }>(
					(tui, theme, _keybindings, done) => {
						const loader = new BorderedLoader(tui, theme, "Classifying...");
						loader.onAbort = () => done({ error: "Classification cancelled" });
						const signal = ctx.signal
							? AbortSignal.any([ctx.signal, loader.signal])
							: loader.signal;
						void classify(signal).then(
							(tier) => done({ tier }),
							(error: unknown) => done({
								error: error instanceof Error ? error.message : String(error),
							}),
						);
						return loader;
					},
				);
				if (!outcome?.tier) throw new Error(outcome?.error ?? "Classification cancelled");
				selectedName = outcome.tier;
			} else {
				selectedName = await classify(ctx.signal);
			}
		} catch (error: unknown) {
			classificationError = error instanceof Error ? error.message : String(error);
			selectedName = getFallbackTier(config).name;
		}

		const selectedTier = getTier(config, selectedName) ?? getFallbackTier(config);
		const targetModel = resolveTierModel(
			selectedTier,
			ctx.modelRegistry.getAvailable(),
			ctx.scopedModels,
		);
		let switched = false;
		if (targetModel) {
			switched = await pi.setModel(targetModel);
			if (switched) pi.setThinkingLevel(selectedTier.thinkingLevel);
		}

		pi.appendEntry(ROUTE_ENTRY_TYPE, {
			tier: selectedTier.name,
			provider: selectedTier.provider,
			model: selectedTier.model,
			thinkingLevel: selectedTier.thinkingLevel,
			classificationError,
			switched,
		});

		if (classificationError) {
			ctx.ui.notify(`Auto model classifier failed; using ${selectedTier.name}: ${classificationError}`, "warning");
		}
		if (!targetModel) {
			ctx.ui.notify(
				`Auto model target ${selectedTier.provider}/${selectedTier.model} is unavailable or outside the current model scope`,
				"warning",
			);
		} else if (!switched) {
			ctx.ui.notify(`Auto model could not authenticate ${selectedTier.provider}/${selectedTier.model}`, "warning");
		} else {
			ctx.ui.notify(
				`Auto model: ${selectedTier.name} → ${selectedTier.provider}/${selectedTier.model} (${selectedTier.thinkingLevel})`,
				"info",
			);
			ctx.ui.setStatus(
				"automodel",
				ctx.ui.theme.fg("dim", `auto:${selectedTier.name}`),
			);
		}
		routing = false;
	});
}
