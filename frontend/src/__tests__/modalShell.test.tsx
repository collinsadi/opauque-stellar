/**
 * @vitest-environment jsdom
 *
 * ModalShell `busy` prop (#1087): declared, defaults to false, and gates every
 * dismissal path — Escape, backdrop click, and the header close button.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import "@testing-library/jest-dom/vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ModalShell } from "../components/ModalShell";

afterEach(() => cleanup());

function renderShell(props: { open: boolean; busy?: boolean; closeOnBackdrop?: boolean }) {
  const onClose = vi.fn();
  const utils = render(
    <ModalShell title="Confirm" description="Details" onClose={onClose} {...props}>
      <p>body content</p>
    </ModalShell>,
  );
  return { onClose, ...utils };
}

const BUSY_NOTICE = /will remain open while the current transaction finishes/;

describe("ModalShell busy handling (#1087)", () => {
  it("renders nothing when closed, busy or idle", () => {
    for (const busy of [undefined, false, true]) {
      const { container } = renderShell({ open: false, busy });
      expect(container).toBeEmptyDOMElement();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      cleanup();
    }
  });

  it("defaults busy to false: open and idle, every dismissal path closes", () => {
    const { onClose } = renderShell({ open: true });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("body content")).toBeInTheDocument();
    expect(screen.queryByText(BUSY_NOTICE)).not.toBeInTheDocument();

    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toBeEnabled();

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("dialog"));
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("open and busy: Escape, backdrop, and the close button are all ignored", () => {
    const { onClose } = renderShell({ open: true, busy: true });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(BUSY_NOTICE)).toBeInTheDocument();

    const close = screen.getByRole("button", { name: "Close" });
    expect(close).toBeDisabled();

    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(screen.getByRole("dialog"));
    fireEvent.click(close);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("clicks inside the panel never close the modal", () => {
    const { onClose } = renderShell({ open: true });
    fireEvent.click(screen.getByText("body content"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("re-enables dismissal once busy clears", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <ModalShell open busy title="Confirm" onClose={onClose}>
        <p>body</p>
      </ModalShell>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    rerender(
      <ModalShell open busy={false} title="Confirm" onClose={onClose}>
        <p>body</p>
      </ModalShell>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("respects closeOnBackdrop={false} independently of busy", () => {
    const { onClose } = renderShell({ open: true, closeOnBackdrop: false });
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
