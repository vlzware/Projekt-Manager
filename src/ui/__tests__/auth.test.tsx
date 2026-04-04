import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useProjectStore } from '@/state/store';
import { App } from '@/App';
import { LoginForm } from '@/ui/auth/LoginForm';

// ---------------------------------------------------------------------------
// API mock infrastructure
//
// The spec (verification.md §16.2) requires component tests to run against a
// mocked API. We mock global.fetch because no API client module exists yet
// (TDD red phase). Each test configures the mock for its scenario; afterEach
// restores the original.
// ---------------------------------------------------------------------------

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Reset store to initial state
  useProjectStore.setState({
    ...useProjectStore.getInitialState(),
  });

  // Set up fetch mock — default: reject with a clear message so tests that
  // forget to configure it fail loudly instead of silently succeeding.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
    new Error('fetch not configured for this test'),
  );
});

afterEach(() => {
  fetchSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Configure fetch to return a successful JSON response. */
function mockFetchSuccess(body: unknown, status = 200) {
  fetchSpy.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

/** Configure fetch to return an error JSON response. */
function mockFetchError(body: unknown, status = 401) {
  fetchSpy.mockResolvedValueOnce(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

/** Configure fetch to reject with a network error. */
function mockFetchNetworkError(message = 'Network error') {
  fetchSpy.mockRejectedValueOnce(new Error(message));
}

// ---------------------------------------------------------------------------
// Login Form
// ---------------------------------------------------------------------------

describe('Login Form', () => {
  // CT-18: Login form renders username, password fields, and submit button
  it('CT-18: renders username, password fields, and submit button', () => {
    render(<LoginForm />);

    const usernameInput = screen.getByLabelText(/benutzername/i);
    expect(usernameInput).toBeInTheDocument();
    expect(usernameInput).toHaveAttribute('type', 'text');

    const passwordInput = screen.getByLabelText(/passwort/i);
    expect(passwordInput).toBeInTheDocument();
    expect(passwordInput).toHaveAttribute('type', 'password');

    const submitButton = screen.getByRole('button', { name: /anmelden/i });
    expect(submitButton).toBeInTheDocument();
  });

  // CT-19: Submitting valid credentials calls the login API and navigates to the main view
  it('CT-19: submitting valid credentials calls login API and navigates to main view', async () => {
    const user = userEvent.setup();

    // Mock: login API returns success with token and user profile
    mockFetchSuccess({
      token: 'fake-session-token',
      user: {
        id: 'u1',
        username: 'testuser',
        displayName: 'Max Mustermann',
        roles: ['owner'],
        email: 'max@example.com',
      },
    });

    // Pre-condition: no authenticated user — App should show login screen
    useProjectStore.setState({ authUser: null });
    render(<App />);

    // Login form should be visible, Kanban board should not
    expect(screen.getByRole('button', { name: /anmelden/i })).toBeInTheDocument();
    expect(screen.queryByTestId('kanban-board')).not.toBeInTheDocument();

    // Fill in credentials and submit
    await user.type(screen.getByLabelText(/benutzername/i), 'testuser');
    await user.type(screen.getByLabelText(/passwort/i), 'password123');
    await user.click(screen.getByRole('button', { name: /anmelden/i }));

    // (1) Verify the mock was called with the right URL and payload
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/auth/login',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ username: 'testuser', password: 'password123' }),
        }),
      );
    });

    // (2) After successful login: Kanban board visible, login form gone
    await waitFor(() => {
      expect(screen.getByTestId('kanban-board')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /anmelden/i })).not.toBeInTheDocument();

    // (3) Store should have the authenticated user
    expect(useProjectStore.getState().authUser).toEqual(
      expect.objectContaining({
        username: 'testuser',
        displayName: 'Max Mustermann',
      }),
    );
  });

  // CT-20: Submitting invalid credentials shows an error message without navigating
  it('CT-20: invalid credentials show error message without navigating', async () => {
    const user = userEvent.setup();

    // Mock: login API returns 401 with error
    mockFetchError({
      code: 'INVALID_CREDENTIALS',
      message: 'Anmeldung fehlgeschlagen',
    }, 401);

    useProjectStore.setState({ authUser: null });
    render(<App />);

    // Fill in wrong credentials and submit
    await user.type(screen.getByLabelText(/benutzername/i), 'wronguser');
    await user.type(screen.getByLabelText(/passwort/i), 'wrongpass');
    await user.click(screen.getByRole('button', { name: /anmelden/i }));

    // Verify the API was called
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/auth/login',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ username: 'wronguser', password: 'wrongpass' }),
        }),
      );
    });

    // Error message should appear (spec §8.1.1: "Anmeldung fehlgeschlagen")
    await waitFor(() => {
      expect(screen.getByText('Anmeldung fehlgeschlagen')).toBeInTheDocument();
    });

    // Should still be on the login screen — no navigation
    expect(screen.queryByTestId('kanban-board')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /anmelden/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Header Auth Indicator & Dropdown
// ---------------------------------------------------------------------------

describe('Header Auth Indicator', () => {
  // CT-21: User indicator in header shows display name and dropdown with "Abmelden"
  it('CT-21: header shows authenticated user display name with dropdown containing Abmelden', async () => {
    const user = userEvent.setup();

    useProjectStore.setState({
      authUser: { username: 'testuser', displayName: 'Max Mustermann' },
    });
    render(<App />);

    // Display name should be visible in the header
    const header = document.querySelector('header');
    expect(header).toHaveTextContent('Max Mustermann');

    // Click the user display name to open dropdown
    const userIndicator = screen.getByRole('button', { name: /max mustermann/i });
    await user.click(userIndicator);

    // Dropdown should contain "Abmelden"
    expect(screen.getByRole('button', { name: /abmelden/i })).toBeInTheDocument();
  });

  // CT-22: Clicking "Abmelden" calls the logout API and shows the login screen
  it('CT-22: clicking Abmelden calls logout API and shows login screen', async () => {
    const user = userEvent.setup();

    // Mock: logout API returns success (no body needed)
    mockFetchSuccess({}, 200);

    // Start as authenticated user
    useProjectStore.setState({
      authUser: { username: 'testuser', displayName: 'Max Mustermann' },
    });
    render(<App />);

    // Kanban board should be visible
    expect(screen.getByTestId('kanban-board')).toBeInTheDocument();

    // (1) Click user indicator to open dropdown
    const userIndicator = screen.getByRole('button', { name: /max mustermann/i });
    await user.click(userIndicator);

    // (2) Find and click "Abmelden" inside the dropdown
    const logoutButton = screen.getByRole('button', { name: /abmelden/i });
    await user.click(logoutButton);

    // (3) Verify logout API was called
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/auth/logout',
        expect.objectContaining({
          method: 'POST',
        }),
      );
    });

    // (4) After logout: login screen shown, project data not visible
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /anmelden/i })).toBeInTheDocument();
    });
    expect(screen.queryByTestId('kanban-board')).not.toBeInTheDocument();
    expect(screen.queryByText('Max Mustermann')).not.toBeInTheDocument();

    // Store should be cleared
    expect(useProjectStore.getState().authUser).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mutation Error Handling (Optimistic Revert)
