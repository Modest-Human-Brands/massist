import { mkdirSync } from "fs"
import { join } from "path"
import { ofetch } from "ofetch"
import type {
	WorkflowPlan, AgentPlan, AgentConfig, WorkflowManifest,
	WorkflowNode, WorkflowEdge, JSONSchema
} from "./types"
import {
	saveAgentConfig, saveWorkflow, saveTestCase, writeSkillFile, PATHS
} from "./registry"

// ─────────────────────────────────────────────────────────────────────────────
// Skill generation
// ─────────────────────────────────────────────────────────────────────────────

const SKILL_SYSTEM = `You are an expert AI agent prompt engineer specialising in structured JSON output.

Write a complete system prompt for an AI agent. The prompt must:
1. State the agent's role and expertise in the first sentence
2. Enumerate exactly what the agent must analyse or produce
3. Specify the exact JSON output schema with field names and types
4. Provide at least one edge-case handling rule
5. End with: "Return ONLY valid JSON — no markdown, no explanation."

Return ONLY the system prompt text. No markdown fences. No preamble.`

async function generateSkillContent(
	agent: AgentPlan,
	outputSchema: JSONSchema,
	apiUrl: string,
	model: string
): Promise<string> {
	const userPrompt = [
		`Role: ${agent.description}`,
		`Detailed instructions: ${agent.skill_description}`,
		`Output JSON schema:\n${JSON.stringify(outputSchema, null, 2)}`,
		"",
		"Write the complete system prompt for this agent.",
	].join("\n")

	const response = await ofetch(`${apiUrl}/v1/chat/completions`, {
		method: "POST",
		body: {
			model,
			messages: [
				{ role: "system", content: SKILL_SYSTEM },
				{ role: "user", content: userPrompt }
			],
			temperature: 0.2,
			max_tokens: 3000,
			chat_template_kwargs: { enable_thinking: false },
		},
		retry: 0,
	})

	return response.choices[0].message.content.trim()
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema inference
// ─────────────────────────────────────────────────────────────────────────────

function outputSchemaFor(agent: AgentPlan): JSONSchema {
	if (agent.type === "router") {
		return {
			type: "object",
			description: "Triage routing result",
			properties: {
				active_domains: {
					type: "array",
					items: { type: "string" },
					description: "Domain IDs that should be analysed"
				}
			},
			required: ["active_domains"]
		}
	}

	return {
		type: "object",
		description: `Analysis results for the ${agent.output_domain} domain`,
		properties: {
			[agent.output_domain]: {
				type: "object",
				description: `Structured ${agent.output_domain} analysis`
			}
		},
		required: [agent.output_domain]
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Graph construction
// ─────────────────────────────────────────────────────────────────────────────

function buildGraph(plan: WorkflowPlan): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
	const nodes: WorkflowNode[] = []
	const edges: WorkflowEdge[] = []

	const router = plan.agents.find(a => a.type === "router") ?? plan.agents[0]
	const analysts = plan.agents.filter(a => a.type === "analyst")
	const synths = plan.agents.filter(a => a.type === "synthesizer" || a.type === "generator")
	const evaluator = plan.agents.find(a => a.type === "evaluator")

	nodes.push({ id: router.id, agent: router.id, type: "router" })

	for (const a of analysts) {
		nodes.push({ id: a.id, agent: a.id, type: "parallel", depends_on: [router.id] })
		edges.push({
			from: router.id,
			to: a.id,
			condition: `domains.includes('${a.output_domain}')`
		})
	}

	const analystIds = analysts.map(a => a.id)
	for (const s of synths) {
		nodes.push({ id: s.id, agent: s.id, type: "sequential", depends_on: analystIds })
		edges.push({ from: "__parallel_join__", to: s.id })
	}

	if (evaluator) {
		const lastSynth = synths[synths.length - 1]
		nodes.push({ id: evaluator.id, agent: evaluator.id, type: "terminal" })
		edges.push({ from: lastSynth?.id ?? router.id, to: evaluator.id })
	}

	return { nodes, edges }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: build the full workflow from a plan
// ─────────────────────────────────────────────────────────────────────────────

export async function buildWorkflowFromPlan(
	plan: WorkflowPlan,
	apiUrl: string,
	model: string
): Promise<WorkflowManifest> {
	const now = new Date().toISOString()
	const skillsDir = `skills/${plan.workflow_id}`
	mkdirSync(join(PATHS.skills, plan.workflow_id), { recursive: true })

	for (const [idx, agentPlan] of plan.agents.entries()) {
		const outputSchema = outputSchemaFor(agentPlan)
		const skillContent = await generateSkillContent(agentPlan, outputSchema, apiUrl, model)
		const skillFilename = `${String(idx + 1).padStart(2, "0")}-${agentPlan.id}.md`

		// Skill file: YAML frontmatter + generated system prompt as body
		const frontmatter = [
			"---",
			`id: ${agentPlan.id}`,
			`name: "${agentPlan.name}"`,
			`version: "1.0.0"`,
			`type: ${agentPlan.type === "router" ? "routing" : agentPlan.type === "synthesizer" ? "synthesis" : "analysis"}`,
			`description: "${agentPlan.description.replace(/"/g, "'")}"`,
			`domainKey: ${agentPlan.output_domain}`,
			`order: ${idx + 1}`,
			`isSynthesisPass: ${agentPlan.type === "synthesizer" || agentPlan.type === "generator"}`,
			`created_at: "${now}"`,
			`updated_at: "${now}"`,
			"---",
		].join("\n")

		writeSkillFile(plan.workflow_id, skillFilename, `${frontmatter}\n\n${skillContent}`)

		// Agent config (OpenAI Agents SDK compatible)
		const agentConfig: AgentConfig = {
			id: agentPlan.id,
			name: agentPlan.name,
			version: "1.0.0",
			description: agentPlan.description,
			model,
			type: agentPlan.type,
			instructions_skill: agentPlan.id,
			tools: [],
			handoffs: [],
			input_schema: {
				type: "object",
				properties: {
					image_base64: { type: "string", description: "Base64-encoded image" },
					context: { type: "object", description: "Upstream domain results" }
				}
			},
			output_schema: outputSchema,
			max_tokens: agentPlan.max_tokens,
			temperature: 0.1,
			created_at: now,
			updated_at: now,
		}

		saveAgentConfig(plan.workflow_id, agentConfig)
	}

	const { nodes, edges } = buildGraph(plan)

	const manifest: WorkflowManifest = {
		id: plan.workflow_id,
		name: plan.workflow_name,
		version: "1.0.0",
		description: plan.description,
		icon: "🤖",
		tags: [],
		skillsDir,
		requiresImage: true,
		orchestratorType: "visual",
		concurrency: 4,
		synthesisDomains: plan.synthesis_domains,
		agents: plan.agents.map(a => a.id),
		graph: { entry: plan.entry_agent, nodes, edges },
		evaluation: {
			metrics: ["output_completeness", "json_validity", "agent_success_rate", "retry_rate"],
			threshold: 0.75,
		},
		tests: ["smoke-test"],
		stats: { runs: 0, successes: 0, avg_duration_ms: 0 },
		created_at: now,
		updated_at: now,
		generated_by: "meta-agent",
	}

	saveWorkflow(manifest)

	// Seed an initial smoke test
	const domainSchema = plan.synthesis_domains.reduce(
		(acc, d) => ({ ...acc, [d]: { type: "object" } }),
		{} as Record<string, JSONSchema>
	)
	saveTestCase(plan.workflow_id, {
		id: "smoke-test",
		description: "Auto-generated smoke test — verifies all synthesis domains are present",
		input: { image_path: "temp/test.jpg" },
		expected_output_schema: { type: "object", properties: domainSchema },
		expected_domains: plan.synthesis_domains,
	})

	return manifest
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: rewrite a single skill file (used by evaluator improvements)
// ─────────────────────────────────────────────────────────────────────────────

export async function regenerateSkill(
	workflowId: string,
	agentId: string,
	newSkillDescription: string,
	apiUrl: string,
	model: string
): Promise<void> {
	const agentPlan: AgentPlan = {
		id: agentId,
		name: agentId,
		type: "analyst",
		description: newSkillDescription,
		skill_description: newSkillDescription,
		input_domain: agentId,
		output_domain: agentId,
		max_tokens: 6144,
	}
	const schema = outputSchemaFor(agentPlan)
	const content = await generateSkillContent(agentPlan, schema, apiUrl, model)
	const now = new Date().toISOString()

	const frontmatter = [
		"---",
		`id: ${agentId}`,
		`name: "${agentId}"`,
		`version: "1.0.0"`,
		`type: analysis`,
		`isSynthesisPass: false`,
		`updated_at: "${now}"`,
		"---",
	].join("\n")

	// Find and overwrite the matching skill file
	const { readdirSync, existsSync } = await import("fs")
	const { join } = await import("path")
	const dir = join(PATHS.skills, workflowId)
	if (!existsSync(dir)) return
	const existing = readdirSync(dir).find(f => f.endsWith(`-${agentId}.md`) || f === `${agentId}.md`)
	const filename = existing ?? `${agentId}.md`
	writeSkillFile(workflowId, filename, `${frontmatter}\n\n${content}`)
}