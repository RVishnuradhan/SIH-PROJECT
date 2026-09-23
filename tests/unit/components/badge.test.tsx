// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge } from "@/components/ui/badge";

const statusVariants = ["active", "pending", "returned", "success", "warning", "error"] as const;

describe("Badge", () => {
  it.each(statusVariants)("uses the %s status colours", (variant) => {
    render(<Badge variant={variant}>{variant}</Badge>);
    expect(screen.getByText(variant)).toHaveClass(
      `bg-status-${variant}-soft`,
      `text-status-${variant}`,
      `border-status-${variant}-border`,
    );
  });

  it("merges extra classes", () => {
    render(
      <Badge variant="outline" className="bg-card">
        Draft
      </Badge>,
    );
    expect(screen.getByText("Draft")).toHaveClass("bg-card", "border-border");
  });
});
