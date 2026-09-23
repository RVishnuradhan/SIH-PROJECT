// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import FoundationPage from "@/app/page";

describe("Phase 1 foundation page", () => {
  it("shows the brand as the page heading", () => {
    render(<FoundationPage />);
    expect(screen.getByRole("heading", { level: 1, name: "SMS ASSOCIATES" })).toBeInTheDocument();
    expect(screen.getAllByText("Centering Materials Suppliers").length).toBeGreaterThan(0);
  });

  it("shows all six PRD status states, each with a text label", () => {
    render(<FoundationPage />);
    const states = screen.getByRole("heading", { name: "Status colours" }).closest("section");
    expect(states).not.toBeNull();
    for (const label of ["Active", "Pending", "Returned", "Success", "Warning", "Error"]) {
      expect(within(states!).getByText(label)).toBeInTheDocument();
    }
  });

  it("marks Tamil text with its language", () => {
    render(<FoundationPage />);
    expect(screen.getByText("முட்டு மரம் · பலகை")).toHaveAttribute("lang", "ta");
  });
});
