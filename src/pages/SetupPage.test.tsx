import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { SetupPage } from './SetupPage';

vi.mock('../utils/simplefin', () => ({
  claimToken: vi.fn(async () => 'https://user:pass@bridge.simplefin.org/simplefin'),
  fetchAccounts: vi.fn(async () => ({ errors: [], accounts: [] })),
}));

const makeProps = () => ({
  ctx: {
    api: {
      secrets: { get: vi.fn(async () => null), set: vi.fn(), delete: vi.fn() },
      accounts: { getAll: vi.fn(async () => []) },
    },
  } as any,
  store: {
    getAccessUrl: vi.fn(async () => null),
    setAccessUrl: vi.fn(async () => {}),
    getAccountMapping: vi.fn(async () => null),
    setAccountMapping: vi.fn(async () => {}),
    getMappingRules: vi.fn(async () => []),
    setMappingRules: vi.fn(async () => {}),
    getSyncScheduleHours: vi.fn(async () => null),
    setSyncScheduleHours: vi.fn(async () => {}),
  } as any,
  onComplete: vi.fn(),
});

describe('SetupPage', () => {
  it('renders Step 1 with token input', () => {
    render(<SetupPage {...makeProps()} />);
    expect(screen.getByText(/step 1/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/setup token/i)).toBeInTheDocument();
  });

  it('calls claimToken and advances to Step 2 on connect', async () => {
    const props = makeProps();
    render(<SetupPage {...props} />);
    fireEvent.change(screen.getByPlaceholderText(/setup token/i), {
      target: { value: 'dGVzdA==' }, // base64 of "test" — mock ignores actual value
    });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    await waitFor(() => expect(screen.getByText(/step 2/i)).toBeInTheDocument());
    expect(props.store.setAccessUrl).toHaveBeenCalled();
  });
});
