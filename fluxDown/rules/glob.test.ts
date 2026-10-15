import { describe, expect, test } from "bun:test";
import { hostMatches, urlGlobMatch } from "./glob";

describe("urlGlobMatch（对应 manifest.rs doctest）", () => {
  test("四个 doctest 断言", () => {
    expect(urlGlobMatch("*://www.youtube.com/watch*", "https://www.youtube.com/watch?v=abc")).toBe(true);
    expect(urlGlobMatch("*", "anything")).toBe(true);
    expect(urlGlobMatch("https://x.com/a", "https://x.com/a")).toBe(true);
    expect(urlGlobMatch("*://x.com/*", "https://y.com/a")).toBe(false);
  });

  test("分段顺序：*://x.com/*a*b", () => {
    expect(urlGlobMatch("*://x.com/*a*b", "https://x.com/xa_b")).toBe(true);
    expect(urlGlobMatch("*://x.com/*a*b", "https://x.com/b-a")).toBe(false);
  });

  test("大小写不敏感；无 * 时精确相等", () => {
    expect(urlGlobMatch("HTTPS://X.com/*", "https://x.COM/A")).toBe(true);
    expect(urlGlobMatch("https://x.com/a", "https://x.com/a/")).toBe(false);
  });
});

describe("hostMatches", () => {
  test("本域及子域，按标签边界", () => {
    expect(hostMatches("a.bilibili.com", "bilibili.com")).toBe(true);
    expect(hostMatches("bilibili.com", "bilibili.com")).toBe(true);
    expect(hostMatches("notbilibili.com", "bilibili.com")).toBe(false);
  });

  test("= 前缀只匹配本域；*. 前缀不支持", () => {
    expect(hostMatches("x.com", "=x.com")).toBe(true);
    expect(hostMatches("a.x.com", "=x.com")).toBe(false);
    expect(hostMatches("a.x.com", "*.x.com")).toBe(false);
  });
});
