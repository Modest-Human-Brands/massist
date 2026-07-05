import unjs from 'eslint-config-unjs'

export default unjs({
  ignores: ['node_modules', '.output', 'static', 'old'],
  rules: {
    'unicorn/no-anonymous-default-export': 0,
  },
})
