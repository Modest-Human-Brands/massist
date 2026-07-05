import { defineEventHandler, HTTPError, getRouterParam } from 'nitro/h3'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { generateText, tool, stepCountIs } from 'ai'
import { google } from '@ai-sdk/google'
import { z } from 'zod'
import { $fetch } from 'ofetch'

// const ProjectSummarySchema = z.object({
//   projectId: z.string(),
//   clientName: z.string().nullable(),
//   documentMetrics: z.object({ total: z.number(), completed: z.number(), voided: z.number() }),
//   financials: z.object({ totalDeliverablesValue: z.number(), currency: z.string() }),
//   executiveSummary: z.string(),
//   documents: z.array(z.object({ id: z.string(), name: z.string(), status: z.string(), summary: z.string() }))
// });

// HARDENED PROMPT: explicit next-action + explicit stop condition
const RESEARCHER_PROMPT = (id: string) => `You are a Data Retrieval Agent for project ${id}. Your process is:
1. Call 'fetchProjectDocumentList' to get every document in the project.
2. Call 'fetchDocumentDetails' once for EVERY document id returned in step 1. Do not skip any, and do not stop until every id has been fetched.
3. Once all documents are fetched, write a report summarizing the contents, including document names, statuses, and any financial figures you find.`

const LLM_MODEL = google('gemini-3.1-flash-lite')

export default defineEventHandler(async (event) => {
  const projectId = getRouterParam(event, 'projectId')
  const config = useRuntimeConfig()

  if (!projectId) throw new HTTPError({ statusCode: 400, statusMessage: 'projectId required' })

  // PASS 1: Agentic Retrieval
  const { text: researchNotes, steps } = await generateText({
    model: LLM_MODEL,
    system: RESEARCHER_PROMPT(projectId),
    prompt: `Research all documents for project: ${projectId}`,
    // generateText only runs ONE step by default (one round of tool calls, then it returns
    // whatever text/tool-results it got). stopWhen is what turns it into an actual loop:
    // after each step that ends in tool results, the SDK feeds those results back to the
    // model and asks it to continue, repeating until the model answers with plain text
    // (no further tool calls) or this cap is hit.
    stopWhen: stepCountIs(30), // 1 list call + up to ~28 detail calls + 1 final summary step
    tools: {
      fetchProjectDocumentList: tool({
        description: 'Get all document IDs for the project.',
        inputSchema: z.object({}),
        execute: async () => {
          const response = await $fetch('/api/document', { baseURL: config.public.docUrl })

          const filteredResponse = response.results.filter((d: any) => d.project?.slug === projectId).map((d: any) => ({ id: d.id, name: d.name }))
          console.log({ filteredResponse })

          return filteredResponse
        },
      }),
      fetchDocumentDetails: tool({
        description: 'Fetch details for a specific document ID. MUST be called for every ID from the list.',
        inputSchema: z.object({ documentId: z.string() }),
        // FIX: schema field is `documentId`, not `id` — the old `{ id: documentId }`
        // destructure pulled undefined and every call hit /api/document/undefined
        execute: async ({ documentId }) => {
          const response = await $fetch(`/api/document/${documentId}`, { baseURL: config.public.docUrl })
          console.log({ docInfo: response })

          return { id: response.id, status: response.status, rawData: response.rawData }
        },
      }),
    },
    onStepFinish({ stepNumber, toolCalls, finishReason }) {
      console.log(
        `[Phase 1] step ${stepNumber} finished (${finishReason})`,
        toolCalls?.map((c) => c.toolName)
      )
    },
  })

  console.log(`[Phase 1] Completed in ${steps.length} steps`)

  // PASS 2: Synthesis
  console.log(`[Phase 2] Structuring data. Research Notes length: ${researchNotes.length}`)
  const { text } = await generateText({
    model: LLM_MODEL,
    // schema: ProjectSummarySchema,
    system: 'Convert the provided research report.',
    prompt: `Report:\n${researchNotes}`,
  })

  return { success: true, data: text }
})