// ---------------------------------------------------------------------------

describe('Mutation Error Handling', () => {
  // CT-23: When a mutation API call fails, the UI shows an error message and reverts local state
  it('CT-23: failed mutation shows error and reverts local state', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    // Mock: transition API returns failure
    mockFetchNetworkError('Server error');

    // Explicitly provide project data — don't rely on mock data from getInitialState()
    // which will be removed when the store switches to API-fetched data.
    useProjectStore.setState({
      authUser: { username: 'testuser', displayName: 'Max Mustermann' },
      projects: [
        {
          id: 'p07',
          number: '2026-007',
          title: 'Test Project',
          status: 'geplant',
          statusChangedAt: '2026-03-15T10:00:00Z',
          customer: { name: 'Test Customer' },
          createdAt: '2026-03-01T10:00:00Z',
          updatedAt: '2026-03-15T10:00:00Z',
        },
      ],
    });
    render(<App />);

    // p07 is in 'geplant' — capture state before transition
    const projectBefore = useProjectStore.getState().projects.find((p) => p.id === 'p07');
    expect(projectBefore?.status).toBe('geplant');

    // Click the forward button — triggers optimistic update then API call
    const forwardBtn = screen.getByTestId('forward-button-p07');
    await user.click(forwardBtn);

    // On API failure: error message shown (spec §9.5)
    await waitFor(() => {
      expect(
        screen.getByText('Änderung fehlgeschlagen. Bitte erneut versuchen.'),
      ).toBeInTheDocument();
    });

    // Local state reverted — project back in original column
    const projectAfter = useProjectStore.getState().projects.find((p) => p.id === 'p07');
    expect(projectAfter?.status).toBe('geplant');

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Double-Submit Prevention (In-Flight Disabled State)
// ---------------------------------------------------------------------------

describe('Double-Submit Prevention', () => {
  // CT-24: While a mutation is in flight, the triggering control is disabled
  it('CT-24: triggering control is disabled while mutation is in flight', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    // Use a deferred promise so we can inspect the button state while the
    // mutation is pending (before the API responds).
    let resolveTransition!: () => void;
    fetchSpy.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolveTransition = () =>
            resolve(
              new Response(
                JSON.stringify({
                  id: 'p07',
                  status: 'in_arbeit',
                }),
                {
                  status: 200,
                  headers: { 'Content-Type': 'application/json' },
                },
              ),
            );
        }),
    );

    // Explicitly provide project data — don't rely on mock data from getInitialState()
    useProjectStore.setState({
      authUser: { username: 'testuser', displayName: 'Max Mustermann' },
      projects: [
        {
          id: 'p07',
          number: '2026-007',
          title: 'Test Project',
          status: 'geplant',
          statusChangedAt: '2026-03-15T10:00:00Z',
          customer: { name: 'Test Customer' },
          createdAt: '2026-03-01T10:00:00Z',
          updatedAt: '2026-03-15T10:00:00Z',
        },
      ],
    });
    render(<App />);

    const forwardBtn = screen.getByTestId('forward-button-p07');

    // Click button — mutation starts, API call is now pending
    await user.click(forwardBtn);

    // Assert button is disabled NOW (mutation in flight)
    expect(forwardBtn).toBeDisabled();

    // Resolve the promise — mutation completes
    await act(async () => {
      resolveTransition();
    });

    // Assert button is re-enabled after mutation completes
    await waitFor(() => {
      expect(forwardBtn).toBeEnabled();
    });

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Session Expiry Mid-Use (AC-27)
// ---------------------------------------------------------------------------

describe('Session Expiry Mid-Use', () => {
  // AC-27: A session that expires while the app is open redirects to login with an expiry message.
  it('AC-27: session expiry during use redirects to login with expiry message', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    // Mock: transition API returns 401 SESSION_EXPIRED
    mockFetchError(
      { code: 'SESSION_EXPIRED', message: 'Sitzung abgelaufen' },
      401,
    );

    // Start as authenticated user with explicit project data
    useProjectStore.setState({
      authUser: { username: 'testuser', displayName: 'Max Mustermann' },
      projects: [
        {
          id: 'p07',
          number: '2026-007',
          title: 'Test Project',
          status: 'geplant',
          statusChangedAt: '2026-03-15T10:00:00Z',
          customer: { name: 'Test Customer' },
          createdAt: '2026-03-01T10:00:00Z',
          updatedAt: '2026-03-15T10:00:00Z',
        },
      ],
    });
    render(<App />);

    // Pre-condition: Kanban board visible, login form not visible
    expect(screen.getByTestId('kanban-board')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /anmelden/i })).not.toBeInTheDocument();

    // Trigger an API call — click forward button to transition a project
    const forwardBtn = screen.getByTestId('forward-button-p07');
    await user.click(forwardBtn);

    // After SESSION_EXPIRED: login screen appears with expiry message
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /anmelden/i })).toBeInTheDocument();
    });
    expect(
      screen.getByText('Sitzung abgelaufen. Bitte erneut anmelden.'),
    ).toBeInTheDocument();

    // Kanban board is no longer visible
    expect(screen.queryByTestId('kanban-board')).not.toBeInTheDocument();

    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Session Restoration on App Load
