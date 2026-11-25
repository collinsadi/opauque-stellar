/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { ViewErrorBoundary } from "../components/ViewErrorBoundary";

afterEach(() => cleanup());

function ThrowingComponent(): React.ReactNode {
  throw new Error("test render failure");
}

function SafeComponent() {
  return <div>safe content</div>;
}

describe("ViewErrorBoundary", () => {
  it("catches a render failure and shows fallback UI", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ViewErrorBoundary>
        <ThrowingComponent />
      </ViewErrorBoundary>,
    );
    expect(screen.getByText("Something went wrong")).toBeDefined();
    expect(screen.getByText("Try again")).toBeDefined();
    consoleSpy.mockRestore();
  });

  it("renders children normally when no error", () => {
    render(
      <ViewErrorBoundary>
        <SafeComponent />
      </ViewErrorBoundary>,
    );
    expect(screen.getByText("safe content")).toBeDefined();
  });

  it("recovers when Try again is clicked", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rerender } = render(
      <ViewErrorBoundary>
        <ThrowingComponent />
      </ViewErrorBoundary>,
    );
    expect(screen.getByText("Something went wrong")).toBeDefined();
    rerender(
      <ViewErrorBoundary>
        <SafeComponent />
      </ViewErrorBoundary>,
    );
    fireEvent.click(screen.getByText("Try again"));
    expect(screen.getByText("safe content")).toBeDefined();
    consoleSpy.mockRestore();
  });
});
