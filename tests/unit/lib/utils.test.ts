import { describe, expect, it } from "vitest";

import { cn } from "@/lib/utils";

describe("cn", () => {
  it("joins class names and skips falsy values", () => {
    const hidden = false;
    expect(cn("px-4", hidden && "hidden", undefined, "py-2")).toBe("px-4 py-2");
  });

  it("lets the last conflicting Tailwind utility win", () => {
    expect(cn("bg-primary px-2", "bg-status-active-soft px-4")).toBe("bg-status-active-soft px-4");
  });

  it("keeps a font size and a status text colour side by side", () => {
    expect(cn("text-sm", "text-status-error")).toBe("text-sm text-status-error");
  });
});
