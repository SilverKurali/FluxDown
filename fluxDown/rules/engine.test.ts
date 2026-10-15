import { describe, expect, test } from "bun:test";
import cases from "./fixtures/engine-cases.json";
import { BUILTIN_PACK, compileBuiltin, compileRules, type CompiledRules } from "./engine";
import type { RuleOverrides, RulePack, RevocationDoc } from "./schema";
import { validatePack } from "./validate";

interface Setup {
  packs?: RulePack[];
  overrides?: RuleOverrides;
  revocations?: RevocationDoc | null;
  options?: { sniffImages?: boolean; communityEnabled?: boolean; now?: number };
}

interface Case {
  name: string;
  setup?: Setup;
  call: Exclude<keyof CompiledRules, "listRules" | "knownExtensions">;
  args: unknown[];
  expect: unknown;
}

const DEFAULT_NOW = Date.parse("2026-01-01T00:00:00Z");

function build(setup: Setup = {}): CompiledRules {
  return compileRules({
    packs: [BUILTIN_PACK, ...(setup.packs ?? [])],
    overrides: setup.overrides ?? {},
    revocations: setup.revocations ?? null,
    options: {
      sniffImages: setup.options?.sniffImages ?? false,
      communityEnabled: setup.options?.communityEnabled ?? true,
      now: setup.options?.now ?? DEFAULT_NOW,
    },
  });
}

describe("engine fixtures", () => {
  for (const c of cases as unknown as Case[]) {
    test(c.name, () => {
      const engine = build(c.setup);
      const fn = engine[c.call] as (...a: unknown[]) => unknown;
      const actual = fn.apply(engine, c.args);
      if (c.expect !== null && typeof c.expect === "object") {
        expect(actual).toMatchObject(c.expect as object);
      } else {
        expect(actual).toEqual(c.expect);
      }
    });
  }
});

describe("builtin 包", () => {
  test("自身通过校验且无剔除", () => {
    const { rejected, pack } = validatePack(BUILTIN_PACK, "builtin");
    expect(rejected).toEqual([]);
    expect(pack.rules.length).toBe(BUILTIN_PACK.rules.length);
  });

  test("compileBuiltin 全部规则生效", () => {
    const list = compileBuiltin().listRules();
    expect(list.length).toBe(BUILTIN_PACK.rules.length);
    expect(list.every((e) => e.status === "active")).toBe(true);
  });

  test("knownExtensions 含 mp4 与 jpg", () => {
    const known = compileBuiltin().knownExtensions();
    expect(known.has("mp4")).toBe(true);
    expect(known.has("jpg")).toBe(true);
  });
});

describe("listRules 状态", () => {
  test("engine 过新的包整包标记 engine-too-new", () => {
    const pack = {
      ...BUILTIN_PACK,
      packId: "official",
      engine: 99,
      rules: [{ ...BUILTIN_PACK.rules[0], id: "official.future", tier: "official" }],
    } as unknown as RulePack;
    const list = compileRules({
      packs: [pack],
      overrides: {},
      revocations: null,
      options: { sniffImages: false, communityEnabled: true, now: DEFAULT_NOW },
    }).listRules();
    expect(list.map((e) => e.status)).toEqual(["engine-too-new"]);
  });
});
