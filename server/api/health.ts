import { defineEventHandler } from 'nitro/h3'

export default defineEventHandler(() => {
  // com.docker.compose.service || com.docker.swarm.task.name
  const node = process.env.HOSTNAME || 'unknown-node'

  return {
    status: 'OK',
    version: process.env.NITRO_APP_VERSION,
    buildTime: process.env.NITRO_APP_BUILD_TIME,
    node,
  }
})
