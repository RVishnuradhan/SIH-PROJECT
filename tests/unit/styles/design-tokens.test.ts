import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/*
 * Guards the design tokens in globals.css: every PRD status state exists
 * (PRD §59) and every text/background pair meets WCAG AA contrast (4.5:1).
 */

const css = readFileSync(path.resolve(import.meta.dirname, "../../../src/app/globals.css"), "utf8");

function rootTokens(source: string): Map<string, string> {
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(source)?.[1] ?? "";
  const tokens = new Map<string, string>();
  for (const match of root.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    tokens.set(match[1]!, match[2]!.trim());
  }
  return tokens;
}

const tokens = rootTokens(css);

/** OKLCH → sRGB (0–1), per the CSS Color 4 reference matrices. */
function oklchToSrgb(value: string): [number, number, number] {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (!match) throw new Error(`Not an oklch() colour: ${value}`);
  const [L, C, h] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const encode = (x: number) =>
    Math.min(1, Math.max(0, x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
  return linear.map(encode) as [number, number, number];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrast(foregroundToken: string, backgroundToken: string): number {
  const read = (name: string) => {
    const value = tokens.get(name);
    if (!value) throw new Error(`Missing token --${name}`);
    return relativeLuminance(oklchToSrgb(value));
  };
  const [x, y] = [read(foregroundToken), read(backgroundToken)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const statuses = ["active", "pending", "returned", "success", "warning", "error"];

describe("design tokens", () => {
  it.each(statuses)("defines every %s status token and exposes it to Tailwind", (status) => {
    for (const suffix of ["", "-soft", "-border", "-solid"]) {
      expect(tokens.has(`status-${status}${suffix}`)).toBe(true);
      expect(css).toContain(`--color-status-${status}${suffix}: var(--status-${status}${suffix});`);
    }
  });

  it.each(statuses)("%s status text is readable on its soft background and on cards", (status) => {
    expect(contrast(`status-${status}`, `status-${status}-soft`)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(`status-${status}`, "card")).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    ["foreground", "background"],
    ["foreground", "card"],
    ["muted-foreground", "background"],
    ["muted-foreground", "card"],
    ["muted-foreground", "muted"],
    ["primary-foreground", "primary"],
    ["secondary-foreground", "secondary"],
    ["accent-foreground", "accent"],
    ["destructive-foreground", "destructive"],
    ["primary", "background"],
  ])("%s on %s meets WCAG AA", (foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });
});
