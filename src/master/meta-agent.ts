import { readFileSync } from "fs"
import { resolve } from "path"
import pLimit from "p-limit"
import pRetry, { AbortError } from "p-retry"

import type {
	MetaTask, WorkflowManifest, WorkflowRunResult, AgentRunResult
} from "./types"
import {
	loadWorkflow, loadAllAgentConfigs, updateWorkflowStats,
	bumpWorkflowVersion, updateAgentConfig, PATHS
} from "./registry"
import { loadSkills } from "../utils/skills"
import { planWorkflow } from "./planner"
import { buildWorkflowFromPlan, regenerateSkill } from "./agent-factory"
import { evaluateRun, generateImprovements } from "./evaluator"
import { createAgent, type AgentContext } from "../agents/base-agent"

export type ProgressCallback = (agentId: string, status: string, detail?: string) => void

export interface MetaAgentOptions {
	apiUrl: string
	model: string
	concurrency?: number
	autoImprove?: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// MetaAgent
// ─────────────────────────────────────────────────────────────────────────────

export class MetaAgent {
	private apiUrl: string
	private model: string
	private concurrency: number
	private autoImprove: boolean

	constructor(opts: MetaAgentOptions) {
		this.apiUrl = opts.apiUrl
		this.model = opts.model
		this.concurrency = opts.concurrency ?? 4
		this.autoImprove = opts.autoImprove ?? true
	}

	// ── Main entry point ────────────────────────────────────────────────────────

	async execute(
		task: MetaTask,
		input: Record<string, unknown>,
		onProgress?: ProgressCallback
	): Promise<WorkflowRunResult> {
		// 1. Resolve workflow — reuse from disk or build fresh
		const workflowId = this.deriveWorkflowId(task.description)
		let manifest = task.force_recreate ? null : loadWorkflow(workflowId)

		if (!manifest) {
			onProgress?.("meta-agent", "planning", task.description)
			const plan = await planWorkflow(task, this.apiUrl, this.model)

			onProgress?.("meta-agent", "building", `${plan.agents.length} agents`)
			manifest = await buildWorkflowFromPlan(plan, this.apiUrl, this.model)
		}

		// 2. Execute
		onProgress?.("meta-agent", "executing")
		const result = await this.runWorkflow(manifest, input, onProgress)

		// 3. Evaluate
		const evalResult = evaluateRun(result, manifest)
		result.eval_result = evalResult

		// 4. Persist stats
		updateWorkflowStats(manifest.id, evalResult.passed, result.duration_ms, evalResult)

		// 5. Auto-improve if score below threshold
		if (this.autoImprove && !evalResult.passed) {
			onProgress?.("meta-agent", "improving", `score=${evalResult.total_score.toFixed(2)}`)
			await this.applyImprovements(manifest, result)
		}

		return result
	}

	// ── Workflow execution ───────────────────────────────────────────────────────

