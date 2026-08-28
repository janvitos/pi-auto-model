import fs from "node:fs";
import path from "node:path";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type TierName = "simple" | "standard" | "complex";
export interface ModelSelection {
	provider: string;
	model: string;
	thinkingLevel: ThinkingLevel;
}

export interface ModelTier extends ModelSelection {
	name: TierName;
}

export interface AutoModelConfig {
	version: 1;
	enabled: boolean;
	classifier: ModelSelection;
	tiers: ModelTier[];
}

export interface LoadConfigResult {
	config?: AutoModelConfig;
	warning?: string;
}

const THINKING_LEVEL_SET = new Set<string>(THINKING_LEVELS);

export function getConfigPath(agentDir: string): string {
	return path.join(agentDir, "auto-model.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateConfig(value: unknown): AutoModelConfig {
	if (!isRecord(value)) throw new Error("configuration must be a JSON object");
	if (value.version !== 1) throw new Error("unsupported or missing configuration version");
	if (typeof value.enabled !== "boolean") throw new Error("enabled must be true or false");
	if (!Array.isArray(value.tiers) || (value.tiers.length !== 2 && value.tiers.length !== 3)) {
		throw new Error("tiers must contain exactly two or three entries");
	}

	const expectedNames: TierName[] = value.tiers.length === 2
		? ["simple", "complex"]
		: ["simple", "standard", "complex"];
	const tiers = value.tiers.map((candidate, index): ModelTier => {
		if (!isRecord(candidate)) throw new Error(`tier ${index + 1} must be an object`);
		if (candidate.name !== expectedNames[index]) {
			throw new Error(`tier ${index + 1} must be named ${expectedNames[index]}`);
		}
		if (typeof candidate.provider !== "string" || candidate.provider.trim() === "") {
			throw new Error(`${candidate.name} tier provider must be a non-empty string`);
		}
		if (typeof candidate.model !== "string" || candidate.model.trim() === "") {
			throw new Error(`${candidate.name} tier model must be a non-empty string`);
		}
		if (typeof candidate.thinkingLevel !== "string" || !THINKING_LEVEL_SET.has(candidate.thinkingLevel)) {
			throw new Error(`${candidate.name} tier has an invalid thinking level`);
		}
		return {
			name: candidate.name as TierName,
			provider: candidate.provider,
			model: candidate.model,
			thinkingLevel: candidate.thinkingLevel as ThinkingLevel,
		};
	});

	let classifier: ModelSelection;
	if (value.classifier === undefined) {
		const simple = tiers[0];
		classifier = {
			provider: simple.provider,
			model: simple.model,
			thinkingLevel: simple.thinkingLevel,
		};
	} else {
		if (!isRecord(value.classifier)) throw new Error("classifier must be an object");
		if (typeof value.classifier.provider !== "string" || value.classifier.provider.trim() === "") {
			throw new Error("classifier provider must be a non-empty string");
		}
		if (typeof value.classifier.model !== "string" || value.classifier.model.trim() === "") {
			throw new Error("classifier model must be a non-empty string");
		}
		if (
			typeof value.classifier.thinkingLevel !== "string" ||
			!THINKING_LEVEL_SET.has(value.classifier.thinkingLevel)
		) {
			throw new Error("classifier has an invalid thinking level");
		}
		classifier = {
			provider: value.classifier.provider,
			model: value.classifier.model,
			thinkingLevel: value.classifier.thinkingLevel as ThinkingLevel,
		};
	}

	return {
		version: 1,
		enabled: value.enabled,
		classifier,
		tiers,
	};
}

export async function loadConfig(configPath: string): Promise<LoadConfigResult> {
	try {
		const content = await fs.promises.readFile(configPath, "utf8");
		return { config: validateConfig(JSON.parse(content)) };
	} catch (error: unknown) {
		if ((error as { code?: unknown }).code === "ENOENT") return {};
		const message = error instanceof Error ? error.message : String(error);
		return { warning: `Could not load ${configPath}: ${message}` };
	}
}

export async function saveConfig(configPath: string, config: AutoModelConfig): Promise<void> {
	const validated = validateConfig(config);
	await fs.promises.mkdir(path.dirname(configPath), { recursive: true });
	const temporary = `${configPath}.${process.pid}.${Date.now()}.tmp`;
	try {
		await fs.promises.writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
		await fs.promises.rename(temporary, configPath);
	} finally {
		await fs.promises.rm(temporary, { force: true });
	}
}
