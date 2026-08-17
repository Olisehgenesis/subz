import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  generateAppMethodSchemaArtifact,
  validateAppMethodArgs,
} from "neutron-scripts/src/method_schema.js";
import { type NeutronManifest } from "neutron-tools/src/schema.js";
import { validate_neutron_conf } from "neutron-tools/src/validate_schema.js";

const manifestUrl = new URL("../neutron.json", import.meta.url);
const backendUrl = new URL("../backend/main.mo", import.meta.url);
const htmlUrl = new URL("../dist/web/index.html", import.meta.url);
const cssUrl = new URL("../dist/web/main.css", import.meta.url);

async function readManifest(): Promise<NeutronManifest> {
  return JSON.parse(await readFile(manifestUrl, "utf8")) as NeutronManifest;
}

test("subz manifest validates and declares its capability set", async () => {
  const manifest = await readManifest();
  const result = validate_neutron_conf(manifest);

  expect(result.valid).toBe(true);
  expect(manifest).toMatchObject({
    id: "subz",
    version: 200,
    src: "main.mo",
    capabilities: {
      vetkeys: {
        api: 1,
        slots: [{ id: "keys" }],
      },
      scheduled_tasks: {
        api: 1,
        tasks: [{ id: "expiry_monitor", method: "expiry_monitor" }],
      },
      chain_key_signing: {
        api: 1,
        slots: [{ id: "purge_receipts", algorithm: "ecdsa_secp256k1" }],
      },
    },
    memory: {
      subz: {
        version: 1,
      },
    },
  });
  expect(manifest).not.toHaveProperty("init_arg");
});

test("subz emits build-time method schemas for the vault API", async () => {
  const manifest = await readManifest();
  const backend = await readFile(backendUrl, "utf8");
  const artifact = generateAppMethodSchemaArtifact(manifest, backend);

  expect(artifact.methods.status).toMatchObject({ type: "query" });
  expect(artifact.methods.add_subscription).toMatchObject({
    type: "update",
    input: {
      type: "array",
      minItems: 1,
      maxItems: 1,
      prefixItems: [
        {
          type: "object",
        },
      ],
    },
  });
  expect(artifact.methods.expiry_monitor).toBeUndefined();
  expect(validateAppMethodArgs(artifact, "extend_subscription", ["openai"]).valid).toBe(true);
  expect(validateAppMethodArgs(artifact, "extend_subscription", []).valid).toBe(false);
});

test("subz bundles the shared design system stylesheet", async () => {
  const html = await readFile(htmlUrl, "utf8");
  const css = await readFile(cssUrl, "utf8");

  expect(html).toContain("./main.css");
  expect(css).toContain(".nt-app");
  expect(css).toContain(".nt-button");
  expect(css).toContain(".nt-metric");
  expect(css).toContain("--nt-bg-panel");
});
