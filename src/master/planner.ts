import { ofetch } from "ofetch"
import type { MetaTask, WorkflowPlan } from "./types"

const SYSTEM_PROMPT = `You are a workflow architect for a local AI agent system.

Given a task description, design a multi-agent workflow following these standards:
- OpenAI Agents SDK agent types: router | analyst | synthesizer | generator | evaluator | judge
- Every workflow has exactly ONE entry agent of type "router"
- Analysts run in parallel; synthesizers run sequentially after all analysts complete
- Each agent's skill_description must be detailed enough to generate a complete LLM system prompt
- max_tokens: router=512, analyst=4096–8192, synthesizer=8192, evaluator=1024

Return ONLY valid JSON matching this exact schema — no preamble, no markdown fences:
{
  "workflow_id": "kebab-case-workflow-id",
  "workflow_name": "Human Readable Workflow Name",
  "description": "one-sentence description of what this workflow does",
  "entry_agent": "router-agent-id",
  "synthesis_domains": ["domain1", "domain2"],
  "rationale": "brief explanation of the design choices",
  "agents": [
    {
      "id": "agent-id",
      "name": "Agent Name",
      "type": "router | analyst | synthesizer | generator | evaluator",
      "description": "concise role description",
      "skill_description": "detailed instructions for the agent's system prompt — include output format, edge cases, examples",
      "input_domain": "what data/domain this agent receives",
      "output_domain": "domain key this agent writes to in the result object",
      "max_tokens": 512
    }
  ],
  "graph_description": "narrative of how agents connect and hand off to each other"
}`

export async function planWorkflow(
	task: MetaTask,
	apiUrl: string,
	model: string
): Promise<WorkflowPlan> {
	const lines = [
		`Task: ${task.description}`,
		`Input type: ${task.input_type}`,
		`Output type: ${task.output_type}`,
	]
	if (task.constraints?.length) {
		lines.push("Constraints:")
		task.constraints.forEach(c => lines.push(`  - ${c}`))
	}

	const response = await ofetch(`${apiUrl}/v1/chat/completions`, {
		method: "POST",
		body: {
			model,
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: lines.join("\n") }
			],
			temperature: 0.3,
			max_tokens: 4096,
			chat_template_kwargs: { enable_thinking: false },
		},
		retry: 0,
	})

	const raw: string = response.choices[0].message.content
	const cleaned = raw
		.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```\s*$/i, "").trim()

	const plan = JSON.parse(cleaned) as WorkflowPlan

	if (!plan.workflow_id || !plan.agents?.length) {
		throw new Error(`Planner returned invalid plan: missing workflow_id or agents`)
	}

	return plan
}