	private async runWorkflow(
		manifest: WorkflowManifest,
		input: Record<string, unknown>,
		onProgress?: ProgressCallback
	): Promise<WorkflowRunResult> {
		const globalStart = Date.now()
		const agentConfigs = loadAllAgentConfigs(manifest.id)
		const skillsDir = resolve(process.cwd(), manifest.skillsDir)
		const skills = loadSkills(skillsDir)
		const skillMap = new Map(skills.map(s => [s.id, s.content]))

		// Prepare shared image context
		let imageBase64: string | undefined
		let mime = "image/jpeg"
		if (manifest.requiresImage && input.imagePath) {
			imageBase64 = readFileSync(input.imagePath as string, "base64")
			mime = (input.mime as string | undefined) ?? "image/jpeg"
		}

		const allResults: AgentRunResult[] = []
		const domains: Record<string, unknown> = {}

		// ── Phase 1: Entry (router) agent ─────────────────────────────────────────
		const entryId = manifest.graph.entry
		const entryConfig = agentConfigs.find(a => a.id === entryId)
		let activeDomains: string[] = []

		if (entryConfig) {
			onProgress?.(entryId, "start")
			const entryAgent = createAgent(entryConfig, this.apiUrl)
			const skill = skillMap.get(entryId) ?? ""
			const start = Date.now()

			try {
				const raw = await pRetry(
					() => entryAgent.run({ imageBase64, mime }, skill),
					{ retries: 2 }
				) as any

				activeDomains = Array.isArray(raw) ? raw : raw?.active_domains ?? []
				onProgress?.(entryId, "done")
				allResults.push({
					agent_id: entryId, agent_name: entryConfig.name, domain: "triage",
					success: true, duration_ms: Date.now() - start, attempts: 1, data: raw
				})
			} catch (err: any) {
				activeDomains = manifest.synthesisDomains
				onProgress?.(entryId, "error", err.message)
				allResults.push({
					agent_id: entryId, agent_name: entryConfig.name, domain: "triage",
					success: false, duration_ms: Date.now() - start, attempts: 1, error: err.message
				})
			}
		}

		// Always include core domains
		for (const d of ["aesthetic", "skin", "pose"]) {
			if (!activeDomains.includes(d)) activeDomains.push(d)
		}

		// ── Phase 2: Parallel analyst agents ─────────────────────────────────────
		const analystConfigs = agentConfigs.filter(a =>
			a.type === "analyst" && activeDomains.includes(a.id)
		)
		const skippedConfigs = agentConfigs.filter(a =>
			a.type === "analyst" && !activeDomains.includes(a.id)
		)

		for (const c of skippedConfigs) {
			onProgress?.(c.id, "skipped")
			allResults.push({
				agent_id: c.id, agent_name: c.name, domain: c.id,
				success: true, skipped: true, duration_ms: 0, attempts: 0
			})
		}

		const limit = pLimit(this.concurrency)
		await Promise.all(analystConfigs.map(config =>
			limit(async () => {
				onProgress?.(config.id, "start")
				const start = Date.now()
				const skill = skillMap.get(config.id) ?? ""
				const agent = createAgent(config, this.apiUrl)
				let attempts = 0

				try {
					const data = await pRetry(async () => {
						attempts++
						if (attempts > 1) onProgress?.(config.id, "retry")
						return agent.run({ imageBase64, mime }, skill)
					}, {
						retries: 2,
						onFailedAttempt: err => { if (err instanceof AbortError) throw err }
					})

					onProgress?.(config.id, "done")
					domains[config.id] = data
					allResults.push({
						agent_id: config.id, agent_name: config.name, domain: config.id,
						success: true, duration_ms: Date.now() - start, attempts, data
					})
				} catch (err: any) {
					onProgress?.(config.id, "error", err.message)
					domains[config.id] = { _error: err.message }
					allResults.push({
						agent_id: config.id, agent_name: config.name, domain: config.id,
						success: false, duration_ms: Date.now() - start, attempts, error: err.message
					})
				}
			})
		))

		// ── Phase 3: Sequential synthesis agents ─────────────────────────────────
		const synthConfigs = agentConfigs.filter(
			a => a.type === "synthesizer" || a.type === "generator"
		)

		for (const config of synthConfigs) {
			onProgress?.(config.id, "start")
			const start = Date.now()
			const skill = skillMap.get(config.id) ?? ""
			const agent = createAgent(config, this.apiUrl)
			let attempts = 0

			try {
				const data = await pRetry(async () => {
					attempts++
					if (attempts > 1) onProgress?.(config.id, "retry")
					return agent.run({ domains }, skill)
				}, {
					retries: 2,
					onFailedAttempt: err => { if (err instanceof AbortError) throw err }
				})

				onProgress?.(config.id, "done")
				domains[config.id] = data
				allResults.push({
					agent_id: config.id, agent_name: config.name, domain: config.id,
					success: true, duration_ms: Date.now() - start, attempts, data
				})
			} catch (err: any) {
				onProgress?.(config.id, "error", err.message)
				domains[config.id] = { _error: err.message }
				allResults.push({
					agent_id: config.id, agent_name: config.name, domain: config.id,
					success: false, duration_ms: Date.now() - start, attempts, error: err.message
				})
			}
		}

		return {
			workflow_id: manifest.id,
			domains,
			duration_ms: Date.now() - globalStart,
			agent_results: allResults,
		}
	}

	// ── Self-improvement ─────────────────────────────────────────────────────────

	private async applyImprovements(
		manifest: WorkflowManifest,
		result: WorkflowRunResult
	): Promise<void> {
		const evalResult = result.eval_result!
		const actions = await generateImprovements(evalResult, manifest, result, this.apiUrl, this.model)

		for (const action of actions) {
			switch (action.action) {
				case "update_token_budget":
					updateAgentConfig(manifest.id, action.agent_id, { max_tokens: action.new_value as number })
					break

				case "update_temperature":
					updateAgentConfig(manifest.id, action.agent_id, { temperature: action.new_value as number })
					break

				case "update_skill":
					await regenerateSkill(
						manifest.id,
						action.agent_id,
						action.new_value as string,
						this.apiUrl,
						this.model
					)
					break

				case "update_schema":
					updateAgentConfig(manifest.id, action.agent_id, { output_schema: action.new_value as any })
					break
			}
		}

		bumpWorkflowVersion(manifest.id)
	}

	// ── Helpers ──────────────────────────────────────────────────────────────────

	private deriveWorkflowId(description: string): string {
		return description
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, "")
			.trim()
			.replace(/\s+/g, "-")
			.slice(0, 48)
	}
}