import { defineConfig } from 'nitro'

export default defineConfig({
  serverDir: './server',
  runtimeConfig: {
    app: {
      version: '',
      buildTime: '',
    },
    public: {
      connectUrl: '',
      docUrl: '',
      matrixUrl: '',
      driveUrl: '',
    },
  },
})
