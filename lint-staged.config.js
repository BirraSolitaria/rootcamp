// Pre-commit: validate the whole content tree when any content file is staged.
// A function command, so lint-staged does not append the staged file names.
export default {
  'content/**': () => 'pnpm content:validate',
};
