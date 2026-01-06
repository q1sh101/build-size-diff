module.exports = {
  semi: true,
  tabWidth: 2,
  singleQuote: true,
  printWidth: 80,
  trailingComma: 'es5',
  htmlWhitespaceSensitivity: 'ignore',
  overrides: [
    {
      files: '*.html',
      options: {
        printWidth: 500,
      },
    },
  ],
};
