/**
 * ConfirmDialog tests — covers rendering on store-open, accept/cancel paths,
 * Escape key, backdrop click, and labels.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { ConfirmDialog } from '@/ui/common/ConfirmDialog';
import { useConfirmStore } from '@/state/confirmStore';

beforeEach(() => {
  // Reset the store to its initial state
  useConfirmStore.setState({
    isOpen: false,
    message: '',
    confirmLabel: 'OK',
    cancelLabel: 'Abbrechen',
    resolver: null,
  });
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
