/**
 * ConfirmDialog tests — covers rendering on store-open, accept/cancel paths,
 * Escape key, backdrop click, labels, and the a11y guarantees (labelledby,
 * focus restoration, focus trap, body scroll lock).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { ConfirmDialog } from '@/ui/common/ConfirmDialog';
import { useConfirmStore } from '@/state/confirmStore';

beforeEach(() => {
  // Reset the store to its initial state
  useConfirmStore.setState({
    isOpen: false,
    title: 'Bestätigen',
    message: '',
    confirmLabel: 'OK',
    cancelLabel: 'Abbrechen',
    resolver: null,
  });
  document.body.style.overflow = '';
});

afterEach(() => {
  document.body.style.overflow = '';
});

describe('ConfirmDialog', () => {
  it('does not render when the store is closed', () => {
    render(<ConfirmDialog />);
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
  });

  it('renders the message when the store opens', () => {
    render(<ConfirmDialog />);
    act(() => {
      void useConfirmStore.getState().request('Wirklich löschen?');
    });
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
    expect(screen.getByText('Wirklich löschen?')).toBeInTheDocument();
  });

  it('uses the supplied custom labels', () => {
    render(<ConfirmDialog />);
    act(() => {
      void useConfirmStore.getState().request('Test', { confirmLabel: 'Ja', cancelLabel: 'Nein' });
    });
    expect(screen.getByTestId('confirm-ok')).toHaveTextContent('Ja');
    expect(screen.getByTestId('confirm-cancel')).toHaveTextContent('Nein');
  });

  it('resolves the promise with true when the OK button is clicked', async () => {
    render(<ConfirmDialog />);
    let resolved: boolean | undefined;
    act(() => {
      void useConfirmStore
        .getState()
        .request('Sicher?')
        .then((answer) => {
          resolved = answer;
        });
    });

    act(() => {
      fireEvent.click(screen.getByTestId('confirm-ok'));
    });

    // Microtask queue flush
    await Promise.resolve();
    expect(resolved).toBe(true);
    // Dialog closes after resolution
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
  });

  it('resolves the promise with false when the cancel button is clicked', async () => {
    render(<ConfirmDialog />);
    let resolved: boolean | undefined;
    act(() => {
      void useConfirmStore
        .getState()
        .request('Sicher?')
        .then((answer) => {
          resolved = answer;
        });
    });

    act(() => {
      fireEvent.click(screen.getByTestId('confirm-cancel'));
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(screen.queryByTestId('confirm-dialog')).not.toBeInTheDocument();
  });

  it('resolves with false when the backdrop is clicked', async () => {
    render(<ConfirmDialog />);
    let resolved: boolean | undefined;
    act(() => {
      void useConfirmStore
        .getState()
        .request('Sicher?')
        .then((answer) => {
          resolved = answer;
        });
    });

    act(() => {
      fireEvent.click(screen.getByTestId('confirm-overlay'));
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it('does NOT resolve when the inner dialog is clicked (event propagation stops)', () => {
    render(<ConfirmDialog />);
    let resolved: boolean | undefined;
    act(() => {
      void useConfirmStore
        .getState()
        .request('Sicher?')
        .then((answer) => {
          resolved = answer;
        });
    });

    act(() => {
      fireEvent.click(screen.getByTestId('confirm-dialog'));
    });

    expect(resolved).toBeUndefined();
    expect(screen.getByTestId('confirm-dialog')).toBeInTheDocument();
  });

  it('resolves with false when Escape is pressed', async () => {
    render(<ConfirmDialog />);
    let resolved: boolean | undefined;
    act(() => {
      void useConfirmStore
        .getState()
        .request('Sicher?')
        .then((answer) => {
          resolved = answer;
        });
    });

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it('opening a new request while one is already open cancels the previous', async () => {
    render(<ConfirmDialog />);
    let firstResolved: boolean | undefined;
    let secondResolved: boolean | undefined;

    act(() => {
      void useConfirmStore
        .getState()
        .request('First')
        .then((a) => {
          firstResolved = a;
        });
    });

    act(() => {
      void useConfirmStore
        .getState()
        .request('Second')
        .then((a) => {
          secondResolved = a;
        });
    });

    await Promise.resolve();
    expect(firstResolved).toBe(false);
    expect(secondResolved).toBeUndefined();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });
});

describe('ConfirmDialog — accessibility', () => {
  it('renders the default title and exposes it via aria-labelledby', () => {
    render(<ConfirmDialog />);
    act(() => {
      void useConfirmStore.getState().request('Wirklich löschen?');
    });

    const dialog = screen.getByTestId('confirm-dialog');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBe('confirm-dialog-title');

    const titleEl = document.getElementById(labelledBy!);
    expect(titleEl).not.toBeNull();
    expect(titleEl).toHaveTextContent('Bestätigen');
  });

  it('uses a custom title when supplied', () => {
    render(<ConfirmDialog />);
    act(() => {
      void useConfirmStore.getState().request('Wirklich löschen?', { title: 'Projekt löschen' });
    });

    expect(screen.getByText('Projekt löschen')).toBeInTheDocument();
  });

  it('exposes the message via aria-describedby', () => {
    render(<ConfirmDialog />);
    act(() => {
      void useConfirmStore.getState().request('Bist du sicher?');
    });

    const dialog = screen.getByTestId('confirm-dialog');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBe('confirm-dialog-message');
    const msgEl = document.getElementById(describedBy!);
    expect(msgEl).not.toBeNull();
    expect(msgEl).toHaveTextContent('Bist du sicher?');
  });

  it('locks body scroll while open and restores it on close', () => {
    document.body.style.overflow = 'auto';
    render(<ConfirmDialog />);

    act(() => {
      void useConfirmStore.getState().request('?');
    });
    expect(document.body.style.overflow).toBe('hidden');

    act(() => {
      fireEvent.click(screen.getByTestId('confirm-cancel'));
    });
    // Restored to the previous value, not blanked.
    expect(document.body.style.overflow).toBe('auto');
  });

  it('restores focus to the previously focused element on close', () => {
    // Render a trigger button that opens the modal, mirroring the real flow.
    render(
      <>
        <button data-testid="trigger">Open</button>
        <ConfirmDialog />
      </>,
    );

    const trigger = screen.getByTestId('trigger') as HTMLButtonElement;
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    act(() => {
      void useConfirmStore.getState().request('?');
    });

    // Initial focus moves to the confirm button.
    expect(document.activeElement).toBe(screen.getByTestId('confirm-ok'));

    act(() => {
      fireEvent.click(screen.getByTestId('confirm-cancel'));
    });

    // Focus has been restored to the trigger.
    expect(document.activeElement).toBe(trigger);
  });

  it('traps Tab forward inside the dialog', () => {
    render(<ConfirmDialog />);
    act(() => {
      void useConfirmStore.getState().request('?');
    });

    const okBtn = screen.getByTestId('confirm-ok') as HTMLButtonElement;
    const cancelBtn = screen.getByTestId('confirm-cancel') as HTMLButtonElement;

    // Initial focus is on the confirm button (last focusable).
    expect(document.activeElement).toBe(okBtn);

    // Tab from the last focusable wraps to the first.
    act(() => {
      fireEvent.keyDown(window, { key: 'Tab' });
    });
    expect(document.activeElement).toBe(cancelBtn);
  });

  it('traps Shift+Tab backward inside the dialog', () => {
    render(<ConfirmDialog />);
    act(() => {
      void useConfirmStore.getState().request('?');
    });

    const okBtn = screen.getByTestId('confirm-ok') as HTMLButtonElement;
    const cancelBtn = screen.getByTestId('confirm-cancel') as HTMLButtonElement;

    // Move focus to the cancel button (first focusable).
    cancelBtn.focus();
    expect(document.activeElement).toBe(cancelBtn);

    // Shift+Tab from the first focusable wraps to the last.
    act(() => {
      fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    });
    expect(document.activeElement).toBe(okBtn);
  });
});
