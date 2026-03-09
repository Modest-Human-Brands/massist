import { readFileSync, readdirSync, existsSync } from "fs"
import { join, basename } from "path"

/* ============================================================ */
/*  Types                                                        */
/* ============================================================ */

export interface FlowManifest {
	id: string
	name: string
	description: string
	version?: string
	icon?: string
	tags?: string[]
	skillsDir: string      // relative to cwd
	requiresImage: boolean
	orchestratorType: string      // "visual" | "text" | "hybrid"
	concurrency?: number
	synthesisDomains?: string[]   // domain IDs forwarded to synthesis passes
}

export interface SkillMeta {
	id: string
	name: string
	file: string
	icon: string
	hint: string
	domainKey: string
	order: number
	isSynthesisPass: boolean
}

export interface LoadedSkill extends SkillMeta {
	content: string
}

/* ============================================================ */
/*  Flow Discovery                                              */
/* ============================================================ */

/**
 * Scan <baseDir> for subdirectories that contain a manifest.json.
 * Returns all valid flow manifests, sorted by name.
 */
export function loadFlows(baseDir: string): FlowManifest[] {
	if (!existsSync(baseDir)) return []

	const flows: FlowManifest[] = []

	for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue

		const manifestPath = join(baseDir, entry.name, "manifest.json")
		if (!existsSync(manifestPath)) continue

		try {
			const raw = readFileSync(manifestPath, "utf-8")
			const manifest = JSON.parse(raw) as FlowManifest
			flows.push(manifest)
		} catch {
			// skip malformed manifests silently
		}
	}

	return flows.sort((a, b) => a.name.localeCompare(b.name))
}

/* ============================================================ */
/*  Skill Loading — fully dynamic, no hardcoded catalog        */
/* ============================================================ */

/**
 * Dynamically load all skills from a directory.
 *
 * Metadata is read from YAML frontmatter; any missing field is
 * derived from the filename, so existing skill files work without
 * any frontmatter changes.
 *
 * Frontmatter field  Fallback derivation
 * ─────────────────  ──────────────────────────────────────────
 * id                 filename → strip numeric prefix, strip
 *                    "-analysis" suffix, dashes → underscores
 * name               frontmatter `name`, else titleCase(id)
 * icon               "🔍"
 * hint               frontmatter `description` or ""
 * domainKey          same as id
 * order              numeric prefix in filename (01-foo → 1)
 * isSynthesisPass    false unless frontmatter says true
 */
export function loadSkills(skillsDir: string): LoadedSkill[] {
	if (!existsSync(skillsDir)) return []

	const files = readdirSync(skillsDir).filter(
		f => f.endsWith(".md") && f !== "README.md" && f !== "00-index.md"
	)

	return files
		.map(file => parseSkillFile(join(skillsDir, file), file))
		.filter((s): s is LoadedSkill => s !== null)
		.sort((a, b) => a.order - b.order)
}

function parseSkillFile(fullPath: string, file: string): LoadedSkill | null {
	try {
		const raw = readFileSync(fullPath, "utf-8")
		const { frontmatter, body } = splitFrontmatter(raw)

		// Derive defaults from filename
		const fileBase = basename(file, ".md")
		const orderMatch = fileBase.match(/^(\d+)-/)
		const defaultOrder = orderMatch ? parseInt(orderMatch[1], 10) : 999

		const defaultId = fileBase
			.replace(/^\d+-/, "")          // strip "01-"
			.replace(/-analysis$/, "")     // strip "-analysis"
			.replace(/-/g, "_")            // "hair-analysis" → "hair"

		const id = str(frontmatter.id) ?? defaultId
		const name = str(frontmatter.name) ?? titleCase(id)
		const icon = str(frontmatter.icon) ?? "🔍"
		const hint = str(frontmatter.hint)
			?? str(frontmatter.description) ?? ""
		const domainKey = str(frontmatter.domainKey) ?? id
		const order = num(frontmatter.order) ?? defaultOrder
		const isSynthesisPass = bool(frontmatter.isSynthesisPass) ?? false

		return { id, name, file, icon, hint, domainKey, order, isSynthesisPass, content: body }
	} catch {
		return null
	}
}

/* ============================================================ */
/*  Frontmatter Parser — handles YAML subset used in skills     */
/* ============================================================ */

type FM = Record<string, unknown>

function splitFrontmatter(content: string): { frontmatter: FM; body: string } {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)/)
	if (!match) return { frontmatter: {}, body: content.trim() }
	return { frontmatter: parseYaml(match[1]), body: match[2].trim() }
}

/**
 * Minimal YAML parser — handles flat key: value pairs and
 * folded block scalars (description: >\n  ...). No arrays needed.
 */
function parseYaml(yaml: string): FM {
	const result: FM = {}
	const lines = yaml.split(/\r?\n/)
	let i = 0

	while (i < lines.length) {
		const line = lines[i]
		const keyMatch = line.match(/^(\w+)\s*:\s*(.*)$/)
		if (!keyMatch) { i++; continue }

		const key = keyMatch[1]
		let value = keyMatch[2].trim()

		// Folded block scalar `>`
		if (value === ">") {
			const block: string[] = []
			i++
			while (i < lines.length && (lines[i].startsWith("  ") || lines[i] === "")) {
				block.push(lines[i].replace(/^  /, ""))
				i++
			}
			result[key] = block.join(" ").replace(/\s+/g, " ").trim()
			continue
		}

		if (value === "true") { result[key] = true; i++; continue }
		if (value === "false") { result[key] = false; i++; continue }
		if (/^\d+$/.test(value)) { result[key] = parseInt(value, 10); i++; continue }

		// Strip surrounding quotes
		if ((value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1)
		}

		result[key] = value
		i++
	}

	return result
}

/* ============================================================ */
/*  Small helpers                                               */
/* ============================================================ */

function str(v: unknown): string | undefined {
	return typeof v === "string" && v ? v : undefined
}

function num(v: unknown): number | undefined {
	return typeof v === "number" ? v : undefined
}

function bool(v: unknown): boolean | undefined {
	return typeof v === "boolean" ? v : undefined
}

function titleCase(s: string): string {
	return s.replace(/_/g, " ").split(" ")
		.map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
}