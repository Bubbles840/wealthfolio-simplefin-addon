import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { HomeAssistantConnect } from './HomeAssistantConnect';
import type { SecretsStore } from '../utils/secrets';
import type { HaStatus, HomeAssistantConfig } from '../../shared/home-assistant';
import { HOME_ASSISTANT_SINCE } from '../../shared/version';

const SAVED: HomeAssistantConfig = { enabled: true, mode: 'notify', url: 'http://ha.local:8123', token: 'tok', service: 'mobile_app_phone' };
const EMPTY: HomeAssistantConfig = { enabled: true, mode: 'notify', url: '', token: '', service: '' };

function storeWith(config: HomeAssistantConfig, status: HaStatus | null = null, companion: string | null = HOME_ASSISTANT_SINCE) {
  return {
    getHomeAssistantConfig: vi.fn(async () => config),
    setHomeAssistantConfig: vi.fn(async () => {}),
    getHomeAssistantStatus: vi.fn(async () => status),
    queueHomeAssistantTest: vi.fn(async () => {}),
    getCompanionVersion: vi.fn(async () => companion),
  };
}
const renderCard = (store: ReturnType<typeof storeWith>) =>
  render(<HomeAssistantConnect store={store as unknown as SecretsStore} isOpen={() => true} toggleCard={vi.fn()} />);

describe('HomeAssistantConnect', () => {
  it('saves a complete config, and only then offers a test', async () => {
    const store = storeWith(EMPTY);
    renderCard(store);
    const save = await screen.findByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Home Assistant URL'), { target: { value: SAVED.url } });
    fireEvent.change(screen.getByLabelText('Notify service'), { target: { value: SAVED.service } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Long-lived access token'), { target: { value: SAVED.token } });
    expect(screen.getByRole('button', { name: 'Send a test' })).toBeDisabled();
    fireEvent.click(save);
    await waitFor(() => expect(store.setHomeAssistantConfig).toHaveBeenCalledWith(SAVED));
    fireEvent.click(await screen.findByRole('button', { name: 'Send a test' }));
    await waitFor(() => expect(store.queueHomeAssistantTest).toHaveBeenCalled());
    expect(await screen.findByRole('status')).toHaveTextContent(/within 5 minutes/);
  });

  it('takes only a webhook URL in webhook mode', async () => {
    const store = storeWith(EMPTY);
    renderCard(store);
    fireEvent.change(await screen.findByLabelText('Send through'), { target: { value: 'webhook' } });
    expect(screen.queryByLabelText('Long-lived access token')).toBeNull();
    expect(screen.queryByLabelText('Notify service')).toBeNull();
    const url = 'http://ha.local:8123/api/webhook/abc123';
    fireEvent.change(screen.getByLabelText('Webhook URL'), { target: { value: url } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(store.setHomeAssistantConfig).toHaveBeenCalledWith({ ...EMPTY, mode: 'webhook', url }));
    expect(await screen.findByRole('button', { name: 'Send a test' })).toBeEnabled();
  });

  it('shows the companion\'s last failure until a later delivery', async () => {
    renderCard(storeWith(SAVED, {
      lastOkAt: '2027-03-14T10:00:00.000Z',
      lastError: 'Home Assistant answered 401 (check the access token)', lastErrorAt: '2027-03-15T10:00:00.000Z',
    }));
    expect(await screen.findByText(/Last delivery failed .*check the access token/)).toBeInTheDocument();
    expect(screen.getByText('Delivery failing')).toBeInTheDocument();
  });

  it('asks for a newer companion instead of fields it would never read', async () => {
    renderCard(storeWith(EMPTY, null, '1.72.0'));
    expect(await screen.findByText(/Needs the companion container 1.73.0 or newer/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Home Assistant URL')).toBeNull();
  });
});
