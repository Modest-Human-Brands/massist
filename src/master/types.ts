// ─────────────────────────────────────────────────────────────────────────────
// Core scalar types
// ─────────────────────────────────────────────────────────────────────────────

export type AgentType = "router" | "analyst" | "synthesizer" | "generator" | "evaluator" | "judge"
export type SkillType = "routing" | "analysis" | "synthesis" | "generation" | "evaluation"
export type NodeType = "router" | "parallel" | "sequential" | "conditional" | "terminal"
export type InputType = "image" | "text" | "json" | "mixed"
export type OutputType = "json" | "image" | "text" | "mixed"

// ─────────────────────────────────────────────────────────────────────────────
// MCP-compatible tool definition
// ─────────────────────────────────────────────────────────────────────────────

export interface JSONSchema {
	type: string
	properties?: Record<string, JSONSchema>
	items?: JSONSchema
	required?: string[]
	description?: string
	enum?: unknown[]
}

export interface ToolDefinition {
	name: string
	description: string
	input_schema: JSONSchema
}

// ─────────────────────────────────────────────────────────────────────────────
// Handoff — OpenAI Agents SDK compatible
// ─────────────────────────────────────────────────────────────────────────────

export interface HandoffConfig {
	target: string          // agent id to hand off to
	condition?: string      // JS expression evaluated at runtime; receives `domains: string[]`
	description?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent config — stored as JSON at workflows/<id>/agents/<agent-id>.json
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentConfig {
	id: string
	name: string
	version: string
	description: string
	model: string
	type: AgentType
	instructions_skill: string   // skill id — the matching skill file becomes the system prompt
	tools: ToolDefinition[]
	handoffs: HandoffConfig[]
	input_schema: JSONSchema
	output_schema: JSONSchema
	max_tokens: number
	temperature: number
	created_at: string
	updated_at: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow graph
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkflowNode {
	id: string
	agent: string               // agent id
	type: NodeType
	depends_on?: string[]       // node ids that must complete before this runs
}

export interface WorkflowEdge {
	from: string
	to: string
	condition?: string          // JS expression; receives `domains: string[]`
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────────────

export interface EvalMetric {
	name: string
	score: number               // 0–1
	weight: number
	details?: string
}

export interface EvalResult {
	total_score: number         // weighted average of metrics
	metrics: EvalMetric[]
	passed: boolean
	feedback: string[]          // actionable improvement suggestions
	timestamp: string
}

export type ImprovementAction =
	| { action: "update_token_budget"; agent_id: string; new_value: number; rationale: string }
	| { action: "update_skill"; agent_id: string; new_value: string; rationale: string }
	| { action: "update_temperature"; agent_id: string; new_value: number; rationale: string }
	| { action: "update_schema"; agent_id: string; new_value: JSONSchema; rationale: string }

// ─────────────────────────────────────────────────────────────────────────────
// Test case
// ─────────────────────────────────────────────────────────────────────────────

export interface TestCase {
	id: string
	description: string
	input: Record<string, unknown>
	expected_output_schema: JSONSchema
	expected_domains?: string[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflow manifest — extends the existing flows/*/manifest.json format
// Stored at workflows/<id>/manifest.json
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkflowManifest {
	// ── Existing fields (backward compat with loadFlows) ──────────────────────
	id: string
	name: string
	description: string
	skillsDir: string            // relative to cwd: "skills/<id>"
	requiresImage: boolean
	orchestratorType: string
	concurrency: number
	synthesisDomains: string[]

	// ── Extended fields ───────────────────────────────────────────────────────
	version: string
	icon?: string
	tags?: string[]
	agents: string[]             // agent ids in this workflow
	graph: {
		entry: string              // entry agent id
		nodes: WorkflowNode[]
		edges: WorkflowEdge[]
	}
	evaluation: {
		metrics: string[]
		threshold: number
		last_eval?: EvalResult
	}
	tests: string[]              // test case ids
	stats: {
		runs: number
		successes: number
		avg_duration_ms: number
		last_run?: string
	}
	created_at: string
	updated_at: string
	generated_by: "meta-agent" | "human"
}

// ─────────────────────────────────────────────────────────────────────────────
// Task given to MetaAgent
// ─────────────────────────────────────────────────────────────────────────────

export interface MetaTask {
	description: string
	input_type: InputType
	output_type: OutputType
	constraints?: string[]
	force_recreate?: boolean     // ignore existing workflow, plan from scratch
}

// ─────────────────────────────────────────────────────────────────────────────
// Intermediate plan (used during workflow generation, not persisted)
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentPlan {
	id: string
	name: string
	type: AgentType
	description: string
	skill_description: string   // prompt engineering instructions for the skill file
	input_domain: string
	output_domain: string
	max_tokens: number
}

export interface WorkflowPlan {
	workflow_id: string
	workflow_name: string
	description: string
	entry_agent: string
	synthesis_domains: string[]
	agents: AgentPlan[]
	graph_description: string
	rationale: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime results
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentRunResult {
	agent_id: string
	agent_name: string
	domain: string
	success: boolean
	duration_ms: number
	attempts: number
	skipped?: boolean
	data?: unknown
	error?: string
}

export interface WorkflowRunResult {
	workflow_id: string
	domains: Record<string, unknown>
	duration_ms: number
	agent_results: AgentRunResult[]
	eval_result?: EvalResult
}