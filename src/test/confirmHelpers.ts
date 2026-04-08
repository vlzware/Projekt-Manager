/**
 * Test helpers for the confirm dialog flow.
 *
 * Component tests that exercise transition buttons used to mock
 * `window.confirm` directly. With the new confirm store + ConfirmDialog
 * component, those tests should override the store's `request` function
 * instead — that way the assertion targets the same call site as the
 * production code.
 *
 * Usage:
 *   const requestSpy = mockConfirmAccept();
 *   await user.click(forwardBtn);
 *   expect(requestSpy).toHaveBeenCalledWith(expect.stringContaining('...'));
 */

import { vi, type Mock } from 'vitest';
import { useConfirmStore } from '@/state/confirmStore';

/**
 * Replace the confirm store's `request` with a mock that resolves true.
 * Returns the mock so tests can assert on its calls.
 */
export function mockConfirmAccept(): Mock {
  const spy = vi.fn().mockResolvedValue(true);
  useConfirmStore.setState({ request: spy as never });
  return spy;
}

/**
 * Replace the confirm store's `request` with a mock that resolves false.
 * Returns the mock so tests can assert on its calls.
 */
export function mockConfirmReject(): Mock {
  const spy = vi.fn().mockResolvedValue(false);
  useConfirmStore.setState({ request: spy as never });
  return spy;
}
