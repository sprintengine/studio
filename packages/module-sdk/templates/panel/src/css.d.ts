// esbuild's `--loader:.css=text` turns a CSS import into its text.
declare module '*.css' {
  const text: string
  export default text
}
