export function isAssetFile(filename: string): boolean {
  const extensions = ['.js', '.css', '.mjs', '.cjs'];
  const exclude = ['.map'];
  const lower = filename.toLowerCase();

  return (
    extensions.some((ext) => lower.endsWith(ext)) &&
    !exclude.some((ext) => lower.endsWith(ext))
  );
}
