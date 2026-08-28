import type { Api, Model } from "@earendil-works/pi-ai";
import { BorderedLoader, getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifyPrompt } from "./classifier.ts";
import { getConfigPath, loadConfig, type AutoModelConfig, type ModelTier, type TierName } from "./config.ts";
import {
	availableRecoveryTiers,
	hasPriorPromptOrRoute,
	modelKey,
	selectionKey,
	resolveConfiguredModel,
	resolveTierModel,
	ROUTE_ENTRY_TYPE,
} from "./router.ts";
import { handleAutoModelCommand } from "./ui.ts";

const STOP_OPTION = "Stop execution";
const STOP_ACKNOWLEDGEMENT = "Auto-model routing failed. The original task was not executed.";
const STOP_SYSTEM_PROMPT = `A model-routing extension stopped this turn before task execution.
Do not perform, discuss, summarize, or infer the original user task. Do not call tools.
Reply with exactly: ${STOP_ACKNOWLEDGEMENT}`;
const MAX_ERROR_LENGTH = 500;

type RouteResolution = "classified" | "lower" | "higher" | "manual" | "current" | "stopped";

interface BlockedTurn {
	activeTools: string[];
}

interface TierAttempt {
	model?: Model<Api>;
	error?: string;
}

function conciseError(value: unknown): string {
	const message = value instanceof Error ? value.message : String(value);
	return message.length <= MAX_ERROR_LENGTH ? message : `${message.slice(0, MAX_ERROR_LENGTH)}…`;
}

