import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import {
	DynamicBorder,
	getSelectListTheme,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	SelectList,
	Spacer,
	Text,
	type Focusable,
	type SelectItem,
} from "@earendil-works/pi-tui";
import {
	saveConfig,
	type AutoModelConfig,
	type ModelSelection,
	type ModelTier,
	type ThinkingLevel,
	type TierName,
} from "./config.ts";
import { modelKey, selectableModels } from "./router.ts";

function formatConfig(config: AutoModelConfig | undefined): string {
	if (!config) return "Auto model is not configured. Run /automodel setup.";
	const routes = config.tiers
		.map((tier) => `${tier.name}: ${tier.provider}/${tier.model} (${tier.thinkingLevel})`)
		.join("\n");
	const classifier = `${config.classifier.provider}/${config.classifier.model} (${config.classifier.thinkingLevel})`;
	return `Auto model: ${config.enabled ? "enabled" : "disabled"}\n${routes}\nClassifier: ${classifier}`;
}

function sortedTierModels(ctx: ExtensionCommandContext): Model<Api>[] {
	return selectableModels(ctx.modelRegistry.getAvailable(), ctx.scopedModels).sort((a, b) =>
		modelKey(a).localeCompare(modelKey(b)),
	);
}

function sortedClassifierModels(ctx: ExtensionCommandContext): Model<Api>[] {
	return [...ctx.modelRegistry.getAvailable()].sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
}

function modelSearchText(model: Model<Api>): string {
	return `${model.provider} ${model.provider}/${model.id} ${model.id} ${model.name ?? ""}`;
}

async function chooseOption(
	ctx: ExtensionCommandContext,
	title: string,
	options: readonly string[],
	current?: string,
): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const container = new Container();
		const items = options.map((option) => ({ value: option, label: option }));
		const selectList = new SelectList(items, Math.min(items.length, 10), getSelectListTheme());
		const currentIndex = current ? options.indexOf(current) : -1;
		if (currentIndex >= 0) selectList.setSelectedIndex(currentIndex);
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(undefined);
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter select · esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

async function chooseModel(
	ctx: ExtensionCommandContext,
	purpose: string,
	models: readonly Model<Api>[],
	current?: ModelSelection,
): Promise<Model<Api> | undefined> {
	const selectedKey = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		const container = new Container();
		const searchInput = new Input();
		const listContainer = new Container();
		let filtered = [...models];
		let selectList: SelectList;

		const buildItems = (): SelectItem[] => filtered.map((model) => ({
			value: modelKey(model),
			label: model.id,
			description: `${model.provider}${model.name ? ` · ${model.name}` : ""}`,
		}));
		const rebuildList = (preselectCurrent = false) => {
			selectList = new SelectList(buildItems(), 10, getSelectListTheme(), {
				minPrimaryColumnWidth: 24,
				maxPrimaryColumnWidth: 48,
			});
			if (preselectCurrent && current) {
				const currentIndex = filtered.findIndex(
					(model) => model.provider === current.provider && model.id === current.model,
				);
				if (currentIndex >= 0) selectList.setSelectedIndex(currentIndex);
			}
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(undefined);
			listContainer.clear();
			listContainer.addChild(selectList);
		};
		rebuildList(true);

		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
		container.addChild(new Text(theme.fg("accent", theme.bold(`Model for ${purpose}`)), 1, 0));
		container.addChild(new Text(theme.fg("muted", "Search by model, provider, or display name"), 1, 0));
		container.addChild(searchInput);
		container.addChild(new Spacer(1));
		container.addChild(listContainer);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter select · esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

		const component: Focusable & {
			render(width: number): string[];
			invalidate(): void;
			handleInput(data: string): void;
		} = {
			get focused() {
				return searchInput.focused;
			},
			set focused(value: boolean) {
				searchInput.focused = value;
			},
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				if (
					keybindings.matches(data, "tui.select.up") ||
					keybindings.matches(data, "tui.select.down") ||
					keybindings.matches(data, "tui.select.confirm") ||
					keybindings.matches(data, "tui.select.cancel")
				) {
					selectList.handleInput(data);
				} else {
					searchInput.handleInput(data);
					const query = searchInput.getValue().trim();
					filtered = query ? fuzzyFilter([...models], query, modelSearchText) : [...models];
					rebuildList();
				}
				tui.requestRender();
			},
		};
		return component;
	});
	return selectedKey ? models.find((model) => modelKey(model) === selectedKey) : undefined;
}

async function chooseThinkingLevel(
	ctx: ExtensionCommandContext,
	purpose: string,
	model: Model<Api>,
	current?: ThinkingLevel,
): Promise<ThinkingLevel | undefined> {
	const levels = getSupportedThinkingLevels(model) as ThinkingLevel[];
	return await chooseOption(ctx, `Thinking level for ${purpose}`, levels, current) as ThinkingLevel | undefined;
}

