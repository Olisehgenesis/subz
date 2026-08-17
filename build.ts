import esbuild from "esbuild";
import copyStaticFiles from "esbuild-copy-static-files";
import { sassPlugin } from "esbuild-sass-plugin";
import { readFile, writeFile } from "node:fs/promises";
import type { BuildOptions } from "esbuild";

const outdir = "./dist/web";
const entries = ["index.js", "background.js", "tray.js"];

async function stripRemoteDiagnostics(): Promise<void> {
  for (const entry of entries) {
    const path = `${outdir}/${entry}`;
    const source = await readFile(path, "utf8").catch(() => null);
    if (source === null) continue;
    const sanitized = source.replaceAll("https://react.dev/errors/", "#react-error-");
    if (sanitized !== source) {
      await writeFile(path, sanitized);
    }
  }
}

const config: BuildOptions = {
  entryPoints: ["./src/index.tsx", "./src/background.ts", "./src/tray.tsx"],
  outdir,
  bundle: true,
  minify: true,
  external: [],
  format: "esm",
  jsx: "automatic",
  loader: { ".ts": "ts", ".tsx": "tsx", ".woff2": "file" },
  platform: "browser",
  plugins: [
    sassPlugin(),
    {
      name: "neutron-self-contained-assets",
      setup(build) {
        build.onEnd(async (result) => {
          if (result.errors.length === 0) {
            await stripRemoteDiagnostics();
          }
        });
      },
    },
    copyStaticFiles({
      src: "./public",
      dest: "./dist/web",
      dereference: true,
      errorOnExist: false,
      preserveTimestamps: true,
      recursive: true,
    }),
  ],
};

const args = process.argv.slice(2);

if (args[0] === "watch") {
  const ctx = await esbuild.context(config);
  await ctx.watch();

  console.log("Watching local files for changes...");
} else {
  try {
    await esbuild.build(config);
  } catch {
    process.exit(1);
  }
}
