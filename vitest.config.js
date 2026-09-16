const FULL = { statements: 100, branches: 100, functions: 100, lines: 100 };

module.exports = {
  test: {
    globals: true,
    include: ['tests/unit/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js', 'plugins/**/*.js', 'scripts/**/*.js'],
      reporter: ['text', 'json'],
      thresholds: {
        'plugins/flatten-folder/**': FULL,
        'src/main/utils/explorer-compare.js': FULL,
        'src/main/shell-menu/**': FULL,
      },
    },
  },
};