// ---------------------------------------------------------------------------

describe('Session Restoration on App Load', () => {
  // Spec §9.4 / api.md §14.2.1: On app load, the client checks for an existing
  // valid session (GET /api/auth/me). If valid → load authenticated view.
  it('restores session when GET /api/auth/me returns a valid user', async () => {
    // Mock: GET /api/auth/me returns a valid user profile
    mockFetchSuccess({
      id: 'u1',
      username: 'testuser',
      displayName: 'Max Mustermann',
      roles: ['owner'],
      email: 'max@example.com',
    });

    // Simulate a page refresh: no user but a persisted token
    useProjectStore.setState({ authUser: null, authToken: 'stored-token' });
    render(<App />);

    // App should call GET /api/auth/me
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/auth/me',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    // After the call resolves, Kanban board appears (session restored)
    await waitFor(() => {
      expect(screen.getByTestId('kanban-board')).toBeInTheDocument();
    });

    // Store has authUser set
    expect(useProjectStore.getState().authUser).toEqual(
      expect.objectContaining({
        username: 'testuser',
        displayName: 'Max Mustermann',
      }),
    );
  });

  it('shows login screen when GET /api/auth/me returns 401', async () => {
    // Mock: GET /api/auth/me returns 401 — no valid session
    mockFetchError(
      { code: 'SESSION_EXPIRED', message: 'Sitzung abgelaufen' },
      401,
    );

    // Simulate a page refresh: no user but a persisted token
    useProjectStore.setState({ authUser: null, authToken: 'stored-token' });
    render(<App />);

    // App should call GET /api/auth/me
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        '/api/auth/me',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    // Login screen appears (session not restored)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /anmelden/i })).toBeInTheDocument();
    });

    // Kanban board is not visible
    expect(screen.queryByTestId('kanban-board')).not.toBeInTheDocument();
  });
});
