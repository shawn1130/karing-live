// Minifies every emitted .js in dist in place: no source maps, no console or
// debugger, import paths left intact (tsc already wrote .js specifiers). The
// .d.ts are left readable -- they are the editor hover-docs, and a consumer's
// types cannot be hidden regardless.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { transform } from "esbuild";

const dist = new URL("../dist/", import.meta.url);
const files = (await readdir(dist)).filter((f) => f.endsWith(".js"));
const hasClientDirective = (code) => /^(?:"use client"|'use client');/.test(code);

for (const file of files) {
  const path = new URL(file, dist);
  const result = await transform(await readFile(path, "utf8"), {
    minify: true,
    format: "esm",
    drop: ["console", "debugger"],
    legalComments: "none",
  });
  let code = result.code;
  // Next.js and other RSC bundlers read this; re-add it if minify dropped it.
  if (file === "react.js" && !hasClientDirective(code)) code = `"use client";\n${code}`;
  await writeFile(path, code);
}

if (!hasClientDirective(await readFile(new URL("react.js", dist), "utf8"))) {
  throw new Error('dist/react.js is missing its "use client" directive');
}
console.log(`minified ${files.length} files`);
