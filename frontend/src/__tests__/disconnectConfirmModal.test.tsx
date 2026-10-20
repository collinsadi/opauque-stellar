import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DisconnectConfirmModal } from "../components/DisconnectConfirmModal";

/**
 * The full-wipe button stays disabled while unspent pool notes exist until the
 * loss phrase is typed (#1115). The modal uses ModalShell dialog semantics.
 */

function renderModal(unspentNoteCount: number) {
  const handlers = {
    onDisconnectOnly: vi.fn(),
    onFullWipe: vi.fn(),
    onCancel: vi.fn(),
  };
  render(<DisconnectConfirmModal unspentNoteCount={unspentNoteCount} {...handlers} />);
  return handlers;
}

const wipeButton = () => screen.getByRole("button", { name: "Disconnect & wipe all data" }) as HTMLButtonElement;

describe("DisconnectConfirmModal", () => {
  it("is exposed as a named dialog", () => {
    renderModal(0);

    expect(screen.getByRole("dialog", { name: "Disconnect wallet" })).toBeTruthy();
  });

  it("does not gate the full wipe when there are no unspent notes", () => {
    const handlers = renderModal(0);

    expect(wipeButton().disabled).toBe(false);
    fireEvent.click(wipeButton());
    expect(handlers.onFullWipe).toHaveBeenCalledTimes(1);
  });

  it("keeps the full wipe disabled while unspent notes exist and the phrase is missing", () => {
    const handlers = renderModal(2);

    expect(wipeButton().disabled).toBe(true);
    fireEvent.click(wipeButton());
    expect(handlers.onFullWipe).not.toHaveBeenCalled();
  });

  it("enables the full wipe only after the loss phrase is typed", () => {
    const handlers = renderModal(2);
    const input = screen.getByRole("textbox");

    fireEvent.change(input, { target: { value: "delete" } });
    expect(wipeButton().disabled).toBe(true);

    fireEvent.change(input, { target: { value: "delete my notes" } });
    expect(wipeButton().disabled).toBe(false);
    fireEvent.click(wipeButton());
    expect(handlers.onFullWipe).toHaveBeenCalledTimes(1);
  });

  it("routes Disconnect only and Escape to their handlers", () => {
    const handlers = renderModal(2);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect only" }));
    expect(handlers.onDisconnectOnly).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
  });
});
