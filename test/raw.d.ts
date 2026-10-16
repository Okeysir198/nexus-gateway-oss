// Vite's `?raw` suffix inlines a file as a string. Needed because these tests run inside
// workerd, where node:fs cannot read the fixture from disk.
declare module "*?raw" {
  const content: string;
  export default content;
}
