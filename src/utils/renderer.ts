import chalk from "chalk"

/* ============================================================ */
/* Types                                                        */
/* ============================================================ */

export interface AgentResult {
	agent: string
	domain: string
	success: boolean
	duration_ms: number
	attempts: number
	skipped?: boolean
	error?: string
}

export interface AnalysisResults {
	agent_results: AgentResult[]
	duration_ms: number
	domains: Record<string, unknown>
}

/* ============================================================ */
/* Banner                                                       */
/* ============================================================ */

export function renderBanner(): void {
	console.log()
	console.log(chalk.bold.magenta("  ███╗   ███╗ █████╗ ███████╗███████╗██╗███████╗████████╗"))
	console.log(chalk.bold.magenta("  ████╗ ████║██╔══██╗██╔════╝██╔════╝██║██╔════╝╚══██╔══╝"))
	console.log(chalk.bold.cyan("  ██╔████╔██║███████║███████╗███████╗██║███████╗   ██║   "))
	console.log(chalk.bold.cyan("  ██║╚██╔╝██║██╔══██║╚════██║╚════██║██║╚════██║   ██║   "))
	console.log(chalk.bold.blue("  ██║ ╚═╝ ██║██║  ██║███████║███████║██║███████║   ██║   "))
	console.log(chalk.bold.blue("  ╚═╝     ╚═╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝╚══════╝   ╚═╝   "))
	console.log(chalk.dim("  Visual Intelligence Pipeline — Dynamic Routing Enabled"))
	console.log()
}

/* ============================================================ */
/* Interactive Live Board                                       */
/* ============================================================ */

export class AgentBoard {
	private states: Record<string, string> = {}
	private names: Record<string, string> = {}
	private spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
	private frame = 0
	private interval: NodeJS.Timeout | null = null
	private linesCount = 0

	start(agents: { id: string; name: string }[]) {
		for (const a of agents) {
			this.states[a.id] = "pending"
			this.names[a.id] = a.name
		}

		process.stdout.write("\x1B[?25l")
		this.interval = setInterval(() => {
			this.frame = (this.frame + 1) % this.spinnerFrames.length
			this.render()
		}, 80)
	}

	update(id: string, state: string) {
		this.states[id] = state
		this.render()
	}

	stop() {
		if (this.interval) clearInterval(this.interval)
		this.render()
		process.stdout.write("\x1B[?25h")
	}

	private render() {
		if (this.linesCount > 0) {
			process.stdout.write(`\x1b[${this.linesCount}A\x1b[0J`)
		}

		let text = "\n" + chalk.bold("  Pipeline Execution:") + "\n"

		const stateToIcon = (state: string) => {
			switch (state) {
				case "pending": return chalk.dim("○")
				case "running": return chalk.cyan(this.spinnerFrames[this.frame])
				case "retrying": return chalk.yellow(this.spinnerFrames[this.frame])
				case "done": return chalk.green("✓")
				case "error": return chalk.red("✗")
				case "skipped": return chalk.dim("⊘")
				default: return chalk.dim("○")
			}
		}

		const stateToColor = (state: string, label: string) => {
			switch (state) {
				case "running": return chalk.white(label)
				case "retrying": return chalk.yellow(label)
				case "done": return chalk.gray(label)
				case "error": return chalk.red(label)
				case "skipped": return chalk.dim.strikethrough(label)
				default: return chalk.dim(label)
			}
		}

		for (const [id, state] of Object.entries(this.states)) {
			const label = (this.names[id] || id).padEnd(26)
			const statusLabel = state === "skipped" ? chalk.dim("bypassed by triage") : chalk.dim(state)
			text += `    ${stateToIcon(state)} ${stateToColor(state, label)} ${statusLabel}\n`
		}

		process.stdout.write(text)
		this.linesCount = (text.match(/\n/g) || []).length
	}

	public renderResultSummary(results: AnalysisResults) {
		const skippedCount = results.agent_results.filter(r => r.skipped).length

		console.log()
		console.log(chalk.bold.cyan("  ┌─ Agent Results " + "─".repeat(50)))

		for (const r of results.agent_results) {
			let icon = r.success ? chalk.green("✓") : chalk.red("✗")
			if (r.skipped) icon = chalk.dim("⊘")

			const label = chalk.white(r.agent.padEnd(28))
			let durStr = r.skipped ? "0ms" : (r.duration_ms >= 10000 ? `${(r.duration_ms / 1000).toFixed(1)}s` : `${r.duration_ms}ms`)
			const dur = chalk.dim(durStr.padStart(8))
			const retries = r.attempts > 1 ? chalk.dim(` ×${r.attempts}`) : "    "

			let status = r.success ? chalk.green("complete") : chalk.red(r.error?.slice(0, 38) ?? "error")
			if (r.skipped) status = chalk.dim("skipped by triage")

			console.log(`  │  ${icon} ${label} ${dur}${retries}  ${status}`)
		}

		console.log(chalk.bold.cyan("  └─" + "─".repeat(64)))
		console.log()

		const totalSeconds = (results.duration_ms / 1000).toFixed(1)
		console.log(chalk.bold(`  ✨ Completed in ${totalSeconds}s (${skippedCount} irrelevant agents optimized out)`))
		console.log()
	}
}