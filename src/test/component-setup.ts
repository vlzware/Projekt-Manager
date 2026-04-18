/**
 * Component-test setup: registers jest-dom matchers and configures
 * Testing Library cleanup after each test.
 */

import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
