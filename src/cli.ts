import { defineCommand, runMain as _runMain } from "citty"
import * as p from "@clack/prompts"
import chalk from "chalk"
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { resolve, extname, basename, dirname, join } from "path"

import { MetaAgent } from "./master/meta-agent"
import { ImageGenerationAgent, extractPromptsFromAnalysis } from "./agents/image-generation"
import { renderBanner, AgentBoard } from "./utils/renderer"
import { name, description, version } from "../package.json"

export type AgentState = "pending" | "running" | "done" | "error" | "retrying" | "skipped"

const MIME: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
}

const DEFAULT_TASK = "Head-to-toe human visual analysis — skin, pose, hair, makeup, clothing, lingerie, accessories, footwear, and image generation prompt synthesis"

// ─────────────────────────────────────────────────────────────────────────────
// Image generation pipeline
// ─────────────────────────────────────────────────────────────────────────────

interface GenerateOpts {
	analysisJson: Record<string, unknown>
	baseName: string
	artifactDir: string
	outputPath?: string
	width: number
	height: number
}

async function runGenerate(opts: GenerateOpts): Promise<void> {
	console.log(chalk.bold.cyan("\n  ┌─ Image Generation Pipeline " + "─".repeat(38)))

	const imgpromptDomain = opts.analysisJson["imgprompt"] as Record<string, unknown> | undefined
	if (!imgpromptDomain || (imgpromptDomain as any)._error) {
		console.log(chalk.red("  │  ✖ imgprompt domain failed or missing — cannot generate image"))
		console.log(chalk.bold.cyan("  └─" + "─".repeat(64) + "\n"))
		return
	}

	let positive: string, negative: string
	try {
		; ({ positive, negative } = extractPromptsFromAnalysis(opts.analysisJson))
	} catch (err: any) {
		console.log(chalk.red(`  │  ✖ Failed to extract prompts: ${err.message}`))
		console.log(chalk.bold.cyan("  └─" + "─".repeat(64) + "\n"))
		return
	}

	console.log(chalk.dim(`  │  Positive (${positive.length} chars): ${positive.slice(0, 120)}…`))
	console.log(chalk.dim(`  │  Negative (${negative.length} chars): ${negative.slice(0, 80)}…`))
	console.log(chalk.cyan("  │"))
	console.log(chalk.white("  │  ⠋ Generating image…"))

	const genAgent = new ImageGenerationAgent({
		apiUrl: process.env.MOTIA_VLLM_IMAGE_URL || "http://localhost:4701",
		model: process.env.MOTIA_VLLM_IMAGE_MODEL || "Tongyi-MAI/Z-Image-Turbo",
		width: opts.width,
		height: opts.height,
	})

	const genOutputPath = opts.outputPath || resolve(opts.artifactDir, `${opts.baseName}-generated.png`)
	mkdirSync(dirname(genOutputPath), { recursive: true })

	const start = Date.now()
	const genResult = await genAgent.generate({ positivePrompt: positive, negativePrompt: negative, outputPath: genOutputPath })
	const elapsed = ((Date.now() - start) / 1000).toFixed(1)

	if (genResult.success) {
		console.log(chalk.green(`  │  ✓ Generated in ${elapsed}s`))
		console.log(chalk.bold.cyan("  └─" + "─".repeat(64)))
		console.log(chalk.green(`  🖼️  Saved image to: ${genResult.outputPath}\n`))
	} else {
		console.log(chalk.red(`  │  ✖ Failed after ${elapsed}s: ${genResult.error}`))
		console.log(chalk.bold.cyan("  └─" + "─".repeat(64) + "\n"))
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// MetaAgent analysis pipeline
// ─────────────────────────────────────────────────────────────────────────────

interface AnalyzeOpts {
	imagePath: string
	taskDescription: string
	outputPath?: string
	concurrency: number
	forceRecreate?: boolean
}

async function runAnalyze(opts: AnalyzeOpts): Promise<{ outJson: Record<string, unknown>; baseName: string; artifactDir: string } | null> {
	const ext = extname(opts.imagePath).toLowerCase()
	const mime = MIME[ext]
	if (!mime) { console.error(chalk.red(`\n✖ Unsupported image type: ${ext}`)); return null }

	const board = new AgentBoard()
	const metaAgent = new MetaAgent({
		apiUrl: process.env.MOTIA_VLLM_TEXT_URL || "http://localhost:8000",
		model: process.env.MOTIA_VLLM_TEXT_MODEL || "Qwen/Qwen3.5-4B",
		concurrency: opts.concurrency,
		autoImprove: true,
	})

	let boardStarted = false

	let result
	try {
		result = await metaAgent.execute(
			{
				description: opts.taskDescription,
				input_type: "image",
				output_type: "json",
				force_recreate: opts.forceRecreate,
			},
			{ imagePath: opts.imagePath, mime },
			(agentId, status, detail) => {
				if (agentId === "meta-agent" && (status === "planning" || status === "building")) {
					if (!boardStarted) {
						board.start([{ id: "meta-agent", name: "MetaAgent" }])
						boardStarted = true
					}
					board.update("meta-agent", "running")
					return
				}
				if (!boardStarted) {
					board.start([{ id: agentId, name: agentId }])
					boardStarted = true
				}
				const stateMap: Record<string, AgentState> = {
					start: "running", done: "done", error: "error",
					retry: "retrying", skipped: "skipped", improving: "retrying",
				}
				board.update(agentId, stateMap[status] ?? "running")
			}
		)
	} catch (err) {
		if (boardStarted) board.stop()
		console.error(chalk.red(`\n✖ Fatal Error: ${err instanceof Error ? err.message : String(err)}`))
		return null
	}

	if (boardStarted) board.stop()

	if (result.eval_result) {
		const score = (result.eval_result.total_score * 100).toFixed(0)
		const icon = result.eval_result.passed ? chalk.green("✓") : chalk.yellow("⚠")
		console.log(chalk.dim(`\n  ${icon} Eval score: ${score}% — ${result.eval_result.feedback[0]}\n`))
	}

	const baseName = basename(opts.imagePath, ext)
	const artifactDir = resolve(process.cwd(), "artifact")
	mkdirSync(artifactDir, { recursive: true })

	const outJson = {
		_meta: {
			workflow: result.workflow_id,
			image: basename(opts.imagePath),
			duration_ms: result.duration_ms,
		},
		...result.domains,
	}

	const outPath = opts.outputPath || resolve(artifactDir, `${baseName}-analysis.json`)
	mkdirSync(dirname(outPath), { recursive: true })
	writeFileSync(outPath, JSON.stringify(outJson, null, 2))
	console.log(chalk.green(`  💾 Saved analysis to: ${outPath}\n`))

	return { outJson, baseName, artifactDir }
}

// ─────────────────────────────────────────────────────────────────────────────
// Interactive helpers
// ─────────────────────────────────────────────────────────────────────────────

function cancel() { p.cancel("Cancelled."); process.exit(0) }
function guard<T>(v: T | symbol): T { if (p.isCancel(v)) cancel(); return v as T }

async function promptGenSize(): Promise<{ width: number; height: number }> {
	const choice = guard(await p.select({
		message: "Output image size:",
		options: [
			{ value: "832x1216", label: "832 × 1216", hint: "portrait (default)" },
			{ value: "1216x832", label: "1216 × 832", hint: "landscape" },
			{ value: "1024x1024", label: "1024 × 1024", hint: "square" },
			{ value: "custom", label: "Custom…" },
		],
	}))

	if (choice !== "custom") {
		const [w, h] = (choice as string).split("x").map(Number)
		return { width: w, height: h }
	}

	const w = guard(await p.text({ message: "Width (px):", initialValue: "832", validate: v => isNaN(+v) ? "Must be a number" : undefined }))
	const h = guard(await p.text({ message: "Height (px):", initialValue: "1216", validate: v => isNaN(+v) ? "Must be a number" : undefined }))
	return { width: parseInt(w as string, 10), height: parseInt(h as string, 10) }
}

async function promptJsonPath(): Promise<string> {
	const artifactDir = resolve(process.cwd(), "artifact")
	const existingJsons = existsSync(artifactDir)
		? readdirSync(artifactDir).filter(f => f.endsWith("-analysis.json")).map(f => join(artifactDir, f))
		: []

	if (existingJsons.length === 0) {
		return resolve(guard(await p.text({
			message: "Path to analysis JSON:",
			placeholder: "artifact/photo-analysis.json",
			validate: v => !v ? "Required" : !existsSync(resolve(v)) ? `Not found: ${v}` : undefined,
		})) as string)
	}

	const pick = guard(await p.select({
		message: "Select analysis JSON:",
		options: [
			...existingJsons.map(f => ({ value: f, label: basename(f) })),
			{ value: "__manual__", label: "Enter path manually…" },
		],
	}))

	if (pick !== "__manual__") return pick as string

	return resolve(guard(await p.text({
		message: "Analysis JSON path:",
		validate: v => !v ? "Required" : !existsSync(resolve(v)) ? `Not found: ${v}` : undefined,
	})) as string)
}

// ─────────────────────────────────────────────────────────────────────────────
// Interactive mode
// ─────────────────────────────────────────────────────────────────────────────

async function runInteractive(): Promise<void> {
	p.intro(chalk.bold.magenta("  Visual Intelligence Pipeline"))

	const mode = guard(await p.select({
		message: "What would you like to do?",
		options: [
			{ value: "analyze", label: "🔍  Analyze image", hint: "run visual analysis via MetaAgent" },
			{ value: "generate", label: "🖼️   Generate image from existing analysis", hint: "reads a saved *-analysis.json" },
		],
	}))

	// ── Generate ───────────────────────────────────────────────────────────────
	if (mode === "generate") {
		const jsonPath = await promptJsonPath()

		let analysisJson: Record<string, unknown>
		try { analysisJson = JSON.parse(readFileSync(jsonPath, "utf-8")) }
		catch (e: any) { console.error(chalk.red(`\n✖ Failed to parse JSON: ${e.message}`)); p.outro(""); return }

		const meta = analysisJson["_meta"] as Record<string, unknown> | undefined
		const sourceImage = meta?.["image"] as string | undefined
		const baseName = sourceImage
			? basename(sourceImage, extname(sourceImage))
			: basename(jsonPath, ".json").replace(/-analysis$/, "")

		const { width, height } = await promptGenSize()
		await runGenerate({ analysisJson, baseName, artifactDir: dirname(jsonPath), width, height })
		p.outro(chalk.green("Done!"))
		return
	}

	// ── Analyze ────────────────────────────────────────────────────────────────
	const imagePath = resolve(guard(await p.text({
		message: "Image file path:",
		placeholder: "temp/photo.jpg",
		validate(v) {
			if (!v) return "Required"
			if (!existsSync(resolve(v))) return `Not found: ${v}`
			if (!MIME[extname(v).toLowerCase()]) return "Unsupported — use jpg, jpeg, png, or webp"
		},
	})) as string)

	const taskDesc = guard(await p.text({
		message: "Task description:",
		initialValue: DEFAULT_TASK,
		validate: v => !v ? "Required" : undefined,
	}))

	const forceRecreate = guard(await p.confirm({
		message: "Rebuild workflow from scratch?",
		initialValue: false,
	})) as boolean

	const result = await runAnalyze({
		imagePath,
		taskDescription: taskDesc as string,
		concurrency: 4,
		forceRecreate,
	})
	if (!result) { p.outro(chalk.red("Analysis failed.")); return }

	p.outro(chalk.green("Done!"))
}

// ─────────────────────────────────────────────────────────────────────────────
// Main command
// ─────────────────────────────────────────────────────────────────────────────

const main = defineCommand({
	meta: { name, description, version },
	args: {
		image: { type: "positional", description: "Image to analyze (omit for interactive mode)", required: false },
		task: { type: "string", description: `Analysis task description (default: human visual analysis)` },
		output: { type: "string", description: "Output JSON file path" },
		concurrency: { type: "string", description: "Max parallel agents", default: "4" },
		forceRecreate: { type: "boolean", description: "Rebuild workflow from scratch", default: false },
		generate: { type: "boolean", description: "Generate image after analysis", default: false },
		genOutput: { type: "string", description: "Output path for generated image" },
		genWidth: { type: "string", description: "Generated image width", default: "832" },
		genHeight: { type: "string", description: "Generated image height", default: "1216" },
		fromJson: { type: "string", description: "Generate from existing analysis JSON (skips analysis)" },
	},
	async run({ args }) {
		renderBanner()

		// ── --fromJson: standalone generation ─────────────────────────────────────
		if (args.fromJson) {
			const jsonPath = resolve(args.fromJson)
			if (!existsSync(jsonPath)) { console.error(chalk.red(`\n✖ JSON not found: ${jsonPath}`)); process.exit(1) }

			let analysisJson: Record<string, unknown>
			try { analysisJson = JSON.parse(readFileSync(jsonPath, "utf-8")) }
			catch (e: any) { console.error(chalk.red(`\n✖ Failed to parse JSON: ${e.message}`)); process.exit(1) }

			const meta = analysisJson["_meta"] as Record<string, unknown> | undefined
			const srcImage = meta?.["image"] as string | undefined
			const baseName = srcImage
				? basename(srcImage, extname(srcImage))
				: basename(jsonPath, ".json").replace(/-analysis$/, "")

			await runGenerate({
				analysisJson,
				baseName,
				artifactDir: dirname(jsonPath),
				outputPath: args.genOutput,
				width: parseInt(args.genWidth, 10) || 832,
				height: parseInt(args.genHeight, 10) || 1216,
			})
			return
		}

		// ── No image → interactive ─────────────────────────────────────────────────
		if (!args.image) {
			await runInteractive()
			return
		}

		// ── Non-interactive: image provided ────────────────────────────────────────
		const imagePath = resolve(args.image)
		if (!existsSync(imagePath)) { console.error(chalk.red(`\n✖ Image not found: ${imagePath}`)); process.exit(1) }
		if (!MIME[extname(imagePath).toLowerCase()]) { console.error(chalk.red(`\n✖ Unsupported image type`)); process.exit(1) }

		const result = await runAnalyze({
			imagePath,
			taskDescription: args.task || DEFAULT_TASK,
			outputPath: args.output,
			concurrency: parseInt(args.concurrency, 10) || 4,
			forceRecreate: args.forceRecreate,
		})
		if (!result) process.exit(1)

		if (args.generate) {
			await runGenerate({
				analysisJson: result.outJson,
				baseName: result.baseName,
				artifactDir: result.artifactDir,
				outputPath: args.genOutput,
				width: parseInt(args.genWidth, 10) || 832,
				height: parseInt(args.genHeight, 10) || 1216,
			})
		}
	}
})

export const runMain = () => _runMain(main)