import { describe, expect, test } from "bun:test";
import type { RulePack, RuleTier, SniffRuleV1 } from "./schema";
import { PackRejectedError, isSafeRegex, validatePack } from "./validate";

function rule(over: Partial<SniffRuleV1> & { id: string; tier: RuleTier }): SniffRuleV1 {
  return {
    version: 1,
    stage: "response",
    match: { ext: ["abc"] },
    action: { kind: "resource", type: "other" },
    ...over,
  } as SniffRuleV1;
}

function pack(packId: RuleTier, rules: SniffRuleV1[]): RulePack {
  return {
    format: "fluxdown-sniff-pack",
    packId,
    sequence: 1,
    engine: 1,
    issuedAt: "2026-01-01T00:00:00Z",
    rules,
  };
}

describe("isSafeRegex", () => {
  test("拒绝反向引用", () => {
    expect(isSafeRegex("(a)\\1")).toBe(false);
    expect(isSafeRegex("(?<n>a)\\k<n>")).toBe(false);
  });
  test("拒绝环视", () => {
    for (const p of ["a(?=b)", "a(?!b)", "(?<=a)b", "(?<!a)b"]) expect(isSafeRegex(p)).toBe(false);
  });
  test("拒绝嵌套量词与超长 / 非法正则", () => {
    expect(isSafeRegex("(a+)+")).toBe(false);
    expect(isSafeRegex("(?:a*)*")).toBe(false);
    expect(isSafeRegex("a".repeat(257))).toBe(false);
    expect(isSafeRegex("(")).toBe(false);
  });
  test("接受普通正则", () => {
    expect(isSafeRegex("[-_](\\d{4,6})\\.m4s(?:[?#]|$)")).toBe(true);
  });
});

describe("validatePack 单条剔除", () => {
  test("社区规则缺 host 被剔除，带 host 保留", () => {
    const r = validatePack(
      pack("community", [
        rule({ id: "community.aa", tier: "community" }),
        rule({ id: "community.bb", tier: "community", match: { host: ["x.com"] } }),
      ]),
      "community",
    );
    expect(r.pack.rules.map((x) => x.id)).toEqual(["community.bb"]);
    expect(r.rejected.map((x) => x.id)).toEqual(["community.aa"]);
  });

  test("社区规则使用 preempt 被剔除", () => {
    const r = validatePack(
      pack("community", [
        rule({
          id: "community.pp",
          tier: "community",
          stage: "body",
          match: { host: ["x.com"] },
          action: {
            kind: "extract",
            fields: { u: "u" },
            emit: { mode: "preempt", url: "${u}" },
          },
        }),
      ]),
      "community",
    );
    expect(r.pack.rules).toEqual([]);
  });

  test("stage 与 action 不匹配被剔除", () => {
    const r = validatePack(
      pack("local", [rule({ id: "local.aa", tier: "local", stage: "normalize" })]),
      "local",
    );
    expect(r.rejected[0]?.reason).toContain("不匹配");
  });

  test("模板引用未定义字段、id 重复被剔除", () => {
    const body = (id: string, url: string): SniffRuleV1 =>
      rule({
        id,
        tier: "official",
        stage: "body",
        action: { kind: "extract", fields: { u: "u" }, emit: { mode: "resource", url } },
      });
    const r = validatePack(
      pack("official", [body("official.aa", "${nope}"), body("official.bb", "${u}"), body("official.bb", "${u}")]),
      "official",
    );
    expect(r.pack.rules.map((x) => x.id)).toEqual(["official.bb"]);
    expect(r.rejected.length).toBe(2);
  });

  test("社区全局 strip-params 被剔除", () => {
    const r = validatePack(
      pack("community", [
        rule({
          id: "community.ss",
          tier: "community",
          stage: "normalize",
          match: {},
          action: { kind: "strip-params", params: ["x"] },
        }),
      ]),
      "community",
    );
    expect(r.pack.rules).toEqual([]);
  });
});

describe("validatePack 整包", () => {
  test("packId 不符 / engine 过新 / format 错误抛错", () => {
    expect(() => validatePack(pack("local", []), "official")).toThrow(PackRejectedError);
    expect(() => validatePack({ ...pack("local", []), engine: 2 }, "local")).toThrow(PackRejectedError);
    expect(() => validatePack({ ...pack("local", []), format: "x" } as never, "local")).toThrow(PackRejectedError);
  });
});
