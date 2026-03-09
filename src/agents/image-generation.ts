import { writeFileSync, mkdirSync } from "fs"
import { dirname } from "path"

interface ImageGenerationAgentOpts {
	apiUrl: string
	model: string
	width: number
	height: number
	numInferenceSteps?: number
	guidanceScale?: number
}

interface GenerateOpts {
	positivePrompt: string
	negativePrompt: string
	outputPath: string
	seed?: number
}

interface GenerateResult {
	success: boolean
	outputPath?: string
	error?: string
}

export class ImageGenerationAgent {
	private apiUrl: string
	private model: string
	private width: number
	private height: number
	private numInferenceSteps: number
	private guidanceScale: number

	constructor(opts: ImageGenerationAgentOpts) {
		this.apiUrl = opts.apiUrl.replace(/\/$/, "")
		this.model = opts.model
		this.width = opts.width
		this.height = opts.height
		this.numInferenceSteps = opts.numInferenceSteps ?? 8    // Z-Image-Turbo: 8 NFEs only
		this.guidanceScale = opts.guidanceScale ?? 4.0   // Z-Image-Turbo default CFG
	}

	async generate(opts: GenerateOpts): Promise<GenerateResult> {
		const { positivePrompt, negativePrompt, outputPath, seed } = opts

		const body: Record<string, unknown> = {
			model: this.model,
			prompt: positivePrompt,
			n: 1,
			size: `${this.width}x${this.height}`,
			response_format: "b64_json",
			extra_body: {
				negative_prompt: negativePrompt,
				num_inference_steps: this.numInferenceSteps,
				guidance_scale: this.guidanceScale,
				width: this.width,
				height: this.height,
				...(seed !== undefined ? { seed } : {}),
			},
		}

		let res: Response
		try {
			res = await fetch(`${this.apiUrl}/v1/images/generations`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			})
		} catch (err: any) {
			return { success: false, error: `Network error: ${err.message}` }
		}

		if (!res.ok) {
			const text = await res.text().catch(() => res.statusText)
			return { success: false, error: `HTTP ${res.status}: ${text}` }
		}

		let json: any
		try {
			json = await res.json()
		} catch (err: any) {
			return { success: false, error: `Failed to parse response JSON: ${err.message}` }
		}

		const b64 = json?.data?.[0]?.b64_json as string | undefined
		if (!b64) {
			return { success: false, error: `No b64_json in response: ${JSON.stringify(json).slice(0, 200)}` }
		}

		try {
			mkdirSync(dirname(outputPath), { recursive: true })
			writeFileSync(outputPath, Buffer.from(b64, "base64"))
		} catch (err: any) {
			return { success: false, error: `Failed to write PNG: ${err.message}` }
		}

		return { success: true, outputPath }
	}
}

export function extractPromptsFromAnalysis(
	analysisJson: Record<string, unknown>
): { positive: string; negative: string } {
	const imgprompt = analysisJson["imgprompt"] as Record<string, unknown> | undefined
	if (!imgprompt) throw new Error("imgprompt domain missing from analysis JSON")

	const promptSynthesis = imgprompt["prompt_synthesis"] as Record<string, unknown> | undefined
	const prompts = promptSynthesis?.["prompts"] as Record<string, unknown> | undefined

	const positive = prompts?.["full"] as string | undefined
	const negative = prompts?.["negative_prompt"] as string | undefined

	if (!positive) throw new Error("imgprompt.prompt_synthesis.prompts.full is missing or empty")
	if (!negative) throw new Error("imgprompt.prompt_synthesis.prompts.negative_prompt is missing or empty")

	return { positive, negative }
}