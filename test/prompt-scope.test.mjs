import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { createScope } from "@deepseek-ai/dsh-scope";
import SystemPrompt, { renderPrompt } from "@deepseek-ai/dsh-system-prompt";
import Tools from "@deepseek-ai/dsh-tools";

// Mount the actual plugin without starting its background environment/network probe.
const entry = new URL("../lib/index.js", import.meta.url);
const envcheck = new URL("./envcheck.js", entry);
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === entry.href && specifier === "./envcheck.js") {
      const source = `export * from ${JSON.stringify(envcheck.href)}; export async function getEnvReport() {}`;
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(source) };
    }
    return next(specifier, context);
  },
});
const bilibili = await import(entry.href).finally(() => hook.deregister());

test("Bilibili guidance follows each agent's current extract capability", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-bilibili-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const template = "{{literal_custom_summary}}";
  const summaryTemplate = join(dir, "summary.md");
  await writeFile(summaryTemplate, template);

  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SystemPrompt, {});
  await ctx.plugin(Tools, { mode: "native" });
  await ctx.plugin(bilibili, { summaryTemplate });

  const parent = { id: "main" };
  const child = { id: "child" };
  let parentScope, childScope;
  await ctx.plugin({
    inject: ["tools", "systemPrompt"],
    apply(inner) {
      parentScope = createScope(inner, parent);
      childScope = createScope(inner, child);
    },
  });

  async function expectGuidance(agent, visible) {
    const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent });
    assert.equal(assembly.tools.some(tool => tool.name === "bilibili_extract"), visible, agent.id + " tool visibility");
    const prompt = renderPrompt(assembly);
    assert.equal(prompt.includes("Use the bilibili_extract tool"), visible, agent.id + " guidance");
    assert.equal(prompt.includes(template), visible, agent.id + " literal template");
  }

  // Child composition can narrow inherited tools before its first assembly.
  const resetChild = childScope.ctx.tools.restrict({ allow: [] });
  await expectGuidance(parent, true);
  await expectGuidance(child, false);

  // Having another Bilibili tool does not grant extraction guidance.
  resetChild();
  childScope.ctx.tools.restrict({ allow: ["bilibili_login"] });
  await expectGuidance(child, false);

  // On-demand policy can change on the same live agent between model steps.
  const unfold = parentScope.ctx.tools.restrict({ deny: ["bilibili_extract"] });
  await expectGuidance(parent, false);
  unfold();
  await expectGuidance(parent, true);
  await expectGuidance(child, false);
});