export async function setupAutoModel(
	ctx: ExtensionCommandContext,
	configPath: string,
	current?: AutoModelConfig,
): Promise<AutoModelConfig | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/automodel setup requires TUI mode", "error");
		return undefined;
	}
	const tierModels = sortedTierModels(ctx);
	const classifierModels = sortedClassifierModels(ctx);
	if (tierModels.length === 0) {
		ctx.ui.notify("No authenticated tier models are available in the current model scope", "error");
		return undefined;
	}
	if (!current?.classifier && classifierModels.length === 0) {
		ctx.ui.notify("No authenticated classifier models are available", "error");
		return undefined;
	}

	const tierLayouts = ["simple / complex", "simple / standard / complex"];
	const currentTierLayout = current?.tiers.length === 3 ? tierLayouts[1] : current ? tierLayouts[0] : undefined;
	const tierLayout = await chooseOption(ctx, "Auto-model tiers", tierLayouts, currentTierLayout);
	if (!tierLayout) return undefined;
	const names: TierName[] = tierLayout === "simple / complex"
		? ["simple", "complex"]
		: ["simple", "standard", "complex"];
	const tiers: ModelTier[] = [];
	for (const name of names) {
		const currentTier = current?.tiers.find((tier) => tier.name === name);
		const model = await chooseModel(ctx, `${name} tier`, tierModels, currentTier);
		if (!model) return undefined;
		const currentThinkingLevel = currentTier?.provider === model.provider && currentTier.model === model.id
			? currentTier.thinkingLevel
			: undefined;
		const thinkingLevel = await chooseThinkingLevel(ctx, `${name} tier`, model, currentThinkingLevel);
		if (!thinkingLevel) return undefined;
		tiers.push({ name, provider: model.provider, model: model.id, thinkingLevel });
	}

	let classifier: ModelSelection | undefined = current?.classifier;
	if (!classifier) {
		const classifierModel = await chooseModel(ctx, "classifier", classifierModels);
		if (!classifierModel) return undefined;
		const classifierThinkingLevel = await chooseThinkingLevel(ctx, "classifier", classifierModel);
		if (!classifierThinkingLevel) return undefined;
		classifier = {
			provider: classifierModel.provider,
			model: classifierModel.id,
			thinkingLevel: classifierThinkingLevel,
		};
	}

	const config: AutoModelConfig = {
		version: 1,
		enabled: true,
		classifier,
		tiers,
	};
	await saveConfig(configPath, config);
	ctx.ui.notify("Auto model configuration saved", "info");
	return config;
}

async function configureClassifier(
	ctx: ExtensionCommandContext,
	configPath: string,
	current: AutoModelConfig | undefined,
): Promise<AutoModelConfig | undefined> {
	if (!current) {
		ctx.ui.notify("Configure tiers first with /automodel setup", "warning");
		return current;
	}
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/automodel classifier requires TUI mode", "error");
		return current;
	}
	const models = sortedClassifierModels(ctx);
	if (models.length === 0) {
		ctx.ui.notify("No authenticated classifier models are available", "error");
		return current;
	}
	const model = await chooseModel(ctx, "classifier", models, current.classifier);
	if (!model) return current;
	const currentThinkingLevel = current.classifier.provider === model.provider && current.classifier.model === model.id
		? current.classifier.thinkingLevel
		: undefined;
	const thinkingLevel = await chooseThinkingLevel(ctx, "classifier", model, currentThinkingLevel);
	if (!thinkingLevel) return current;
	const updated: AutoModelConfig = {
		...current,
		classifier: { provider: model.provider, model: model.id, thinkingLevel },
	};
	await saveConfig(configPath, updated);
	ctx.ui.notify("Classifier configuration saved", "info");
	return updated;
}

export async function showAutoModelMenu(
	ctx: ExtensionCommandContext,
	configPath: string,
	current: AutoModelConfig | undefined,
): Promise<AutoModelConfig | undefined> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/automodel requires TUI mode; use status, on, or off", "error");
		return current;
	}
	const action = await ctx.ui.select("Auto Model", [
		"Tiers",
		"Classifier",
		current?.enabled ? "Disable" : "Enable",
		"Show status",
	]);
	if (!action) return current;
	if (action === "Tiers") return (await setupAutoModel(ctx, configPath, current)) ?? current;
	if (action === "Classifier") return configureClassifier(ctx, configPath, current);
	if (action === "Show status") {
		ctx.ui.notify(formatConfig(current), "info");
		return current;
	}
	if (!current) {
		ctx.ui.notify("Configure tiers before enabling auto model", "warning");
		return current;
	}
	const updated = { ...current, enabled: action === "Enable" };
	await saveConfig(configPath, updated);
	ctx.ui.notify(`Auto model ${updated.enabled ? "enabled" : "disabled"}`, "info");
	return updated;
}

export async function handleAutoModelCommand(
	args: string,
	ctx: ExtensionCommandContext,
	configPath: string,
	current: AutoModelConfig | undefined,
): Promise<AutoModelConfig | undefined> {
	const action = args.trim().toLowerCase();
	if (action === "") return showAutoModelMenu(ctx, configPath, current);
	if (action === "setup") return (await setupAutoModel(ctx, configPath, current)) ?? current;
	if (action === "classifier") return configureClassifier(ctx, configPath, current);
	if (action === "status") {
		ctx.ui.notify(formatConfig(current), "info");
		return current;
	}
	if (action === "on" || action === "off") {
		if (!current) {
			ctx.ui.notify("Configure tiers first with /automodel setup", "warning");
			return current;
		}
		const updated = { ...current, enabled: action === "on" };
		await saveConfig(configPath, updated);
		ctx.ui.notify(`Auto model ${updated.enabled ? "enabled" : "disabled"}`, "info");
		return updated;
	}
	ctx.ui.notify("Usage: /automodel [setup|classifier|status|on|off]", "error");
	return current;
}
