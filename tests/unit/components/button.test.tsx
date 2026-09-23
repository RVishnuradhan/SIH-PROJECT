// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "@/components/ui/button";

describe("Button", () => {
  it("renders a native button with the primary style by default", () => {
    render(<Button type="button">Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("bg-primary", "text-primary-foreground");
  });

  it("applies the requested variant and size", () => {
    render(
      <Button variant="outline" size="sm">
        Cancel
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Cancel" });
    expect(button).toHaveClass("border-input", "h-9");
    expect(button).not.toHaveClass("bg-primary");
  });

  it("can render a link with button styling (asChild)", () => {
    render(
      <Button asChild>
        <a href="#details">Details</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Details" });
    expect(link).toHaveAttribute("href", "#details");
    expect(link).toHaveClass("bg-primary");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("is disabled when asked", () => {
    render(<Button disabled>Generate Bill</Button>);
    expect(screen.getByRole("button", { name: "Generate Bill" })).toBeDisabled();
  });
});
