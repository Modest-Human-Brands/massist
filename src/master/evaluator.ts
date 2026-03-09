import { ofetch } from "ofetch"
import type {
	WorkflowRunResult, WorkflowManifest,
	EvalResult, EvalMetric, ImprovementAction
} from "./types"

// ─────────────────────────────────────────────────────────────────────────────
// Scoring functions
// ─────────────────────────────────────────────────────────────────────────────

function scoreJsonValidity(domains: Record<string, unknown>): EvalMetric {
	const all = Object.values(domains)
	const valid = all.filter(d => d !== null && typeof d === "object" && !(d as any)._error)
	return {
		name: "json_validity",
		score: all.length > 0 ? valid.length / all.length : 1,
		weight: 0.30,
		details: `${valid.length}/${all.length} domains produced valid JSON`
	}
}

function scoreCompleteness(
	domains: Record<string, unknown>,
	synthesisDomains: string[]
): EvalMetric {
	if (synthesisDomains.length === 0) return { name: "output_completeness", score: 1, weight: 0.30 }
	const present = synthesisDomains.filter(d => domains[d] !== undefined && !(domains[d] as any)?._error)
	return {
		name: "output_completeness",
		score: present.length / synthesisDomains.length,
		weight: 0.30,
		details: `${present.length}/${synthesisDomains.length} expected domains present`
	}
}

function scoreSuccessRate(result: WorkflowRunResult): EvalMetric {
	const active = result.agent_results.filter(r => !r.skipped)
	const succeeded = active.filter(r => r.success)
	return {
		name: "agent_success_rate",
		score: active.length > 0 ? succeeded.length / active.length : 1,
		weight: 0.25,
		details: `${succeeded.length}/${active.length} agents succeeded`
	}
}

function scoreRetryRate(result: WorkflowRunResult): EvalMetric {
	const active = result.agent_results.filter(r => !r.skipped)
	const clean = active.filter(r => r.attempts === 1)
	return {
		name: "retry_rate",
		score: active.length > 0 ? clean.length / active.length : 1,
		weight: 0.15,
		details: `${clean.length}/${active.length} agents succeeded on first attempt`
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: evaluate a run
// ─────────────────────────────────────────────────────────────────────────────

export function evaluateRun(
	result: WorkflowRunResult,
	manifest: WorkflowManifest
): EvalResult {
	const metrics: EvalMetric[] = [
		scoreJsonValidity(result.domains),
		scoreCompleteness(result.domains, manifest.synthesisDomains),
		scoreSuccessRate(result),
		scoreRetryRate(result),
	]

	const totalWeight = metrics.reduce((s, m) => s + m.weight, 0)
	const total_score = metrics.reduce((s, m) => s + m.score * m.weight, 0) / totalWeight

	const feedback: string[] = []

	const validity = metrics.find(m => m.name === "json_validity")!
	if (validity.score < 0.9) {
		feedback.push("Agents produced invalid JSON — increase max_tokens or simplify output schema")
	}

	const missing = manifest.synthesisDomains.filter(
		d => !result.domains[d] || (result.domains[d] as any)?._error
	)
	if (missing.length > 0) {
		feedback.push(`Failed domains: ${missing.join(", ")} — review skill prompts for these agents`)
	}

	const retryRate = metrics.find(m => m.name === "retry_rate")!
	if (retryRate.score < 0.7) {
		feedback.push("High retry rate — model may be saturated or prompts are ambiguous")
	}

	const slowAgents = result.agent_results.filter(r => !r.skipped && r.duration_ms > 60_000)
	if (slowAgents.length > 0) {
		feedback.push(`Slow agents: ${slowAgents.map(a => a.agent_name).join(", ")} — reduce max_tokens`)
	}

	if (feedback.length === 0) {
		feedback.push("Workflow performing well — no improvements needed")
	}

	return {
		total_score,
		metrics,
		passed: total_score >= manifest.evaluation.threshold,
		feedback,
		timestamp: new Date().toISOString(),
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: generate typed improvement actions via LLM
// ─────────────────────────────────────────────────────────────────────────────

const IMPROVEMENT_SYSTEM = `You are an AI workflow optimisation expert.

Analyse the workflow evaluation results and return specific, actionable improvement actions.

Return ONLY a valid JSON array of improvement actions. Each action must match one of these shapes:
[
  { "action": "update_token_budget", "agent_id": "id", "new_value": 8192,   "rationale": "why" },
  { "action": "update_skill",        "agent_id": "id", "new_value": "new system prompt instructions", "rationale": "why" },
  { "action": "update_temperature",  "agent_id": "id", "new_value": 0.05,   "rationale": "why" }
]

Rules:
- Only suggest changes that directly address a measured failure
- For JSON parse errors: raise max_tokens or simplify schema
- For high retries: lower temperature or add explicit output format examples to skill
- For missing domains: check routing logic; suggest skill rewrite
- Return [] if the workflow is performing well`

export async function generateImprovements(
	evalResult: EvalResult,
	manifest: WorkflowManifest,
	result: WorkflowRunResult,
	apiUrl: string,
	model: string
): Promise<ImprovementAction[]> {
	if (evalResult.passed && evalResult.total_score > 0.9) return []

	const context = {
		workflow_id: manifest.id,
		eval_score: evalResult.total_score,
		threshold: manifest.evaluation.threshold,
		metrics: evalResult.metrics,
		feedback: evalResult.feedback,
		failed_agents: result.agent_results
			.filter(r => !r.success && !r.skipped)
			.map(r => ({ id: r.agent_id, error: r.error, attempts: r.attempts, duration_ms: r.duration_ms }))
	}

	const response = await ofetch(`${apiUrl}/v1/chat/completions`, {
		method: "POST",
		body: {
			model,
			messages: [
				{ role: "system", content: IMPROVEMENT_SYSTEM },
				{ role: "user", content: JSON.stringify(context, null, 2) }
			],
			temperature: 0.2,
			max_tokens: 2048,
			chat_template_kwargs: { enable_thinking: false },
		},
		retry: 0,
	})

	const raw: string = response.choices[0].message.content
	const cleaned = raw
		.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```\s*$/i, "").trim()

	try {
		return JSON.parse(cleaned) as ImprovementAction[]
	} catch {
		return []
	}
}