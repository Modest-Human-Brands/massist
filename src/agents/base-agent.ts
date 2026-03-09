import { ofetch } from "ofetch"
import { AbortError } from "p-retry"
import type { AgentConfig } from "../master/types"

// ─────────────────────────────────────────────────────────────────────────────
// Context passed to every agent at runtime
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentContext {
	imageBase64?: string
	mime?: string
	domains?: Record<string, unknown>   // upstream results (for synthesizers)
}

// ─────────────────────────────────────────────────────────────────────────────
// Abstract base — shared LLM call + JSON parsing
// ─────────────────────────────────────────────────────────────────────────────

export abstract class BaseAgent {
	protected config: AgentConfig
	protected apiUrl: string

	constructor(config: AgentConfig, apiUrl: string) {
		this.config = config
		this.apiUrl = apiUrl
	}

	protected async callLLM(
		systemPrompt: string,
		userContent: Array<{ type: string;[k: string]: unknown }>,
		maxTokens?: number,
		temperature?: number
	): Promise<string> {
		const response = await ofetch(`${this.apiUrl}/v1/chat/completions`, {
			method: "POST",
			body: {
				model: this.config.model,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userContent }
				],
				temperature: temperature ?? this.config.temperature,
				max_tokens: maxTokens ?? this.config.max_tokens,
				chat_template_kwargs: { enable_thinking: false },
			},
			retry: 0,
		})

		const choice = response.choices[0]
		if (choice.finish_reason === "length") {
			throw new AbortError(
				`Token limit hit for agent "${this.config.id}" — raise max_tokens in agent config`
			)
		}

		return choice.message.content as string
	}

	protected parseJSON(raw: string): unknown {
		const cleaned = raw
			.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```\s*$/i, "").trim()
		try {
			return JSON.parse(cleaned)
		} catch (err: any) {
			throw new Error(
				`Invalid JSON from "${this.config.id}": ${err.message}\nPreview: ${cleaned.slice(0, 300)}`
			)
		}
	}

	abstract run(context: AgentContext, skillContent: string): Promise<unknown>
}

// ─────────────────────────────────────────────────────────────────────────────
// RouterAgent — determines which downstream agents should run
// ─────────────────────────────────────────────────────────────────────────────

export class RouterAgent extends BaseAgent {
	async run(context: AgentContext, skillContent: string): Promise<unknown> {
		const content = [{ type: "text", text: "Analyse this image and return the JSON array of applicable domain IDs." }]
		if (context.imageBase64) {
			content.push({
				type: "image_url",
				image_url: { url: `data:${context.mime ?? "image/jpeg"};base64,${context.imageBase64}` }
			} as any)
		}
		const raw = await this.callLLM(skillContent, content)
		return this.parseJSON(raw)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// AnalystAgent — analyses image for a specific domain
// ─────────────────────────────────────────────────────────────────────────────

export class AnalystAgent extends BaseAgent {
	async run(context: AgentContext, skillContent: string): Promise<unknown> {
		const content: any[] = [{ type: "text", text: "Execute visual analysis. Return ONLY valid JSON." }]
		if (context.imageBase64) {
			content.push({
				type: "image_url",
				image_url: { url: `data:${context.mime ?? "image/jpeg"};base64,${context.imageBase64}` }
			})
		}
		const raw = await this.callLLM(skillContent, content)
		return this.parseJSON(raw)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// SynthesizerAgent — consumes all domain results, produces synthesis
// ─────────────────────────────────────────────────────────────────────────────

export class SynthesizerAgent extends BaseAgent {
	async run(context: AgentContext, skillContent: string): Promise<unknown> {
		const payload = JSON.stringify({ analysis_results: context.domains }, null, 2)
		const content = [
			{ type: "text", text: `Aggregated analysis data:\n\n${payload}\n\nExecute synthesis. Return ONLY valid JSON.` }
		]
		const raw = await this.callLLM(skillContent, content)
		return this.parseJSON(raw)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createAgent(config: AgentConfig, apiUrl: string): BaseAgent {
	switch (config.type) {
		case "router":
			return new RouterAgent(config, apiUrl)
		case "synthesizer":
		case "generator":
			return new SynthesizerAgent(config, apiUrl)
		default:
			return new AnalystAgent(config, apiUrl)
	}
}