export default function autoModel(pi: ExtensionAPI): void {
	const configPath = getConfigPath(getAgentDir());
	let config: AutoModelConfig | undefined;
	let routed = false;
	let routing = false;
	let blockedTurn: BlockedTurn | undefined;

	const restoreBlockedTools = () => {
		if (!blockedTurn) return;
		pi.setActiveTools(blockedTurn.activeTools);
		blockedTurn = undefined;
	};

	pi.registerCommand("automodel", {
		description: "Configure automatic first-prompt model routing",
		handler: async (args, ctx) => {
			try {
				config = await handleAutoModelCommand(args, ctx, configPath, config);
			} catch (error: unknown) {
				ctx.ui.notify(`Auto model configuration failed: ${conciseError(error)}`, "error");
			}
		},
	});

	pi.on("session_start", async (event, ctx) => {
		restoreBlockedTools();
		const loaded = await loadConfig(configPath);
		config = loaded.config;
		routed = hasPriorPromptOrRoute(ctx.sessionManager.getBranch());
		routing = false;
		if (loaded.warning) ctx.ui.notify(loaded.warning, "warning");
		if (!config && (event.reason === "startup" || event.reason === "reload")) {
			ctx.ui.notify(
				"pi-auto-model is not configured. Run /automodel setup to choose tier and classifier models.",
				"info",
			);
		}
		ctx.ui.setStatus(
			"automodel",
			config?.enabled ? ctx.ui.theme.fg("dim", "auto:model") : undefined,
		);
	});

	pi.on("context", (event) => {
		if (!blockedTurn) return;
		return {
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Acknowledge that auto-model stopped this turn." }],
					timestamp: Date.now(),
				},
			],
		};
	});

	pi.on("tool_call", () => {
		if (!blockedTurn) return;
		return {
			block: true,
			terminate: true,
			reason: "Auto-model stopped this turn because routing failed.",
		};
	});

	pi.on("agent_settled", () => restoreBlockedTools());
	pi.on("session_shutdown", () => restoreBlockedTools());

	pi.on("before_agent_start", async (event, ctx) => {
		if (!config?.enabled || routed || routing) return;
		if (hasPriorPromptOrRoute(ctx.sessionManager.getBranch())) {
			routed = true;
			return;
		}
		routing = true;
		routed = true;

		const activeConfig = config;
		const originalModel = ctx.model;
		const originalThinkingLevel = ctx.thinkingLevel;
		const available = ctx.modelRegistry.getAvailable();
		const failedModelKeys = new Set<string>();
		let classifiedTier: TierName | undefined;
		let classificationError: string | undefined;
		let activationError: string | undefined;

		const attemptTier = async (tier: ModelTier): Promise<TierAttempt> => {
			const target = resolveTierModel(tier, available, ctx.scopedModels);
			if (!target) {
				failedModelKeys.add(selectionKey(tier));
				return { error: `${tier.name} model ${selectionKey(tier)} is unavailable or outside the current model scope` };
			}
			try {
				const switched = await pi.setModel(target);
				if (!switched) {
					failedModelKeys.add(modelKey(target));
					return { error: `Pi could not authenticate ${modelKey(target)}` };
				}
				pi.setThinkingLevel(tier.thinkingLevel);
				return { model: target };
			} catch (error: unknown) {
				failedModelKeys.add(modelKey(target));
				return { error: `Could not activate ${modelKey(target)}: ${conciseError(error)}` };
			}
		};

		const classify = (signal: AbortSignal | undefined) => classifyPrompt(
			(model, context, options) => ctx.modelRegistry.complete(model as Model<Api>, context, options),
			{
				model: resolveConfiguredModel(activeConfig.classifier, available) as Model<Api>,
				prompt: event.prompt,
				imageCount: event.images?.length ?? 0,
				config: activeConfig,
				thinkingLevel: activeConfig.classifier.thinkingLevel,
				signal,
			},
		);

		try {
			try {
				const classifierModel = resolveConfiguredModel(activeConfig.classifier, available);
				if (!classifierModel) {
					throw new Error(
						`Classifier model ${activeConfig.classifier.provider}/${activeConfig.classifier.model} is unavailable`,
					);
				}
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
								(error: unknown) => done({ error: conciseError(error) }),
							);
							return loader;
						},
					);
					if (!outcome?.tier) throw new Error(outcome?.error ?? "Classification cancelled");
					classifiedTier = outcome.tier;
				} else {
					classifiedTier = await classify(ctx.signal);
				}
			} catch (error: unknown) {
				classificationError = conciseError(error);
			}

			let actualTier: ModelTier | undefined;
			let actualModel: Model<Api> | undefined;
			let resolution: RouteResolution | undefined;

			if (classifiedTier) {
				const tier = activeConfig.tiers.find((candidate) => candidate.name === classifiedTier);
				if (tier) {
					const attempt = await attemptTier(tier);
					if (attempt.model) {
						actualTier = tier;
						actualModel = attempt.model;
						resolution = "classified";
					} else {
						activationError = attempt.error;
					}
				}
			}

			while (!actualModel && resolution !== "current" && resolution !== "stopped") {
				const candidates = availableRecoveryTiers(
					activeConfig,
					available,
					ctx.scopedModels,
					failedModelKeys,
					classifiedTier,
				);
				const options: string[] = [STOP_OPTION];
				const choices = new Map<string, { tier?: ModelTier; resolution: RouteResolution }>();
				const offeredModelKeys = new Set<string>();
				for (const candidate of candidates) {
					const key = selectionKey(candidate.tier);
					offeredModelKeys.add(key);
					const prefix = candidate.direction
						? `Use ${candidate.direction} tier`
						: `Use ${candidate.tier.name} tier`;
					const label = `${prefix}: ${key}`;
					options.push(label);
					choices.set(label, {
						tier: candidate.tier,
						resolution: candidate.direction ?? "manual",
					});
				}
				if (
					originalModel &&
					!failedModelKeys.has(modelKey(originalModel)) &&
					!offeredModelKeys.has(modelKey(originalModel))
				) {
					const label = `Use current Pi model: ${modelKey(originalModel)}`;
					options.push(label);
					choices.set(label, { resolution: "current" });
				}

				const reason = classificationError
					? `Classifier failed: ${classificationError}`
					: activationError ?? "The selected model could not be activated";
				ctx.ui.notify(reason, "warning");
				const selected = ctx.hasUI
					? await ctx.ui.select("Auto Model routing failed", options)
					: undefined;
				if (!selected || selected === STOP_OPTION) {
					resolution = "stopped";
					break;
				}
				const choice = choices.get(selected);
				if (!choice) {
					resolution = "stopped";
					break;
				}
				if (choice.resolution === "current") {
					if (originalModel) {
						try {
							const restored = await pi.setModel(originalModel);
							if (!restored) throw new Error("authentication failed");
							if (originalThinkingLevel) pi.setThinkingLevel(originalThinkingLevel);
							actualModel = originalModel;
							resolution = "current";
						} catch (error: unknown) {
							failedModelKeys.add(modelKey(originalModel));
							activationError = `Could not restore ${modelKey(originalModel)}: ${conciseError(error)}`;
						}
					}
					continue;
				}
				if (choice.tier) {
					const attempt = await attemptTier(choice.tier);
					if (attempt.model) {
						actualTier = choice.tier;
						actualModel = attempt.model;
						resolution = choice.resolution;
					} else {
						activationError = attempt.error;
					}
				}
			}

			if (resolution === "stopped" || !actualModel) {
				blockedTurn = { activeTools: pi.getActiveTools() };
				pi.setActiveTools([]);
				pi.appendEntry(ROUTE_ENTRY_TYPE, {
					classifiedTier,
					resolution: "stopped",
					classificationError,
					activationError,
					softStopped: true,
				});
				ctx.ui.notify(
					"Auto model stopped task execution. Pi will make only a short acknowledgement model call.",
					"warning",
				);
				ctx.ui.setStatus("automodel", ctx.ui.theme.fg("dim", "auto:model"));
				return { systemPrompt: STOP_SYSTEM_PROMPT };
			}

			pi.appendEntry(ROUTE_ENTRY_TYPE, {
				classifiedTier,
				actualTier: actualTier?.name,
				provider: actualModel.provider,
				model: actualModel.id,
				thinkingLevel: actualTier?.thinkingLevel ?? originalThinkingLevel,
				resolution,
				classificationError,
				activationError,
				softStopped: false,
			});

			if (actualTier) {
				ctx.ui.notify(
					`Auto model: ${actualTier.name} → ${modelKey(actualModel)} (${actualTier.thinkingLevel})${
						resolution === "classified" ? "" : ` via ${resolution}`
					}`,
					"info",
				);
				ctx.ui.setStatus("automodel", ctx.ui.theme.fg("dim", `auto:${actualTier.name}`));
			} else {
				ctx.ui.notify(`Auto model: continuing with current Pi model ${modelKey(actualModel)}`, "info");
				ctx.ui.setStatus("automodel", ctx.ui.theme.fg("dim", "auto:model"));
			}
		} finally {
			routing = false;
		}
	});
}
