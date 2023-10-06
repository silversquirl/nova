import path from "path";

export async function buildHmr(): Promise<string> {
  const result = await Bun.build({
    entrypoints: [path.join(import.meta.dir, "hmr.js")],
    target: "browser",
    minify: true,
  });
  if (!result.success) {
    console.error("Build failed!");
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error("build failed");
  }
  return await result.outputs[0].text();
}
