import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs"
import { join, resolve } from "path"
import type { WorkflowManifest, AgentConfig, TestCase, EvalResult } from "./types"

export const PATHS = {
	workflows: resolve(process.cwd(), "workflows"),
	skills: resolve(process.cwd(), "skills"),
	tests: resolve(process.cwd(), "tests"),
	artifact: resolve(process.cwd(), "artifact"),
} as const

function readJson<T>(path: string): T | null {
	if (!existsSync(path)) return null
	try { return JSON.parse(readFileSync(path, "utf-8")) as T }
	catch { return null }
}

function writeJson(path: string, data: unknown): void {
	writeFileSync(path, JSON.stringify(data, null, 2))
}

// ─────────────────────────────────────────────────────────────────────────────
// Workflows
// ─────────────────────────────────────────────────────────────────────────────

export function listWorkflows(): string[] {
	if (!existsSync(PATHS.workflows)) return []
	return readdirSync(PATHS.workflows, { withFileTypes: true })
		.filter(e => e.isDirectory() && existsSync(join(PATHS.workflows, e.name, "manifest.json")))
		.map(e => e.name)
}

export function loadWorkflow(id: string): WorkflowManifest | null {
	return readJson<WorkflowManifest>(join(PATHS.workflows, id, "manifest.json"))
}

export function saveWorkflow(manifest: WorkflowManifest): void {
	const dir = join(PATHS.workflows, manifest.id)
	mkdirSync(dir, { recursive: true })
	writeJson(join(dir, "manifest.json"), manifest)
}

export function updateWorkflowStats(
	id: string,
	success: boolean,
	duration_ms: number,
	evalResult?: EvalResult
): void {
	const manifest = loadWorkflow(id)
	if (!manifest) return

	const s = manifest.stats
	s.runs++
	if (success) s.successes++
	s.avg_duration_ms = s.runs === 1
		? duration_ms
		: Math.round((s.avg_duration_ms * (s.runs - 1) + duration_ms) / s.runs)
	s.last_run = new Date().toISOString()

	manifest.updated_at = new Date().toISOString()
	if (evalResult) manifest.evaluation.last_eval = evalResult

	saveWorkflow(manifest)
}

export function bumpWorkflowVersion(id: string): void {
	const manifest = loadWorkflow(id)
	if (!manifest) return
	const [major, minor, patch] = manifest.version.split(".").map(Number)
	manifest.version = `${major}.${minor}.${patch + 1}`
	manifest.updated_at = new Date().toISOString()
	saveWorkflow(manifest)
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent configs
// ─────────────────────────────────────────────────────────────────────────────

export function loadAgentConfig(workflowId: string, agentId: string): AgentConfig | null {
	return readJson<AgentConfig>(join(PATHS.workflows, workflowId, "agents", `${agentId}.json`))
}

export function saveAgentConfig(workflowId: string, config: AgentConfig): void {
	const dir = join(PATHS.workflows, workflowId, "agents")
	mkdirSync(dir, { recursive: true })
	writeJson(join(dir, `${config.id}.json`), config)
}

export function loadAllAgentConfigs(workflowId: string): AgentConfig[] {
	const dir = join(PATHS.workflows, workflowId, "agents")
	if (!existsSync(dir)) return []
	return readdirSync(dir)
		.filter(f => f.endsWith(".json"))
		.flatMap(f => {
			const c = readJson<AgentConfig>(join(dir, f))
			return c ? [c] : []
		})
}

export function updateAgentConfig(workflowId: string, agentId: string, patch: Partial<AgentConfig>): void {
	const config = loadAgentConfig(workflowId, agentId)
	if (!config) return
	saveAgentConfig(workflowId, { ...config, ...patch, updated_at: new Date().toISOString() })
}

// ─────────────────────────────────────────────────────────────────────────────
// Skills (raw file read/write — metadata is in YAML frontmatter)
// ─────────────────────────────────────────────────────────────────────────────

export function readSkillFile(workflowId: string, agentId: string): string | null {
	const dir = join(PATHS.skills, workflowId)
	if (!existsSync(dir)) return null
	const files = readdirSync(dir).filter(f => f.endsWith(`${agentId}.md`) || f.endsWith(`-${agentId}.md`))
	if (files.length === 0) return null
	return readFileSync(join(dir, files[0]), "utf-8")
}

export function writeSkillFile(workflowId: string, filename: string, content: string): void {
	const dir = join(PATHS.skills, workflowId)
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, filename), content)
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

export function loadTestCase(workflowId: string, testId: string): TestCase | null {
	return readJson<TestCase>(join(PATHS.tests, workflowId, `${testId}.json`))
}

export function saveTestCase(workflowId: string, test: TestCase): void {
	const dir = join(PATHS.tests, workflowId)
	mkdirSync(dir, { recursive: true })
	writeJson(join(dir, `${test.id}.json`), test)
}

export function loadAllTests(workflowId: string): TestCase[] {
	const dir = join(PATHS.tests, workflowId)
	if (!existsSync(dir)) return []
	return readdirSync(dir)
		.filter(f => f.endsWith(".json"))
		.flatMap(f => {
			const t = readJson<TestCase>(join(dir, f))
			return t ? [t] : []
		})
}